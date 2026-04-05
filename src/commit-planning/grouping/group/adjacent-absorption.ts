import type { FileDiff, PlannedCommit } from "../grouping-types.js";

import {
  groupsSharePaths,
} from "../commit-coverage.js";
import {
  countSharedSubjectWords,
  isSupportLikeType,
  parseSubjectWords,
  scopesRelated,
} from "../subject/analysis.js";
import { mergeCommitsIntoGroup } from "./merge.js";
import { countMessageDetailBullets } from "./message-harmonization.js";

/**
 * Absorbs adjacent tiny follow-up commits into the prior broader change when
 * they touch the same surface and read like incidental cleanup.
 */
export function absorbIncidentalAdjacentGroups(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const absorbed: PlannedCommit[] = [];

  for (const group of groups) {
    const previous = absorbed.at(-1);
    if (previous && shouldAbsorbAdjacentGroup(previous, group)) {
      absorbed[absorbed.length - 1] = mergeCommitsIntoGroup(
        [previous, group],
        fileByPath,
      );
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

function getAdjacentGroupSharedSurface(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
): {
  hasAnyMatch: boolean;
  sharedPaths: boolean;
  sharedScope: boolean;
  sharedSubjectWords: number;
} {
  const sharedScope =
    previousSubject.scope.length > 0 &&
    candidateSubject.scope.length > 0 &&
    scopesRelated(previousSubject.scope, candidateSubject.scope);
  const sharedSubjectWords = countSharedSubjectWords(
    previousSubject.words,
    candidateSubject.words,
  );
  const sharedPaths = groupsSharePaths(previous, candidate);

  return {
    hasAnyMatch: sharedPaths || sharedScope || sharedSubjectWords > 0,
    sharedPaths,
    sharedScope,
    sharedSubjectWords,
  };
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

function isSingleSurfaceGroup(group: PlannedCommit): boolean {
  return (
    group.files.length === 1 &&
    group.files.every(
      (file) => !file.hunks || file.hunks.length <= 1,
    )
  );
}

function shouldAbsorbAdjacentGroup(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): boolean {
  if (!isSingleSurfaceGroup(candidate)) {
    return false;
  }

  const previousSubject = parseSubjectWords(previous.message.split("\n")[0] ?? "");
  const candidateSubject = parseSubjectWords(candidate.message.split("\n")[0] ?? "");
  if (isSupportLikeType(previousSubject.type)) {
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

  const candidateSupportLike = isSupportLikeType(candidateSubject.type);
  const previousIsBroader = isBroaderAdjacentGroup(previous, candidate);

  return (
    previousIsBroader &&
    (candidateSupportLike ||
      sharedSurface.sharedPaths ||
      (sharedSurface.sharedScope && sharedSurface.sharedSubjectWords > 0))
  );
}