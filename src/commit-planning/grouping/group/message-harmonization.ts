import type { FileDiff, PlannedCommit } from "../grouping-types.js";

import { suppressCommitMessageBreaking } from "../../../commit-messages/formatting.js";
import { resolveBreakingChangeMode } from "../../prompts/index.js";
import { groupCoversGroup } from "../commit-coverage.js";
import { parseSubjectWords } from "../subject/analysis.js";
import {
  buildCoveredHarmonizationResult,
  buildRescopedCoveredGroupResult,
  dedupeMessageDetailBullets,
  getNarrowedCoverageReplacementSubject,
  getOwnerAlignedCoveredSubjectLine,
  type MessageHarmonizationResult,
  shouldDropCoveredUmbrellaBody,
} from "./covered-message-resolution.js";
import { emitMessageHarmonizationEvent } from "./events.js";
import { replaceSubjectLine } from "./harmonization-transforms.js";
import { mergeCommitMessages } from "./merge.js";
import { rewriteUncoveredSplitMessage } from "./uncovered-split-message.js";
import {
  messageMentionsUncoveredGroupVocabulary,
  messageOmitsCoveredGroupVocabulary,
} from "./vocabulary.js";

type CommitMessageRuleOptions =
  import("../../prompts/index.js").CommitMessageRuleOptions;

export function countMessageDetailBullets(message: string): number {
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ")).length;
}

export function harmonizeConsolidatedMessages(
  originalGroups: PlannedCommit[],
  consolidatedGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  options: CommitMessageRuleOptions = {},
): PlannedCommit[] {
  const suppressBreaking = resolveBreakingChangeMode(options) === "disabled";
  return consolidatedGroups.map((group) => {
    const coveredGroups = originalGroups.filter((original) =>
      groupCoversGroup(group, original, fileByPath),
    );
    const evaluation =
      coveredGroups.length === 0
        ? harmonizeUncoveredGroupMessage(group, suppressBreaking)
        : harmonizeCoveredGroupMessage(
            group,
            coveredGroups,
            originalGroups,
            suppressBreaking,
          );

    emitMessageHarmonizationEvent({
      diagnostics: evaluation.diagnostics,
      inputGroup: group,
      operation:
        coveredGroups.length === 0
          ? "harmonize-uncovered"
          : "harmonize-covered",
      outputGroup: evaluation.outputGroup,
      reason: evaluation.reason,
      resolution: evaluation.resolution,
    });

    return evaluation.outputGroup;
  });
}

/**
 * Rebuilds a split group's body from the source groups it actually covers while
 * preserving the split-specific subject line unless owner-aligned repair is needed.
 */
