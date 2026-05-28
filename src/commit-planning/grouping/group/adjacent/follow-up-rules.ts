import type { PlannedCommit } from "../../grouping-types.js";

import { isSupportLikeType, scopesRelated } from "../../subject/analysis.js";
import { countMessageDetailBullets } from "../message-harmonization.js";
import {
  groupsShareTopLevelArea,
  hasSharedOwner,
} from "../ownership-boundaries.js";
import { hasStrongSupportMessageOverlap } from "./surface-signals.js";

interface AdjacentSubject {
  scope: string;
  type: string;
  words: Set<string>;
}

interface AdjacentSurface {
  hasAnyMatch: boolean;
  sharedPaths: boolean;
  sharedScope: boolean;
  sharedSubjectWords: number;
}

export function blocksCrossAreaStyleAbsorption(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  candidateSubject: AdjacentSubject,
): boolean {
  return (
    candidateSubject.type === "style" &&
    !groupsShareTopLevelArea(previous, candidate)
  );
}

export function blocksThinSupportFollowUp(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: AdjacentSubject,
  candidateSubject: AdjacentSubject,
): boolean {
  const candidateHasDetailBullets =
    countMessageDetailBullets(candidate.message) > 0;
  if (
    isSupportLikeType(candidateSubject.type) &&
    !candidateHasDetailBullets &&
    previous.files.length === 1
  ) {
    return true;
  }

  return (
    isSupportLikeType(candidateSubject.type) &&
    !candidateHasDetailBullets &&
    previousSubject.scope.length > 0 &&
    candidateSubject.scope.length > 0 &&
    !scopesRelated(previousSubject.scope, candidateSubject.scope)
  );
}

export function isAbsorbableAdjacentFollowUp(
  sharedSurface: AdjacentSurface,
  candidateSubject: AdjacentSubject,
): boolean {
  return (
    isSupportLikeType(candidateSubject.type) ||
    sharedSurface.sharedPaths ||
    (sharedSurface.sharedScope && sharedSurface.sharedSubjectWords > 0)
  );
}

export function isScopedSupportFollowUp(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  candidateSubject: AdjacentSubject,
  sharedSurface: AdjacentSurface,
): boolean {
  return (
    isSupportLikeType(candidateSubject.type) &&
    sharedSurface.sharedScope &&
    hasSharedOwner(previous, candidate)
  );
}

export function shouldPreservePreviousSupportPairMessage(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: AdjacentSubject,
  candidateSubject: AdjacentSubject,
  sharedSurface: AdjacentSurface,
): boolean {
  return (
    previousSubject.type === candidateSubject.type &&
    !sharedSurface.sharedPaths &&
    (sharedSurface.sharedSubjectWords >= 2 ||
      hasStrongSupportMessageOverlap(previous.message, candidate.message))
  );
}

export function shouldPreservePrimaryTestSupportMessage(
  previousSubject: AdjacentSubject,
  candidateSubject: AdjacentSubject,
  primaryMessage: string,
  previousMessage: string,
): boolean {
  return (
    previousSubject.type === "test" &&
    candidateSubject.type === "test" &&
    primaryMessage === previousMessage
  );
}
