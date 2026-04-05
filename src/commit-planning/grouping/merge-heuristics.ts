import { groupCoversGroup, groupsShareCoverage, groupsSharePaths } from "./commit-coverage.js";
import {
  getCommitDependencyScore,
  hasDependencySignalBetweenGroups,
} from "./dependency-ordering.js";
import { type FileChangeSignals, type FileDiff, type PlannedCommit } from "./grouping-types.js";
import {
  getDistinctActionScore,
  getDistinctArtifactScore,
  getDistinctIntentScore,
  getSharedIntentScore,
} from "./intent-scoring.js";
import {
  countSharedSubjectWords,
  hasHighWordOverlap,
  isSupportLikeType,
  parseSubjectWords,
  scopesRelated,
} from "./subject/analysis.js";

/** Attach support-only groups to the strongest implementation component when the signal is decisive. */
export function chooseSupportAttachment(
  supportGroup: PlannedCommit,
  groups: PlannedCommit[],
  components: number[][],
  fileSignals: Map<string, FileChangeSignals>,
): number {
  let bestComponentIndex = -1;
  let bestScore = 0;
  let secondBestScore = 0;

  for (
    let componentIndex = 0;
    componentIndex < components.length;
    componentIndex++
  ) {
    const component = components[componentIndex];
    let componentScore = 0;

    for (const index of component) {
      componentScore = Math.max(
        componentScore,
        getSupportAttachmentScore(supportGroup, groups[index], fileSignals),
      );
    }

    componentScore -= getSupportAttachmentBreadthPenalty(
      supportGroup,
      component,
      groups,
      fileSignals,
    );

    if (componentScore > bestScore) {
      secondBestScore = bestScore;
      bestScore = componentScore;
      bestComponentIndex = componentIndex;
      continue;
    }

    if (componentScore > secondBestScore) {
      secondBestScore = componentScore;
    }
  }

  if (bestScore - secondBestScore <= 1) {
    return -1;
  }

  return bestScore >= 3 ? bestComponentIndex : -1;
}

/** Filter consolidated groups down to the ones that still cover more than one baseline group. */
export function getCoveredBaselineGroups(
  baselineGroups: PlannedCommit[],
  group: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  return baselineGroups.filter((baseline) =>
    groupCoversGroup(group, baseline, fileByPath),
  );
}

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
  if (hasScopedImplementationMerge(mergeSignal)) {
    return true;
  }
  if (hasTypedImplementationMerge(mergeSignal)) {
    return true;
  }

  return hasSharedIntentImplementationMerge(mergeSignal);
}

/** Return true when a group is primarily support work rather than implementation work. */
export function isSupportGroup(group: PlannedCommit): boolean {
  return isSupportLikeType(
    parseSubjectWords(group.message.split("\n")[0] ?? "").type,
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
    distinctActionScore: getDistinctActionScore(
      left,
      right,
      commonActionWords,
    ),
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
    hasDependencySignal: hasDependencySignalBetweenGroups(left, right, fileSignals),
    leftSubject,
    rightSubject,
    sharedIntentScore: getSharedIntentScore(left, right, fileSignals),
    sharedWordCount: countSharedSubjectWords(leftSubject.words, rightSubject.words),
  };
}

function getSupportAttachmentBreadthPenalty(
  supportGroup: PlannedCommit,
  component: number[],
  groups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
): number {
  if (!isSupportGroup(supportGroup) || component.length === 0) {
    return 0;
  }

  const componentGroups = component.map((index) => groups[index]);
  const uniquePaths = new Set(
    componentGroups.flatMap((group) => group.files.map((file) => file.path)),
  );
  const hasCoordinatorLikeFile = componentGroups.some((group) =>
    group.files.some(
      (file) => fileSignals.get(file.path)?.isCoordinatorLike === true,
    ),
  );

  let penalty = 0;
  if (uniquePaths.size > 1) {
    penalty += 1;
  }
  if (hasCoordinatorLikeFile && uniquePaths.size > 1) {
    penalty += 2;
  }

  return penalty;
}

function getSupportAttachmentScore(
  supportGroup: PlannedCommit,
  targetGroup: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): number {
  let score = 0;
  const supportSubject = parseSubjectWords(
    supportGroup.message.split("\n")[0] ?? "",
  );
  const targetSubject = parseSubjectWords(
    targetGroup.message.split("\n")[0] ?? "",
  );

  if (groupsSharePaths(supportGroup, targetGroup)) {
    score += 5;
  }
  if (hasDependencySignalBetweenGroups(supportGroup, targetGroup, fileSignals)) {
    score += 4;
  }
  if (
    supportSubject.scope &&
    targetSubject.scope &&
    scopesRelated(supportSubject.scope, targetSubject.scope)
  ) {
    score += 3;
  }

  score += Math.min(
    countSharedSubjectWords(supportSubject.words, targetSubject.words),
    3,
  );

  if (hasHighWordOverlap(supportSubject.words, targetSubject.words)) {
    score += 2;
  }

  return score;
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
    mergeSignal.leftSubject.scope.length > 0 &&
    mergeSignal.rightSubject.scope.length > 0 &&
    scopesRelated(mergeSignal.leftSubject.scope, mergeSignal.rightSubject.scope) &&
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
    hasHighWordOverlap(mergeSignal.leftSubject.words, mergeSignal.rightSubject.words) &&
    mergeSignal.distinctArtifactScore >= 1 &&
    (mergeSignal.distinctActionScore >= 1 || mergeSignal.distinctIntentScore >= 2)
  );
}

function shouldRejectDependencyOnlyMerge(mergeSignal: {
  dependencyScore: number;
  distinctActionScore: number;
  distinctArtifactScore: number;
}): boolean {
  return (
    mergeSignal.dependencyScore >= 4 &&
    mergeSignal.distinctActionScore === 0 &&
    mergeSignal.distinctArtifactScore === 0
  );
}