import type { PlannedCommit } from "../grouping-types.js";

import {
  markCommitMessageBreaking,
  suppressCommitMessageBreaking,
  validateCommitMessage,
} from "../../../commit-messages/formatting.js";
import { inferSplitSupportScopeFromPath } from "../ownership.js";
import {
  countSharedSubjectWords,
  isSupportLikeType,
  parseSubjectWords,
  scopesRelated,
} from "../subject/analysis.js";
import {
  getGroupOwnerIds,
  getSingleCoveredImplementationSubjectLine,
  hasBreakingMetadata,
  replaceSubjectLine,
} from "./harmonization-transforms.js";
import { mergeCommitMessages, prioritizeMergedCommits } from "./merge.js";
import { maybePromotePrimaryCoveredSubject } from "./primary-subject.js";

const BREAKING_CHANGE_FOOTER_PATTERN = /^BREAKING[ -]CHANGE:\s+\S/i;

export interface MessageHarmonizationResult {
  diagnostics: Record<string, boolean | number | string>;
  outputGroup: PlannedCommit;
  reason: string;
  resolution: "preserve-message" | "rewrite-message" | "rewrite-subject-only";
}

export function buildCoveredHarmonizationResult(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  messageScopedToCoverage: string,
  suppressBreaking: boolean,
): MessageHarmonizationResult {
  if (suppressBreaking) {
    return buildSuppressedCoveredHarmonizationResult(
      group,
      coveredGroups,
      messageScopedToCoverage,
    );
  }

  const scopedMessageChanged = messageScopedToCoverage !== group.message;
  const restoredMessage = maybePromotePrimaryCoveredSubject(
    messageScopedToCoverage,
    coveredGroups,
  );
  const restoredGroup = restoreCoveredBreakingMetadata(
    { ...group, message: restoredMessage },
    coveredGroups,
  );
  const outputGroup = {
    ...restoredGroup,
    message: dedupeMessageDetailBullets(restoredGroup.message),
  };
  const usedPrimarySubjectPromotion =
    restoredMessage !== messageScopedToCoverage;
  const restoredBreakingMetadata = restoredGroup.message !== restoredMessage;
  const dedupedBullets = outputGroup.message !== restoredGroup.message;

  return {
    diagnostics: {
      coveredGroupCount: coveredGroups.length,
      dedupedBullets,
      restoredBreakingMetadata,
      scopedMessageChanged,
      suppressBreaking,
      usedPrimarySubjectPromotion,
    },
    outputGroup,
    reason: getCoveredHarmonizationReason(
      scopedMessageChanged,
      usedPrimarySubjectPromotion,
      restoredBreakingMetadata,
      dedupedBullets,
    ),
    resolution:
      outputGroup.message === group.message
        ? "preserve-message"
        : "rewrite-message",
  };
}

export function buildRescopedCoveredGroupResult(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): MessageHarmonizationResult {
  const coveredMessage =
    coveredGroups.length === 1
      ? coveredGroups[0].message
      : mergeCommitMessages(coveredGroups);
  const scopedSubjectLine = group.message.split("\n")[0] ?? "";
  const ownerAlignedSubjectLine =
    getOwnerAlignedCoveredSubjectLine(group, coveredGroups) ??
    scopedSubjectLine;
  const shouldDropBody = shouldDropCoveredUmbrellaBody(group, coveredGroups);
  if (shouldDropBody) {
    const outputGroup = {
      ...group,
      message: ownerAlignedSubjectLine,
    };

    return {
      diagnostics: {
        coveredGroupCount: coveredGroups.length,
        shouldDropCoveredUmbrellaBody: true,
        usedOwnerAlignedCoveredSubject:
          ownerAlignedSubjectLine !== scopedSubjectLine,
      },
      outputGroup,
      reason:
        ownerAlignedSubjectLine !== scopedSubjectLine
          ? "owner-aligned-covered-subject"
          : "drop-covered-umbrella-body",
      resolution: "rewrite-subject-only",
    };
  }

  const outputGroup = {
    ...group,
    message: dedupeMessageDetailBullets(
      replaceSubjectLine(coveredMessage, ownerAlignedSubjectLine),
    ),
  };

  return {
    diagnostics: {
      coveredGroupCount: coveredGroups.length,
      mergedCoveredMessage: coveredGroups.length > 1,
      shouldDropCoveredUmbrellaBody: false,
      usedOwnerAlignedCoveredSubject:
        ownerAlignedSubjectLine !== scopedSubjectLine,
    },
    outputGroup,
    reason:
      ownerAlignedSubjectLine !== scopedSubjectLine
        ? "owner-aligned-covered-subject"
        : "replace-covered-message",
    resolution:
      outputGroup.message === group.message
        ? "preserve-message"
        : "rewrite-message",
  };
}

