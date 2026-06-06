import type { FileDiff, PlannedCommit } from "../../../grouping-types.js";

import { isSupportLikePath } from "../../../../path/index.js";
import { groupsSharePaths } from "../../../commit-coverage.js";
import { getPathOwnerDescriptor } from "../../../ownership.js";
import {
  isSupportLikeType,
  parseSubjectWords,
} from "../../../subject/analysis.js";
import { emitAdjacentAbsorptionEvent } from "../../events.js";
import {
  mergeCommitMessagesWithPrimarySubject,
  mergeCommitsIntoGroup,
} from "../../merge.js";
import { countMessageDetailBullets } from "../../message-harmonization.js";
import { shouldPreserveFeatureSurfaceRollout } from "../../rollout-preservation.js";
import {
  isAbsorbableAdjacentFollowUp,
  isScopedSupportFollowUp,
  shouldPreservePreviousSupportPairMessage,
  shouldPreservePrimaryTestSupportMessage,
} from "../follow-up-rules.js";
import { shouldAbsorbAdjacentSupportPair } from "../support-merge/eligibility.js";
import { getAdjacentGroupSharedSurface } from "../surface-signals.js";
import {
  getAbsorbableAdjacentCandidateContext,
  getAdjacentSubjectContext,
} from "./context.js";

const MIN_IMPLEMENTATION_FILES_FOR_ROLLOUT_MERGE = 2;

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

function countImplementationFiles(group: PlannedCommit): number {
  return getFeatureImplementationFiles(group).length;
}

function emitAdjacentAbsorptionTrace(payload: {
  candidate: PlannedCommit;
  finalizedGroup: PlannedCommit;
  preservePrimaryMessageOnly: boolean;
  previous: PlannedCommit;
  reason: "adjacent-follow-up" | "implementation-rollout" | "support-pair";
  shouldAbsorbSupportPair: boolean;
  subjectContext: {
    candidateSubject: ReturnType<typeof parseSubjectWords>;
    previousSubject: ReturnType<typeof parseSubjectWords>;
  };
}): void {
  emitAdjacentAbsorptionEvent({
    candidateGroup: payload.candidate,
    diagnostics: {
      candidateFileCount: payload.candidate.files.length,
      candidateSubjectType: payload.subjectContext.candidateSubject.type,
      mergedFileCount: payload.finalizedGroup.files.length,
      preservePrimaryMessageOnly: payload.preservePrimaryMessageOnly,
      previousFileCount: payload.previous.files.length,
      previousSubjectType: payload.subjectContext.previousSubject.type,
      sharedPaths: groupsSharePaths(payload.previous, payload.candidate),
      shouldAbsorbSupportPair: payload.shouldAbsorbSupportPair,
    },
    mergedGroup: payload.finalizedGroup,
    previousGroup: payload.previous,
    reason: payload.reason,
  });
}

function getAdjacentAbsorptionReason(
  shouldAbsorbImplementationRollout: boolean,
  shouldAbsorbSupportPair: boolean,
): "adjacent-follow-up" | "implementation-rollout" | "support-pair" {
  if (shouldAbsorbSupportPair) {
    return "support-pair";
  }

  return shouldAbsorbImplementationRollout
    ? "implementation-rollout"
    : "adjacent-follow-up";
}

function getFeatureImplementationFiles(
  group: PlannedCommit,
): PlannedCommit["files"] {
  return group.files.filter((file) => {
    if (isSupportLikePath(file.path)) {
      return false;
    }

    return getPathOwnerDescriptor(file.path).featureRoot.includes("/");
  });
}