export function rescopeGroupMessageToCoveredGroups(
  group: PlannedCommit,
  sourceGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit {
  const coveredGroups = sourceGroups.filter((sourceGroup) =>
    groupCoversGroup(group, sourceGroup, fileByPath),
  );
  if (coveredGroups.length === 0) {
    const outputGroup = rewriteUncoveredSplitMessage(group);
    emitMessageHarmonizationEvent({
      diagnostics: {
        coveredGroupCount: 0,
        shouldDropCoveredUmbrellaBody: false,
        usedOwnerAlignedCoveredSubject: false,
      },
      inputGroup: group,
      operation: "rescope-covered",
      outputGroup,
      reason: "no-covered-groups",
      resolution:
        outputGroup.message === group.message
          ? "preserve-message"
          : "rewrite-message",
    });
    return outputGroup;
  }

  const evaluation = buildRescopedCoveredGroupResult(group, coveredGroups);

  emitMessageHarmonizationEvent({
    diagnostics: evaluation.diagnostics,
    inputGroup: group,
    operation: "rescope-covered",
    outputGroup: evaluation.outputGroup,
    reason: evaluation.reason,
    resolution: evaluation.resolution,
  });

  return evaluation.outputGroup;
}

function harmonizeCoveredGroupMessage(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  originalGroups: PlannedCommit[],
  suppressBreaking: boolean,
): MessageHarmonizationResult {
  return buildCoveredHarmonizationResult(
    group,
    coveredGroups,
    scopeMessageToCoveredGroups(group, coveredGroups, originalGroups),
    suppressBreaking,
  );
}

function harmonizeUncoveredGroupMessage(
  group: PlannedCommit,
  suppressBreaking: boolean,
): MessageHarmonizationResult {
  const rewrittenGroup = rewriteUncoveredSplitMessage(group);
  const cleaned = suppressBreaking
    ? {
        ...rewrittenGroup,
        message: suppressCommitMessageBreaking(rewrittenGroup.message),
      }
    : rewrittenGroup;

  const outputGroup = {
    ...cleaned,
    message: dedupeMessageDetailBullets(cleaned.message),
  };

  return {
    diagnostics: {
      dedupedBullets: outputGroup.message !== cleaned.message,
      rewroteUncoveredMessage: rewrittenGroup.message !== group.message,
      suppressBreaking,
      suppressedBreaking:
        suppressBreaking && cleaned.message !== rewrittenGroup.message,
    },
    outputGroup,
    reason:
      rewrittenGroup.message !== group.message
        ? "rewrite-uncovered-group"
        : "preserve-uncovered-group",
    resolution:
      outputGroup.message === group.message
        ? "preserve-message"
        : "rewrite-message",
  };
}

function resolveNarrowedCoverageMessage(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  originalGroups: PlannedCommit[],
): string {
  const scopedSubjectLine = group.message.split("\n")[0] ?? group.message;
  const subject = parseSubjectWords(scopedSubjectLine);
  if (
    !shouldRebuildNarrowedCoverageMessage(
      group,
      subject.type,
      coveredGroups,
      originalGroups,
    )
  ) {
    return group.message;
  }

  const coveredMessage =
    coveredGroups.length === 1
      ? coveredGroups[0].message
      : mergeCommitMessages(coveredGroups);

  if (coveredGroups.length === 1) {
    return coveredMessage;
  }

  const implementationSubject = getNarrowedCoverageReplacementSubject(
    coveredGroups,
    subject.type,
  );
  if (implementationSubject) {
    return replaceSubjectLine(coveredMessage, implementationSubject);
  }

  const ownerAlignedSubject = getOwnerAlignedCoveredSubjectLine(
    group,
    coveredGroups,
  );
  if (ownerAlignedSubject) {
    return replaceSubjectLine(coveredMessage, ownerAlignedSubject);
  }

  return replaceSubjectLine(coveredMessage, scopedSubjectLine);
}

function scopeMessageToCoveredGroups(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  originalGroups: PlannedCommit[],
): string {
  if (shouldDropCoveredUmbrellaBody(group, coveredGroups)) {
    return group.message.split("\n")[0] ?? group.message;
  }

  const coveredCount = coveredGroups.length;
  if (coveredCount === 0) {
    return group.message;
  }

  if (coveredCount < originalGroups.length) {
    return resolveNarrowedCoverageMessage(group, coveredGroups, originalGroups);
  }

  if (
    messageMentionsUncoveredGroupVocabulary(
      group.message,
      coveredGroups,
      originalGroups,
    ) ||
    messageOmitsCoveredGroupVocabulary(group.message, coveredGroups)
  ) {
    return mergeCommitMessages(coveredGroups);
  }

  return group.message;
}

function shouldRebuildNarrowedCoverageMessage(
  group: PlannedCommit,
  subjectType: string,
  coveredGroups: PlannedCommit[],
  originalGroups: PlannedCommit[],
): boolean {
  return (
    ((subjectType === "style" || subjectType === "test") &&
      coveredGroups.length > 1) ||
    messageMentionsUncoveredGroupVocabulary(
      group.message,
      coveredGroups,
      originalGroups,
    )
  );
}
