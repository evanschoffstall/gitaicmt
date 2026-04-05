import { hasMatchingCoverage } from "../commit-coverage.js";
import { mergeCommitClusters } from "../group/merge.js";
import { type FileDiff, type PlannedCommit } from "../grouping-types.js";
import { hasHighWordOverlap, parseSubjectWords } from "./analysis.js";

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

  for (let leftIndex = 0; leftIndex < groups.length; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < groups.length;
      rightIndex++
    ) {
      if (shouldPremergeSubjects(wordSets[leftIndex], wordSets[rightIndex])) {
        uniteSubjectCluster(parent, leftIndex, rightIndex);
      }
    }
  }

  const clusters = buildSubjectClusters(groups.length, parent);
  if (!clusters.some((cluster) => cluster.length > 1)) {
    return groups;
  }

  const merged = mergeCommitClusters(groups, clusters, fileByPath);
  return hasMatchingCoverage(groups, merged, fileByPath) ? merged : groups;
}

function buildSubjectClusters(groupCount: number, parent: number[]): number[][] {
  const clusterMap = new Map<number, number[]>();

  for (let index = 0; index < groupCount; index++) {
    const root = findSubjectClusterRoot(parent, index);
    const existing = clusterMap.get(root);
    if (existing) {
      existing.push(index);
    } else {
      clusterMap.set(root, [index]);
    }
  }

  return [...clusterMap.values()];
}

function findSubjectClusterRoot(parent: number[], value: number): number {
  let node = value;
  while (parent[node] !== node) {
    parent[node] = parent[parent[node]];
    node = parent[node];
  }
  return node;
}

function shouldPremergeSubjects(
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
): boolean {
  return left.type !== "" && left.type === right.type && hasHighWordOverlap(left.words, right.words);
}

function uniteSubjectCluster(parent: number[], left: number, right: number): void {
  const leftRoot = findSubjectClusterRoot(parent, left);
  const rightRoot = findSubjectClusterRoot(parent, right);
  if (leftRoot !== rightRoot) {
    parent[rightRoot] = leftRoot;
  }
}