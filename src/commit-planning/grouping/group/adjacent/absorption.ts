import type { FileDiff, PlannedCommit } from "../../grouping-types.js";

import { getMeaningfulPathWords } from "../../../path/index.js";
import { groupsSharePaths } from "../../commit-coverage.js";
import {
  getPathOwnerDescriptor,
  inferSupportScopeFromPath,
} from "../../ownership.js";
import {
  isSupportLikeType,
  parseSubjectWords,
} from "../../subject/analysis.js";
import { emitAdjacentAbsorptionEvent } from "../events.js";
import {
  mergeCommitMessagesWithPrimarySubject,
  mergeCommitsIntoGroup,
} from "../merge.js";
import { countMessageDetailBullets } from "../message-harmonization.js";
import { hasSharedOwner } from "../ownership-boundaries.js";
import {
  blocksCrossAreaStyleAbsorption,
  blocksThinSupportFollowUp,
  isAbsorbableAdjacentFollowUp,
  isScopedSupportFollowUp,
  shouldPreservePreviousSupportPairMessage,
  shouldPreservePrimaryTestSupportMessage,
} from "./follow-up-rules.js";
import { shouldAbsorbAdjacentSupportPair } from "./support-merge/eligibility.js";
import {
  getAdjacentGroupSharedSurface,
  isSingleSurfaceGroup,
} from "./surface-signals.js";

export function absorbIncidentalAdjacentGroups(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const absorbed: PlannedCommit[] = [];

  for (const group of groups) {
    const previous = absorbed.at(-1);
    const mergedGroup =
      previous === undefined
        ? null
        : mergeAdjacentGroup(previous, group, fileByPath);
    if (mergedGroup !== null) {
      absorbed[absorbed.length - 1] = mergedGroup;
      continue;
    }

    absorbed.push(group);
  }

  return absorbed;
}

export function hasMostlyImplementationTail(groups: PlannedCommit[]): boolean {
  let supportLikeGroupCount = 0;

  for (const group of groups) {
    const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
    if (isSupportLikeType(subject.type)) {
      supportLikeGroupCount++;
    }
  }

  return supportLikeGroupCount <= 1;
}

function buildMergedAdjacentGroup(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  mergedGroup: PlannedCommit,
  primaryMessage: string,
  preservePrimaryMessageOnly: boolean,
): PlannedCommit {
  return {
    ...mergedGroup,
    message: preservePrimaryMessageOnly
      ? primaryMessage
      : mergeCommitMessagesWithPrimarySubject(primaryMessage, [
          previous,
          candidate,
        ]),
  };
}

function emitAdjacentAbsorptionTrace(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  finalizedGroup: PlannedCommit,
  subjectContext: {
    candidateSubject: ReturnType<typeof parseSubjectWords>;
    previousSubject: ReturnType<typeof parseSubjectWords>;
  },
  shouldAbsorbSupportPair: boolean,
  preservePrimaryMessageOnly: boolean,
): void {
  emitAdjacentAbsorptionEvent({
    candidateGroup: candidate,
    diagnostics: {
      candidateFileCount: candidate.files.length,
      candidateSubjectType: subjectContext.candidateSubject.type,
      mergedFileCount: finalizedGroup.files.length,
      preservePrimaryMessageOnly,
      previousFileCount: previous.files.length,
      previousSubjectType: subjectContext.previousSubject.type,
      sharedPaths: groupsSharePaths(previous, candidate),
      shouldAbsorbSupportPair,
    },
    mergedGroup: finalizedGroup,
    previousGroup: previous,
    reason: shouldAbsorbSupportPair ? "support-pair" : "adjacent-follow-up",
  });
}

function getAbsorbableAdjacentCandidateContext(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): null | {
  candidateSubject: ReturnType<typeof parseSubjectWords>;
  previousSubject: ReturnType<typeof parseSubjectWords>;
  sharedSurface: ReturnType<typeof getAdjacentGroupSharedSurface>;
} {
  if (!isSingleSurfaceGroup(candidate)) {
    return null;
  }

  const previousSubject = parseSubjectWords(
    previous.message.split("\n")[0] ?? "",
  );
  if (isSupportLikeType(previousSubject.type)) {
    return null;
  }

  const candidateSubject = parseSubjectWords(
    candidate.message.split("\n")[0] ?? "",
  );
  if (
    blocksThinSupportFollowUp(
      previous,
      candidate,
      previousSubject,
      candidateSubject,
    ) ||
    blocksCrossAreaStyleAbsorption(previous, candidate, candidateSubject)
  ) {
    return null;
  }

  const sharedSurface = hasAdjacentAbsorptionBoundary(
    previous,
    candidate,
    previousSubject,
    candidateSubject,
  );
  if (sharedSurface === null) {
    return null;
  }

  return { candidateSubject, previousSubject, sharedSurface };
}

function getAdjacentSubjectContext(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): {
  candidateSubject: ReturnType<typeof parseSubjectWords>;
  previousSubject: ReturnType<typeof parseSubjectWords>;
} {
  return {
    candidateSubject: parseSubjectWords(candidate.message.split("\n")[0] ?? ""),
    previousSubject: parseSubjectWords(previous.message.split("\n")[0] ?? ""),
  };
}