export function dedupeMessageDetailBullets(message: string): string {
  const [subject, ...bodyLines] = message.split("\n");
  if (bodyLines.length === 0) {
    return message;
  }

  const seenBullets = new Set<string>();
  const dedupedBody: string[] = [];
  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      dedupedBody.push(line);
      continue;
    }

    const signature = trimmed.toLowerCase();
    if (seenBullets.has(signature)) {
      continue;
    }

    seenBullets.add(signature);
    dedupedBody.push(line);
  }

  return [subject, ...dedupedBody].join("\n");
}

export function getNarrowedCoverageReplacementSubject(
  coveredGroups: PlannedCommit[],
  subjectType: string,
): null | string {
  if (subjectType !== "style" && subjectType !== "test") {
    return null;
  }

  return getSingleCoveredImplementationSubjectLine(coveredGroups);
}

export function getOwnerAlignedCoveredSubjectLine(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): null | string {
  const groupSubjectLine = group.message.split("\n")[0] ?? "";
  const groupSubject = parseSubjectWords(groupSubjectLine);
  if (groupSubject.type.length === 0 || isSupportLikeType(groupSubject.type)) {
    return null;
  }

  const groupOwnerIds = getGroupOwnerIds(group);
  const scoredCandidates = coveredGroups
    .map((coveredGroup) => {
      const coveredSubjectLine = coveredGroup.message.split("\n")[0] ?? "";
      const coveredSubject = parseSubjectWords(coveredSubjectLine);
      if (
        coveredSubject.type.length === 0 ||
        isSupportLikeType(coveredSubject.type)
      ) {
        return null;
      }

      const coveredOwnerIds = getGroupOwnerIds(coveredGroup);
      const overlapCount = [...coveredOwnerIds].filter((ownerId) =>
        groupOwnerIds.has(ownerId),
      ).length;
      if (overlapCount === 0) {
        return null;
      }

      return {
        coveredGroup,
        extraOwnerCount: coveredOwnerIds.size - overlapCount,
        overlapCount,
      };
    })
    .filter(
      (
        candidate,
      ): candidate is {
        coveredGroup: PlannedCommit;
        extraOwnerCount: number;
        overlapCount: number;
      } => candidate !== null,
    );

  if (scoredCandidates.length === 0) {
    return null;
  }

  const exactOwnerCandidates = scoredCandidates.filter(
    (candidate) => candidate.extraOwnerCount === 0,
  );
  const candidatePool =
    exactOwnerCandidates.length > 0
      ? exactOwnerCandidates
      : scoredCandidates.filter(
          (candidate) =>
            candidate.overlapCount ===
            Math.max(
              ...scoredCandidates.map(({ overlapCount }) => overlapCount),
            ),
        );
  const strongestCandidate = prioritizeMergedCommits(
    candidatePool.map((candidate) => candidate.coveredGroup),
  )[0];
  const strongestSubjectLine = strongestCandidate.message.split("\n")[0] ?? "";

  if (
    coveredGroups.length === 1 &&
    !hasOwnerAlignedSubjectMismatch(groupSubjectLine, strongestSubjectLine)
  ) {
    return null;
  }

  return strongestSubjectLine || null;
}

export function shouldDropCoveredUmbrellaBody(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): boolean {
  if (coveredGroups.length === 0) {
    return false;
  }

  const groupOwnerIds = getGroupOwnerIds(group);
  const coveredOwnerIds = new Set<string>();
  for (const coveredGroup of coveredGroups) {
    for (const ownerId of getGroupOwnerIds(coveredGroup)) {
      coveredOwnerIds.add(ownerId);
    }
  }

  return (
    coveredOwnerIds.size > groupOwnerIds.size ||
    hasBroaderSupportScopeCoverage(coveredGroups, group)
  );
}

