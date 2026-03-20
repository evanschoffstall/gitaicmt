import { emitAiOutputEvent } from "../openai-client.js";
import { type FileChangeSignals, type PlannedCommit } from "./grouping-types.js";
import {
  countSharedSubjectWords,
  isSupportLikeType,
  parseSubjectWords,
} from "./subject-analysis.js";

export {
  getCommonActionWords,
  getCommonIntentWords,
  getDistinctActionScore,
  getDistinctArtifactScore,
  getDistinctIntentScore,
  getSharedIntentScore,
} from "./intent-scoring.js";

interface CommitOrderingProfile {
  hasImplementationFiles: boolean;
  priorityBucket: number;
}

/** Scores whether one planned commit should run before another. */
export function getCommitDependencyScore(
  dependent: PlannedCommit,
  dependency: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): number {
  let score = 0;
  const dependencyPaths = new Set(dependency.files.map((file) => file.path));
  const dependencyHasImplementationFiles = dependency.files.some(
    (file) => !isTestLikePath(file.path),
  );
  const dependencyImplementationPathWords = new Set<string>();
  const dependencyProvidedSymbols = new Set<string>();
  const dependencyPathWords = new Set<string>();
  const dependencySubject = parseSubjectWords(
    dependency.message.split("\n")[0] ?? "",
  );
  const dependentSubject = parseSubjectWords(
    dependent.message.split("\n")[0] ?? "",
  );

  for (const file of dependency.files) {
    const signals = fileSignals.get(file.path);
    if (!signals) {
      continue;
    }

    for (const symbol of signals.providedSymbols) {
      dependencyProvidedSymbols.add(symbol);
    }
    for (const word of signals.pathWords) {
      dependencyPathWords.add(word);
      if (!isTestLikePath(file.path)) {
        dependencyImplementationPathWords.add(word);
      }
    }
  }

  for (const file of dependent.files) {
    const signals = fileSignals.get(file.path);
    if (!signals) {
      continue;
    }

    for (const importedPath of signals.importedPaths) {
      if (dependencyPaths.has(importedPath)) {
        score +=
          isTestLikePath(file.path) && dependencyHasImplementationFiles ? 8 : 6;
      }
    }

    for (const symbol of signals.referencedSymbols) {
      if (dependencyProvidedSymbols.has(symbol)) {
        score += 4;
      }
    }

    if (isTestLikePath(file.path) && dependencyHasImplementationFiles) {
      const sharedValidatedPathWordCount = countSharedSubjectWords(
        signals.pathWords,
        dependencyImplementationPathWords,
      );
      if (sharedValidatedPathWordCount > 0) {
        score += Math.min(sharedValidatedPathWordCount + 2, 4);
      }
    }
  }

  const sharedPathWordCount = countSharedSubjectWords(
    dependentSubject.words,
    dependencyPathWords,
  );
  const sharedSubjectWordCount = countSharedSubjectWords(
    dependentSubject.words,
    dependencySubject.words,
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
  const edges = new Map<number, Set<number>>();
  const edgeWeights = new Map<string, number>();
  const indegree = groups.map(() => 0);

  for (let dependentIndex = 0; dependentIndex < groups.length; dependentIndex++) {
    for (
      let dependencyIndex = 0;
      dependencyIndex < groups.length;
      dependencyIndex++
    ) {
      if (dependentIndex === dependencyIndex) {
        continue;
      }

      const dependencyScore = getCommitDependencyScore(
        groups[dependentIndex],
        groups[dependencyIndex],
        fileSignals,
      );
      if (dependencyScore < 4) {
        continue;
      }

      const existing = edges.get(dependencyIndex);
      if (existing?.has(dependentIndex)) {
        continue;
      }

      if (existing) {
        existing.add(dependentIndex);
      } else {
        edges.set(dependencyIndex, new Set([dependentIndex]));
      }
      edgeWeights.set(
        `${String(dependencyIndex)}:${String(dependentIndex)}`,
        dependencyScore,
      );
      indegree[dependentIndex]++;
    }
  }

  const queue = indegree
    .map((degree, index) => ({ degree, index }))
    .filter((entry) => entry.degree === 0)
    .map((entry) => entry.index)
    .sort((left, right) =>
      compareReadyIndexes(left, right, orderingProfiles, edges, edgeWeights),
    );
  const orderedIndexes: number[] = [];
  const remainingIndexes = new Set(groups.map((_, index) => index));

  while (orderedIndexes.length < groups.length) {
    const index =
      queue.shift() ??
      chooseDependencyOrderIndex(
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
    const outgoing = edges.get(index);
    if (!outgoing) {
      continue;
    }

    for (const nextIndex of outgoing) {
      indegree[nextIndex]--;
      if (indegree[nextIndex] === 0) {
        queue.push(nextIndex);
        queue.sort((left, right) =>
          compareReadyIndexes(left, right, orderingProfiles, edges, edgeWeights),
        );
      }
    }
  }

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

function buildCommitOrderingProfile(
  group: PlannedCommit,
): CommitOrderingProfile {
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
  const hasImplementationFiles = group.files.some(
    (file) => !isTestLikePath(file.path),
  );
  const hasOnlyTestFiles = group.files.every((file) => isTestLikePath(file.path));
  const supportLike = isSupportLikeType(subject.type);

  return {
    hasImplementationFiles,
    priorityBucket:
      hasOnlyTestFiles || (supportLike && !hasImplementationFiles)
        ? 2
        : supportLike
          ? 1
          : 0,
  };
}

function chooseDependencyOrderIndex(
  remainingIndexes: Set<number>,
  orderingProfiles: CommitOrderingProfile[],
  indegree: number[],
  edges: Map<number, Set<number>>,
  edgeWeights: Map<string, number>,
): number | undefined {
  let selectedIndex: number | undefined;
  let selectedIndegree = Number.POSITIVE_INFINITY;
  let selectedIncomingWeight = Number.POSITIVE_INFINITY;
  let selectedOutgoingWeight = Number.NEGATIVE_INFINITY;

  for (const index of remainingIndexes) {
    const incomingWeight = getIncomingDependencyWeight(
      index,
      remainingIndexes,
      edgeWeights,
    );
    const outgoingWeight = getOutgoingDependencyWeight(
      index,
      remainingIndexes,
      edges,
      edgeWeights,
    );

    if (indegree[index] < selectedIndegree) {
      selectedIndex = index;
      selectedIndegree = indegree[index];
      selectedIncomingWeight = incomingWeight;
      selectedOutgoingWeight = outgoingWeight;
      continue;
    }
    if (indegree[index] > selectedIndegree) {
      continue;
    }

    if (incomingWeight < selectedIncomingWeight) {
      selectedIndex = index;
      selectedIncomingWeight = incomingWeight;
      selectedOutgoingWeight = outgoingWeight;
      continue;
    }
    if (incomingWeight > selectedIncomingWeight) {
      continue;
    }

    if (outgoingWeight > selectedOutgoingWeight) {
      selectedIndex = index;
      selectedOutgoingWeight = outgoingWeight;
      continue;
    }
    if (outgoingWeight < selectedOutgoingWeight) {
      continue;
    }

    if (
      selectedIndex === undefined ||
      compareCommitOrderingProfile(
        orderingProfiles[index],
        orderingProfiles[selectedIndex],
      ) < 0
    ) {
      selectedIndex = index;
    }
  }

  return selectedIndex;
}

function compareCommitOrderingProfile(
  left: CommitOrderingProfile,
  right: CommitOrderingProfile,
): number {
  if (left.priorityBucket !== right.priorityBucket) {
    return left.priorityBucket - right.priorityBucket;
  }

  if (left.hasImplementationFiles !== right.hasImplementationFiles) {
    return left.hasImplementationFiles ? -1 : 1;
  }

  return 0;
}

function compareReadyIndexes(
  left: number,
  right: number,
  orderingProfiles: CommitOrderingProfile[],
  edges: Map<number, Set<number>>,
  edgeWeights: Map<string, number>,
): number {
  const profileComparison = compareCommitOrderingProfile(
    orderingProfiles[left],
    orderingProfiles[right],
  );
  if (profileComparison !== 0) {
    return profileComparison;
  }

  const outgoingWeightDifference =
    getOutgoingDependencyWeight(left, new Set([left, right]), edges, edgeWeights) -
    getOutgoingDependencyWeight(right, new Set([left, right]), edges, edgeWeights);
  if (outgoingWeightDifference !== 0) {
    return outgoingWeightDifference > 0 ? -1 : 1;
  }

  return left - right;
}

function getIncomingDependencyWeight(
  targetIndex: number,
  remainingIndexes: Set<number>,
  edgeWeights: Map<string, number>,
): number {
  let weight = 0;

  for (const index of remainingIndexes) {
    weight += edgeWeights.get(`${String(index)}:${String(targetIndex)}`) ?? 0;
  }

  return weight;
}

function getOutgoingDependencyWeight(
  sourceIndex: number,
  remainingIndexes: Set<number>,
  edges: Map<number, Set<number>>,
  edgeWeights: Map<string, number>,
): number {
  let weight = 0;

  for (const targetIndex of edges.get(sourceIndex) ?? []) {
    if (!remainingIndexes.has(targetIndex)) {
      continue;
    }

    weight +=
      edgeWeights.get(`${String(sourceIndex)}:${String(targetIndex)}`) ?? 0;
  }

  return weight;
}

function isTestLikePath(path: string): boolean {
  return (
    path.startsWith("tests/") ||
    path.startsWith("test/") ||
    /(?:^|\/)[^.]+\.(?:spec|test)\.[^.]+$/u.test(path)
  );
}