function getPreferredSupportPairPrimaryMessage(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): string {
  const previousSubject = parseSubjectWords(
    previous.message.split("\n")[0] ?? "",
  );
  const candidateSubject = parseSubjectWords(
    candidate.message.split("\n")[0] ?? "",
  );
  const sharedSurface = getAdjacentGroupSharedSurface(
    previous,
    candidate,
    previousSubject,
    candidateSubject,
  );

  if (
    shouldPreservePreviousSupportPairMessage(
      previous,
      candidate,
      previousSubject,
      candidateSubject,
      sharedSurface,
    )
  ) {
    return previous.message;
  }

  return isBroaderAdjacentGroup(candidate, previous)
    ? candidate.message
    : previous.message;
}

function hasAdjacentAbsorptionBoundary(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
): null | ReturnType<typeof getAdjacentGroupSharedSurface> {
  const sharedSurface = getAdjacentGroupSharedSurface(
    previous,
    candidate,
    previousSubject,
    candidateSubject,
  );

  if (
    !sharedSurface.hasAnyMatch ||
    !hasSharedOwnerAffinity(
      previous,
      candidate,
      previousSubject,
      candidateSubject,
    )
  ) {
    return null;
  }

  return sharedSurface;
}

function hasSharedOwnerAffinity(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  return (
    hasSharedOwner(previous, candidate) ||
    hasSupportScopeAlignedOwnerAffinity(
      previous,
      candidate,
      previousSubject,
      candidateSubject,
    )
  );
}

function hasSupportScopeAlignedOwnerAffinity(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  const previousIsSupport = isSupportLikeType(previousSubject.type);
  const candidateIsSupport = isSupportLikeType(candidateSubject.type);
  if (previousIsSupport === candidateIsSupport) {
    return false;
  }

  const implementationGroup = previousIsSupport ? candidate : previous;
  const supportGroup = previousIsSupport ? previous : candidate;
  const implementationWords = new Set(
    implementationGroup.files.flatMap((file) => {
      const owner = getPathOwnerDescriptor(file.path);
      return [
        ...getMeaningfulPathWords(owner.featureRoot),
        ...getMeaningfulPathWords(owner.ownerId),
      ];
    }),
  );

  return supportGroup.files.some((file) =>
    getMeaningfulPathWords(inferSupportScopeFromPath(file.path)).some((word) =>
      implementationWords.has(word),
    ),
  );
}

function isBroaderAdjacentGroup(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): boolean {
  return (
    previous.files.length > candidate.files.length ||
    countMessageDetailBullets(previous.message) >
      countMessageDetailBullets(candidate.message)
  );
}

function isPathOnlySurfaceMismatch(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
  sharedSurface: ReturnType<typeof getAdjacentGroupSharedSurface>,
): boolean {
  const sharesPathOnly =
    groupsSharePaths(previous, candidate) &&
    !isBroaderAdjacentGroup(previous, candidate);
  return (
    sharesPathOnly &&
    previousSubject.type !== candidateSubject.type &&
    candidateSubject.type !== "style" &&
    sharedSurface.sharedSubjectWords < 2
  );
}

function mergeAdjacentGroup(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): null | PlannedCommit {
  const subjectContext = getAdjacentSubjectContext(previous, candidate);
  const shouldAbsorbSupportPair = shouldAbsorbAdjacentSupportPair(
    previous,
    candidate,
    isBroaderAdjacentGroup,
  );
  if (
    !shouldAbsorbSupportPair &&
    !shouldAbsorbAdjacentGroup(previous, candidate)
  ) {
    return null;
  }

  const mergedGroup = mergeCommitsIntoGroup([previous, candidate], fileByPath);
  const primaryMessage = shouldAbsorbSupportPair
    ? getPreferredSupportPairPrimaryMessage(previous, candidate)
    : previous.message;
  const preservePrimaryMessageOnly =
    shouldAbsorbSupportPair &&
    shouldPreservePrimaryTestSupportMessage(
      subjectContext.previousSubject,
      subjectContext.candidateSubject,
      primaryMessage,
      previous.message,
    );

  const finalizedGroup = buildMergedAdjacentGroup(
    previous,
    candidate,
    mergedGroup,
    primaryMessage,
    preservePrimaryMessageOnly,
  );

  emitAdjacentAbsorptionTrace(
    previous,
    candidate,
    finalizedGroup,
    subjectContext,
    shouldAbsorbSupportPair,
    preservePrimaryMessageOnly,
  );

  return finalizedGroup;
}

function shouldAbsorbAdjacentGroup(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): boolean {
  const context = getAbsorbableAdjacentCandidateContext(previous, candidate);
  if (context === null) {
    return false;
  }

  if (
    isPathOnlySurfaceMismatch(
      previous,
      candidate,
      context.previousSubject,
      context.candidateSubject,
      context.sharedSurface,
    )
  ) {
    return false;
  }

  return (
    (isBroaderAdjacentGroup(previous, candidate) ||
      groupsSharePaths(previous, candidate) ||
      isScopedSupportFollowUp(
        previous,
        candidate,
        context.candidateSubject,
        context.sharedSurface,
      )) &&
    isAbsorbableAdjacentFollowUp(
      context.sharedSurface,
      context.candidateSubject,
    )
  );
}