function buildSuppressedCoveredHarmonizationResult(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  messageScopedToCoverage: string,
): MessageHarmonizationResult {
  const outputGroup = {
    ...group,
    message: dedupeMessageDetailBullets(
      suppressCommitMessageBreaking(messageScopedToCoverage),
    ),
  };

  return {
    diagnostics: {
      coveredGroupCount: coveredGroups.length,
      scopedMessageChanged: messageScopedToCoverage !== group.message,
      suppressBreaking: true,
      suppressedBreaking:
        outputGroup.message !==
        dedupeMessageDetailBullets(messageScopedToCoverage),
    },
    outputGroup,
    reason:
      messageScopedToCoverage !== group.message
        ? "scoped-covered-message"
        : "suppress-breaking",
    resolution:
      outputGroup.message === group.message
        ? "preserve-message"
        : "rewrite-message",
  };
}

function getCoveredHarmonizationReason(
  scopedMessageChanged: boolean,
  usedPrimarySubjectPromotion: boolean,
  restoredBreakingMetadata: boolean,
  dedupedBullets: boolean,
): string {
  if (usedPrimarySubjectPromotion) {
    return "promote-covered-subject";
  }
  if (restoredBreakingMetadata) {
    return "restore-breaking-metadata";
  }
  if (scopedMessageChanged) {
    return "scoped-covered-message";
  }
  if (dedupedBullets) {
    return "dedupe-covered-bullets";
  }

  return "preserve-covered-message";
}

function hasBroaderSupportScopeCoverage(
  coveredGroups: PlannedCommit[],
  group: PlannedCommit,
): boolean {
  const groupSubject = parseSubjectWords(group.message.split("\n")[0] ?? "");
  if (groupSubject.type !== "style" && groupSubject.type !== "test") {
    return false;
  }

  const coveredSupportScopes = new Set(
    coveredGroups.flatMap((coveredGroup) =>
      coveredGroup.files.map((file) =>
        inferSplitSupportScopeFromPath(file.path),
      ),
    ),
  );
  const groupSupportScopes = new Set(
    group.files.map((file) => inferSplitSupportScopeFromPath(file.path)),
  );

  return coveredSupportScopes.size > groupSupportScopes.size;
}

function hasOwnerAlignedSubjectMismatch(
  currentSubjectLine: string,
  coveredSubjectLine: string,
): boolean {
  const currentSubject = parseSubjectWords(currentSubjectLine);
  const coveredSubject = parseSubjectWords(coveredSubjectLine);
  if (
    coveredSubject.type.length === 0 ||
    isSupportLikeType(coveredSubject.type)
  ) {
    return false;
  }

  const subjectWordOverlap = countSharedSubjectWords(
    currentSubject.words,
    coveredSubject.words,
  );
  if (subjectWordOverlap === 0) {
    return true;
  }
  if (subjectWordOverlap >= 2) {
    return false;
  }

  return !(
    currentSubject.scope.length === 0 ||
    coveredSubject.scope.length === 0 ||
    scopesRelated(currentSubject.scope, coveredSubject.scope)
  );
}

function restoreCoveredBreakingMetadata(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): PlannedCommit {
  const breakingSources = coveredGroups.filter((covered) =>
    hasBreakingMetadata(covered.message),
  );
  if (breakingSources.length === 0 || hasBreakingMetadata(group.message)) {
    return group;
  }

  const footerLines = breakingSources.flatMap((source) => {
    const lines = source.message.split("\n");
    const footerIndex = lines.findIndex((line) =>
      BREAKING_CHANGE_FOOTER_PATTERN.test(line),
    );
    if (footerIndex === -1) {
      return [];
    }

    return lines.slice(footerIndex).filter((line) => line.trim().length > 0);
  });
  const uniqueFooterLines = [
    ...new Set(footerLines.map((line) => line.trim())),
  ];
  const markedMessage = markCommitMessageBreaking(group.message);
  let restoredMessage = markedMessage;

  if (uniqueFooterLines.length > 0) {
    const lines = markedMessage.split("\n");
    const existingFooterIndex = lines.findIndex((line) =>
      BREAKING_CHANGE_FOOTER_PATTERN.test(line),
    );
    const bodyLines =
      existingFooterIndex === -1
        ? lines
        : lines.slice(0, existingFooterIndex - 1);
    restoredMessage = [...bodyLines, "", ...uniqueFooterLines].join("\n");
  }

  return { ...group, message: validateCommitMessage(restoredMessage) };
}
