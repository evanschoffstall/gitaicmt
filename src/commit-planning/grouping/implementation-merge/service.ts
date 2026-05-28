import { groupsShareCoverage } from "../commit-coverage.js";
import {
  getCommitDependencyScore,
  hasDependencySignalBetweenGroups,
} from "../dependency/index.js";
import {
  type FileChangeSignals,
  type PlannedCommit,
} from "../grouping-types.js";
import {
  getDistinctActionScore,
  getDistinctArtifactScore,
  getDistinctIntentScore,
  getSharedIntentScore,
} from "../intent/index.js";
import {
  countSharedSubjectWords,
  hasHighWordOverlap,
  parseSubjectWords,
} from "../subject/analysis.js";
import {
  hasRelatedScopes,
  hasSameFeatureRootRolloutMerge,
  hasStrongSharedRolloutMerge,
  shouldRejectBroadOwnershipMerge,
  shouldRejectCrossDomainUmbrellaMerge,
  shouldRejectDependencyOnlyMerge,
} from "./eligibility.js";

/** Decide whether two implementation groups should remain merged after consolidation. */
export function hasImplementationMergeSignal(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
  commonActionWords: Set<string>,
  commonIntentWords: Set<string>,
): boolean {
  if (groupsShareCoverage(left, right)) {
    return true;
  }

  const mergeSignal = buildImplementationMergeSignal(
    left,
    right,
    fileSignals,
    commonActionWords,
    commonIntentWords,
  );
  if (shouldRejectDependencyOnlyMerge(mergeSignal)) {
    return false;
  }
  if (shouldRejectCrossDomainUmbrellaMerge(left, right, mergeSignal)) {
    return false;
  }
  if (shouldRejectBroadOwnershipMerge(left, right, mergeSignal)) {
    return false;
  }

  return (
    hasScopedImplementationMerge(mergeSignal) ||
    hasTypedImplementationMerge(mergeSignal) ||
    hasStrongSharedRolloutMerge(left, right, mergeSignal) ||
    hasSameFeatureRootRolloutMerge(left, right, mergeSignal) ||
    hasSharedIntentImplementationMerge(mergeSignal)
  );
}

function buildImplementationMergeSignal(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
  commonActionWords: Set<string>,
  commonIntentWords: Set<string>,
) {
  const leftSubject = parseSubjectWords(left.message.split("\n")[0] ?? "");
  const rightSubject = parseSubjectWords(right.message.split("\n")[0] ?? "");

  return {
    dependencyScore: Math.max(
      getCommitDependencyScore(left, right, fileSignals),
      getCommitDependencyScore(right, left, fileSignals),
    ),
    distinctActionScore: getDistinctActionScore(left, right, commonActionWords),
    distinctArtifactScore: getDistinctArtifactScore(
      left,
      right,
      fileSignals,
      commonIntentWords,
    ),
    distinctIntentScore: getDistinctIntentScore(
      left,
      right,
      fileSignals,
      commonIntentWords,
    ),
    hasDependencySignal: hasDependencySignalBetweenGroups(
      left,
      right,
      fileSignals,
    ),
    leftSubject,
    rightSubject,
    sharedIntentScore: getSharedIntentScore(left, right, fileSignals),
    sharedWordCount: countSharedSubjectWords(
      leftSubject.words,
      rightSubject.words,
    ),
  };
}

function hasScopedImplementationMerge(mergeSignal: {
  distinctActionScore: number;
  distinctArtifactScore: number;
  hasDependencySignal: boolean;
  leftSubject: ReturnType<typeof parseSubjectWords>;
  rightSubject: ReturnType<typeof parseSubjectWords>;
}): boolean {
  if (mergeSignal.hasDependencySignal) {
    return (
      mergeSignal.distinctActionScore >= 1 &&
      mergeSignal.distinctArtifactScore >= 1
    );
  }

  return (
    hasRelatedScopes(mergeSignal) &&
    mergeSignal.distinctActionScore >= 1 &&
    mergeSignal.distinctArtifactScore >= 1
  );
}

function hasSharedIntentImplementationMerge(mergeSignal: {
  distinctActionScore: number;
  distinctArtifactScore: number;
  distinctIntentScore: number;
  sharedIntentScore: number;
  sharedWordCount: number;
}): boolean {
  return (
    mergeSignal.distinctActionScore >= 1 &&
    mergeSignal.distinctArtifactScore >= 1 &&
    mergeSignal.sharedIntentScore >= 3 &&
    (mergeSignal.sharedWordCount >= 1 || mergeSignal.distinctIntentScore >= 2)
  );
}

function hasTypedImplementationMerge(mergeSignal: {
  distinctActionScore: number;
  distinctArtifactScore: number;
  distinctIntentScore: number;
  leftSubject: ReturnType<typeof parseSubjectWords>;
  rightSubject: ReturnType<typeof parseSubjectWords>;
}): boolean {
  return (
    mergeSignal.leftSubject.type !== "" &&
    mergeSignal.leftSubject.type === mergeSignal.rightSubject.type &&
    hasHighWordOverlap(
      mergeSignal.leftSubject.words,
      mergeSignal.rightSubject.words,
    ) &&
    mergeSignal.distinctArtifactScore >= 1 &&
    (mergeSignal.distinctActionScore >= 1 ||
      mergeSignal.distinctIntentScore >= 2)
  );
}
