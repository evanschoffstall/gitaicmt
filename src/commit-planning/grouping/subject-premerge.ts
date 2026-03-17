import { hasMatchingCoverage } from "./commit-coverage.js";
import { applyCommitClusters } from "./commit-merge.js";
import { type FileDiff, type PlannedCommit } from "./grouping-types.js";
import { hasHighWordOverlap, parseSubjectWords } from "./subject-analysis.js";

/**
 * Deterministically merges obviously related commits before asking AI to do
 * more expensive clustering or consolidation work.
 */
export function premergeBySubject(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  if (groups.length < 2) {
    return groups;
  }

  const wordSets = groups.map((group) =>
    parseSubjectWords(group.message.split("\n")[0] ?? ""),
  );
  const parent = groups.map((_, index) => index);

  const find = (value: number): number => {
    let node = value;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  };

  const unite = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  for (let leftIndex = 0; leftIndex < groups.length; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < groups.length;
      rightIndex++
    ) {
      if (
        wordSets[leftIndex].type !== "" &&
        wordSets[leftIndex].type === wordSets[rightIndex].type &&
        hasHighWordOverlap(wordSets[leftIndex].words, wordSets[rightIndex].words)
      ) {
        unite(leftIndex, rightIndex);
      }
    }
  }

  const clusterMap = new Map<number, number[]>();
  for (let index = 0; index < groups.length; index++) {
    const root = find(index);
    const existing = clusterMap.get(root);
    if (existing) {
      existing.push(index);
    } else {
      clusterMap.set(root, [index]);
    }
  }

  const clusters = [...clusterMap.values()];
  if (!clusters.some((cluster) => cluster.length > 1)) {
    return groups;
  }

  const merged = applyCommitClusters(groups, clusters, fileByPath);
  return hasMatchingCoverage(groups, merged, fileByPath) ? merged : groups;
}