function getPreferredImplementationRolloutPrimaryMessage(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): string {
  return isBroaderAdjacentGroup(candidate, previous)
    ? candidate.message
    : previous.message;
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

function getPrimaryAdjacentMessage(
  candidate: PlannedCommit,
  previous: PlannedCommit,
  shouldAbsorbImplementationRollout: boolean,
  shouldAbsorbSupportPair: boolean,
): string {
  if (shouldAbsorbSupportPair) {
    return getPreferredSupportPairPrimaryMessage(previous, candidate);
  }

  return shouldAbsorbImplementationRollout
    ? getPreferredImplementationRolloutPrimaryMessage(previous, candidate)
    : previous.message;
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

function mergeAdjacentGroup(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): null | PlannedCommit {
  const subjectContext = getAdjacentSubjectContext(previous, candidate);
  const shouldAbsorbImplementationRollout =
    shouldAbsorbAdjacentImplementationRollout(
      previous,
      candidate,
      subjectContext.previousSubject,
      subjectContext.candidateSubject,
    );
  const shouldAbsorbSupportPair = shouldAbsorbAdjacentSupportPair(
    previous,
    candidate,
    isBroaderAdjacentGroup,
  );
  if (
    !shouldAbsorbImplementationRollout &&
    !shouldAbsorbSupportPair &&
    !shouldAbsorbAdjacentGroup(previous, candidate)
  ) {
    return null;
  }

  const mergedGroup = mergeCommitsIntoGroup([previous, candidate], fileByPath);
  const primaryMessage = getPrimaryAdjacentMessage(
    candidate,
    previous,
    shouldAbsorbImplementationRollout,
    shouldAbsorbSupportPair,
  );
  const preservePrimaryMessageOnly = shouldKeepPrimaryMessageOnly(
    subjectContext.candidateSubject,
    subjectContext.previousSubject,
    primaryMessage,
    previous.message,
    shouldAbsorbSupportPair,
  );

  const finalizedGroup = buildMergedAdjacentGroup(
    previous,
    candidate,
    mergedGroup,
    primaryMessage,
    preservePrimaryMessageOnly,
  );

  emitAdjacentAbsorptionTrace({
    candidate,
    finalizedGroup,
    preservePrimaryMessageOnly,
    previous,
    reason: getAdjacentAbsorptionReason(
      shouldAbsorbImplementationRollout,
      shouldAbsorbSupportPair,
    ),
    shouldAbsorbSupportPair,
    subjectContext,
  });

  return finalizedGroup;
}

function shouldAbsorbAdjacentGroup(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): boolean {
  const context = getAbsorbableAdjacentCandidateContext(
    previous,
    candidate,
    isBroaderAdjacentGroup,
  );
  if (context === null) {
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

function shouldAbsorbAdjacentImplementationRollout(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  if (
    isSupportLikeType(previousSubject.type) ||
    isSupportLikeType(candidateSubject.type) ||
    previousSubject.type !== candidateSubject.type
  ) {
    return false;
  }

  const sharedSurface = getAdjacentGroupSharedSurface(
    previous,
    candidate,
    previousSubject,
    candidateSubject,
  );
  if (!sharedSurface.sharedScope && sharedSurface.sharedSubjectWords < 2) {
    return false;
  }

  const previousImplementationCount = countImplementationFiles(previous);
  const candidateImplementationCount = countImplementationFiles(candidate);
  if (
    previousImplementationCount < MIN_IMPLEMENTATION_FILES_FOR_ROLLOUT_MERGE ||
    candidateImplementationCount < MIN_IMPLEMENTATION_FILES_FOR_ROLLOUT_MERGE
  ) {
    return false;
  }

  return shouldPreserveFeatureSurfaceRollout({
    files: [
      ...getFeatureImplementationFiles(previous),
      ...getFeatureImplementationFiles(candidate),
    ],
    message: isBroaderAdjacentGroup(candidate, previous)
      ? candidate.message
      : previous.message,
  });
}

function shouldKeepPrimaryMessageOnly(
  candidateSubject: ReturnType<typeof parseSubjectWords>,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  primaryMessage: string,
  previousMessage: string,
  shouldAbsorbSupportPair: boolean,
): boolean {
  return (
    shouldAbsorbSupportPair &&
    shouldPreservePrimaryTestSupportMessage(
      previousSubject,
      candidateSubject,
      primaryMessage,
      previousMessage,
    )
  );
}
