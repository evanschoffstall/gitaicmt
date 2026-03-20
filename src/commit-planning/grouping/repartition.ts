import { groupCoversGroup, groupsShareCoverage, groupsSharePaths } from "./commit-coverage.js";
import {
  getCommitDependencyScore,
  hasDependencySignalBetweenGroups,
} from "./dependency-ordering.js";
import { mergeCommitsIntoGroup } from "./group-merge.js";
import { type FileChangeSignals, type FileDiff, type PlannedCommit } from "./grouping-types.js";
import {
  getCommonActionWords,
  getCommonIntentWords,
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
} from "./subject-analysis.js";

/**
 * Splits over-consolidated groups by re-grouping via intent affinity, then
 * re-attaches support commits to the closest implementation cluster.
 */
export function splitWeakConsolidations(
  baselineGroups: PlannedCommit[],
  consolidatedGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
): PlannedCommit[] {
  const result: PlannedCommit[] = [];

  for (const group of consolidatedGroups) {
    const coveredGroups = baselineGroups.filter((baseline) =>
      groupCoversGroup(group, baseline, fileByPath),
    );

    if (coveredGroups.length <= 1) {
      result.push(group);
      continue;
    }

    const repartitioned = repartitionByIntent(
      coveredGroups,
      fileByPath,
      fileSignals,
    );
    if (repartitioned.length <= 1) {
      result.push(group);
      continue;
    }

    result.push(...repartitioned);
  }

  return result;
}

function chooseSupportAttachment(
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

function hasImplementationMergeSignal(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
  commonActionWords: Set<string>,
  commonIntentWords: Set<string>,
): boolean {
  if (groupsShareCoverage(left, right)) {
    return true;
  }

  const leftSubject = parseSubjectWords(left.message.split("\n")[0] ?? "");
  const rightSubject = parseSubjectWords(right.message.split("\n")[0] ?? "");
  const sharedWordCount = countSharedSubjectWords(
    leftSubject.words,
    rightSubject.words,
  );
  const sharedIntentScore = getSharedIntentScore(left, right, fileSignals);
  const distinctIntentScore = getDistinctIntentScore(
    left,
    right,
    fileSignals,
    commonIntentWords,
  );
  const distinctActionScore = getDistinctActionScore(
    left,
    right,
    commonActionWords,
  );
  const distinctArtifactScore = getDistinctArtifactScore(
    left,
    right,
    fileSignals,
    commonIntentWords,
  );
  const dependencyScore = Math.max(
    getCommitDependencyScore(left, right, fileSignals),
    getCommitDependencyScore(right, left, fileSignals),
  );

  if (
    dependencyScore >= 4 &&
    distinctActionScore === 0 &&
    distinctArtifactScore === 0
  ) {
    return false;
  }

  if (hasDependencySignalBetweenGroups(left, right, fileSignals)) {
    return distinctActionScore >= 1 && distinctArtifactScore >= 1;
  }

  if (
    leftSubject.scope &&
    rightSubject.scope &&
    scopesRelated(leftSubject.scope, rightSubject.scope) &&
    distinctActionScore >= 1 &&
    distinctArtifactScore >= 1
  ) {
    return true;
  }

  if (
    leftSubject.type !== "" &&
    leftSubject.type === rightSubject.type &&
    hasHighWordOverlap(leftSubject.words, rightSubject.words) &&
    distinctArtifactScore >= 1 &&
    (distinctActionScore >= 1 || distinctIntentScore >= 2)
  ) {
    return true;
  }

  return (
    distinctActionScore >= 1 &&
    distinctArtifactScore >= 1 &&
    sharedIntentScore >= 3 &&
    (sharedWordCount >= 1 || distinctIntentScore >= 2)
  );
}

function isSupportGroup(group: PlannedCommit): boolean {
  return isSupportLikeType(
    parseSubjectWords(group.message.split("\n")[0] ?? "").type,
  );
}

function repartitionByIntent(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
): PlannedCommit[] {
  const implementationIndexes: number[] = [];
  const supportIndexes: number[] = [];

  for (let index = 0; index < groups.length; index++) {
    if (isSupportGroup(groups[index])) {
      supportIndexes.push(index);
    } else {
      implementationIndexes.push(index);
    }
  }

  if (implementationIndexes.length <= 1) {
    return [mergeCommitsIntoGroup(groups, fileByPath)];
  }

  const implementationGroups = implementationIndexes.map(
    (index) => groups[index],
  );
  const commonActionWords = getCommonActionWords(implementationGroups);
  const commonIntentWords = getCommonIntentWords(
    implementationGroups,
    fileSignals,
  );

  const components: number[][] = [];
  const visited = new Set<number>();

  for (const startIndex of implementationIndexes) {
    if (visited.has(startIndex)) {
      continue;
    }

    const stack = [startIndex];
    const component: number[] = [];
    visited.add(startIndex);

    while (stack.length > 0) {
      const currentIndex = stack.pop();
      if (currentIndex === undefined) {
        continue;
      }

      component.push(currentIndex);

      for (const candidateIndex of implementationIndexes) {
        if (visited.has(candidateIndex) || candidateIndex === currentIndex) {
          continue;
        }

        if (
          hasImplementationMergeSignal(
            groups[currentIndex],
            groups[candidateIndex],
            fileSignals,
            commonActionWords,
            commonIntentWords,
          )
        ) {
          visited.add(candidateIndex);
          stack.push(candidateIndex);
        }
      }
    }

    components.push(component.sort((left, right) => left - right));
  }

  if (components.length <= 1) {
    return [mergeCommitsIntoGroup(groups, fileByPath)];
  }

  for (const supportIndex of supportIndexes) {
    const attachmentIndex = chooseSupportAttachment(
      groups[supportIndex],
      groups,
      components,
      fileSignals,
    );

    if (attachmentIndex === -1) {
      components.push([supportIndex]);
      continue;
    }

    components[attachmentIndex]?.push(supportIndex);
  }

  return components
    .map((component) => component.sort((left, right) => left - right))
    .sort((left, right) => left[0] - right[0])
    .map((component) =>
      mergeCommitsIntoGroup(
        component.map((index) => groups[index]),
        fileByPath,
      ),
    );
}
