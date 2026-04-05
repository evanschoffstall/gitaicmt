import { emitAiOutputEvent } from "../openai-client.js";
import { type FileChangeSignals, type PlannedCommit } from "./grouping-types.js";
import {
  buildCommitOrderingProfile,
  buildDependencyContext,
  buildReadyQueue,
  chooseDependencyOrderIndex,
  type CommitOrderingProfile,
  type DependencyGraph,
  enqueueReadyDependents,
  scoreDependencyForFile,
} from "./ordering-support.js";
import {
  countSharedSubjectWords,
  parseSubjectWords,
} from "./subject/analysis.js";

export {
  getCommonActionWords,
  getCommonIntentWords,
  getDistinctActionScore,
  getDistinctArtifactScore,
  getDistinctIntentScore,
  getSharedIntentScore,
} from "./intent-scoring.js";

/** Scores whether one planned commit should run before another. */
export function getCommitDependencyScore(
  dependent: PlannedCommit,
  dependency: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): number {
  let score = 0;
  const dependencyContext = buildDependencyContext(dependency, fileSignals);
  const dependentSubject = parseSubjectWords(
    dependent.message.split("\n")[0] ?? "",
  );

  for (const file of dependent.files) {
    score += scoreDependencyForFile(file.path, fileSignals, dependencyContext);
  }

  const sharedPathWordCount = countSharedSubjectWords(
    dependentSubject.words,
    dependencyContext.dependencyPathWords,
  );
  const sharedSubjectWordCount = countSharedSubjectWords(
    dependentSubject.words,
    dependencyContext.dependencySubject.words,
  );

  if (sharedPathWordCount > 0 && sharedSubjectWordCount > 0) {
    score += Math.min(sharedPathWordCount + sharedSubjectWordCount, 3);
  }

  return score;
}

/** Returns true when either group has a dependency signal on the other. */
export function hasDependencySignalBetweenGroups(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): boolean {
  return (
    getCommitDependencyScore(left, right, fileSignals) >= 4 ||
    getCommitDependencyScore(right, left, fileSignals) >= 4
  );
}

/** Orders commits so dependencies appear before their dependents when possible. */
export function orderCommitsByDependencies(
  groups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
): PlannedCommit[] {
  if (groups.length < 2) {
    return groups;
  }

  const orderingProfiles = groups.map(buildCommitOrderingProfile);
  const { edges, edgeWeights, indegree } = buildDependencyGraph(
    groups,
    fileSignals,
  );
  const queue = buildReadyQueue(indegree, orderingProfiles, edges, edgeWeights);
  const orderedIndexes = consumeDependencyOrderQueue(
    groups.length,
    queue,
    orderingProfiles,
    indegree,
    edges,
    edgeWeights,
  );

  if (orderedIndexes.length !== groups.length) {
    return groups;
  }

  const ordered = orderedIndexes.map((index) => groups[index]);
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "dependency-ordering",
      dependencyEdgeCount: edgeWeights.size,
      groupCount: groups.length,
      reordered: orderedIndexes.some((index, position) => index !== position),
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });

  return ordered;
}

function addDependencyEdge(
  graph: DependencyGraph,
  fileSignals: Map<string, FileChangeSignals>,
  groups: PlannedCommit[],
  dependentIndex: number,
  dependencyIndex: number,
): void {
  const dependencyScore = getCommitDependencyScore(
    groups[dependentIndex],
    groups[dependencyIndex],
    fileSignals,
  );
  if (dependencyScore < 4) {
    return;
  }

  const existing = graph.edges.get(dependencyIndex);
  if (existing?.has(dependentIndex)) {
    return;
  }

  (existing ?? new Set<number>()).add(dependentIndex);
  if (!existing) {
    graph.edges.set(dependencyIndex, new Set([dependentIndex]));
  }
  graph.edgeWeights.set(
    `${String(dependencyIndex)}:${String(dependentIndex)}`,
    dependencyScore,
  );
  graph.indegree[dependentIndex]++;
}

function buildDependencyGraph(
  groups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
): DependencyGraph {
  const graph: DependencyGraph = {
    edges: new Map<number, Set<number>>(),
    edgeWeights: new Map<string, number>(),
    indegree: groups.map(() => 0),
  };

  for (let dependentIndex = 0; dependentIndex < groups.length; dependentIndex++) {
    for (let dependencyIndex = 0; dependencyIndex < groups.length; dependencyIndex++) {
      if (dependentIndex === dependencyIndex) {
        continue;
      }

      addDependencyEdge(
        graph,
        fileSignals,
        groups,
        dependentIndex,
        dependencyIndex,
      );
    }
  }

  return graph;
}

function consumeDependencyOrderQueue(
  groupCount: number,
  queue: number[],
  orderingProfiles: CommitOrderingProfile[],
  indegree: number[],
  edges: Map<number, Set<number>>,
  edgeWeights: Map<string, number>,
): number[] {
  const orderedIndexes: number[] = [];
  const remainingIndexes = new Set(Array.from({ length: groupCount }, (_, index) => index));

  while (orderedIndexes.length < groupCount) {
    const index = takeNextDependencyIndex(
      queue,
      remainingIndexes,
      orderingProfiles,
      indegree,
      edges,
      edgeWeights,
    );
    if (index === undefined) {
      break;
    }
    if (!remainingIndexes.has(index)) {
      continue;
    }

    remainingIndexes.delete(index);
    orderedIndexes.push(index);
    enqueueReadyDependents(index, indegree, edges, queue, orderingProfiles, edgeWeights);
  }

  return orderedIndexes;
}

function takeNextDependencyIndex(
  queue: number[],
  remainingIndexes: Set<number>,
  orderingProfiles: CommitOrderingProfile[],
  indegree: number[],
  edges: Map<number, Set<number>>,
  edgeWeights: Map<string, number>,
): number | undefined {
  return queue.shift() ?? chooseDependencyOrderIndex(
    remainingIndexes,
    orderingProfiles,
    indegree,
    edges,
    edgeWeights,
  );
}
