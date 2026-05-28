import type { PlannedCommit } from "../../../grouping-types.js";

import {
  isSupportLikeType,
  parseSubjectWords,
  scopesRelated,
} from "../../../subject/analysis.js";
import {
  groupsShareTopLevelArea,
  hasSharedFeatureRoot,
} from "../../ownership-boundaries.js";
import {
  getAdjacentGroupSharedSurface,
  hasStrongSupportMessageOverlap,
  isSingleSurfaceGroup,
} from "../surface-signals.js";

export function shouldAbsorbAdjacentSupportPair(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  isBroaderAdjacentGroup: (
    previous: PlannedCommit,
    candidate: PlannedCommit,
  ) => boolean,
): boolean {
  const previousSubject = parseSubjectWords(
    previous.message.split("\n")[0] ?? "",
  );
  const candidateSubject = parseSubjectWords(
    candidate.message.split("\n")[0] ?? "",
  );
  if (!areSupportPairSubjects(previousSubject.type, candidateSubject.type)) {
    return false;
  }

  const sharedSurface = getAdjacentGroupSharedSurface(
    previous,
    candidate,
    previousSubject,
    candidateSubject,
  );
  if (!sharedSurface.hasAnyMatch) {
    return false;
  }

  return (
    isAbsorbableLexicalSupportPeer(
      previous,
      candidate,
      previousSubject,
      candidateSubject,
      sharedSurface,
    ) ||
    (groupsShareTopLevelArea(previous, candidate) &&
      hasSharedSupportSignal(
        previous,
        candidate,
        previousSubject,
        candidateSubject,
        sharedSurface,
      ) &&
      hasAbsorbablePairShape(previous, candidate, isBroaderAdjacentGroup))
  );
}

function areSupportPairSubjects(
  previousType: string,
  candidateType: string,
): boolean {
  return isSupportLikeType(previousType) && isSupportLikeType(candidateType);
}

function hasAbsorbablePairShape(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  isBroaderAdjacentGroup: (
    previous: PlannedCommit,
    candidate: PlannedCommit,
  ) => boolean,
): boolean {
  return (
    (isSingleSurfaceGroup(previous) &&
      isBroaderAdjacentGroup(candidate, previous)) ||
    (isSingleSurfaceGroup(candidate) &&
      isBroaderAdjacentGroup(previous, candidate))
  );
}

function hasSharedSupportSignal(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
  sharedSurface: ReturnType<typeof getAdjacentGroupSharedSurface>,
): boolean {
  return (
    sharedSurface.sharedPaths ||
    (previousSubject.type === candidateSubject.type &&
      (hasSharedFeatureRoot(previous, candidate) ||
        sharedSurface.sharedSubjectWords >= 2))
  );
}

function haveIdenticalSupportBodies(
  previousMessage: string,
  candidateMessage: string,
): boolean {
  const previousBody = previousMessage
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidateBody = candidateMessage
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (
    previousBody.length === candidateBody.length &&
    previousBody.every((line, index) => line === candidateBody[index])
  );
}

function isAbsorbableLexicalSupportPeer(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
  sharedSurface: ReturnType<typeof getAdjacentGroupSharedSurface>,
): boolean {
  return (
    previousSubject.type === candidateSubject.type &&
    isSingleSurfaceGroup(previous) &&
    isSingleSurfaceGroup(candidate) &&
    (scopesRelated(previousSubject.scope, candidateSubject.scope) ||
      !haveIdenticalSupportBodies(previous.message, candidate.message)) &&
    (sharedSurface.sharedPaths ||
      sharedSurface.sharedSubjectWords >= 2 ||
      hasStrongSupportMessageOverlap(previous.message, candidate.message))
  );
}
