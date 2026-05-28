import type { PlannedCommit } from "../../grouping-types.js";

import { groupsSharePaths } from "../../commit-coverage.js";
import {
  countSharedSubjectWords,
  parseSubjectWords,
  scopesRelated,
} from "../../subject/analysis.js";

export interface AdjacentSharedSurface {
  hasAnyMatch: boolean;
  sharedPaths: boolean;
  sharedScope: boolean;
  sharedSubjectWords: number;
}

export function getAdjacentGroupSharedSurface(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
): AdjacentSharedSurface {
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

export function hasStrongSupportMessageOverlap(
  previousMessage: string,
  candidateMessage: string,
): boolean {
  return countSharedMessageWords(previousMessage, candidateMessage) >= 4;
}

export function isSingleSurfaceGroup(group: PlannedCommit): boolean {
  return (
    group.files.length === 1 &&
    group.files.every((file) => !file.hunks || file.hunks.length <= 1)
  );
}

function countSharedMessageWords(
  previousMessage: string,
  candidateMessage: string,
): number {
  const previousWords = getMessageWords(previousMessage);
  const candidateWords = getMessageWords(candidateMessage);
  let sharedWordCount = 0;

  for (const word of previousWords) {
    if (candidateWords.has(word)) {
      sharedWordCount++;
    }
  }

  return sharedWordCount;
}

function getMessageWords(message: string): Set<string> {
  return new Set(
    message
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((word) => word.length >= 4) ?? [],
  );
}
