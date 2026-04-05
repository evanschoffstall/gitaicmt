import { type FileChangeSignals, type PlannedCommit } from "./grouping-types.js";
import {
  countSharedSubjectWords,
  isSupportLikeType,
  parseSubjectWords,
} from "./subject/analysis.js";

export interface CommitOrderingProfile {
  hasImplementationFiles: boolean;
  priorityBucket: number;
}

export interface DependencyContext {
  dependencyHasImplementationFiles: boolean;
  dependencyImplementationPathWords: Set<string>;
  dependencyPaths: Set<string>;
  dependencyPathWords: Set<string>;
  dependencyProvidedSymbols: Set<string>;
  dependencySubject: ReturnType<typeof parseSubjectWords>;
}

export interface DependencyGraph {
  edges: Map<number, Set<number>>;
  edgeWeights: Map<string, number>;
  indegree: number[];
}

interface DependencySelection {
  incomingWeight: number;
  index: number;
  outgoingWeight: number;
}

/** Build a lightweight ordering profile used to break dependency-order ties. */
export function buildCommitOrderingProfile(
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

/** Collect the dependency-side signals needed to score one group against another. */
export function buildDependencyContext(
  dependency: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): DependencyContext {
  const dependencyContext: DependencyContext = {
    dependencyHasImplementationFiles: dependency.files.some(
      (file) => !isTestLikePath(file.path),
    ),
    dependencyImplementationPathWords: new Set<string>(),
    dependencyPaths: new Set(dependency.files.map((file) => file.path)),
    dependencyPathWords: new Set<string>(),
    dependencyProvidedSymbols: new Set<string>(),
    dependencySubject: parseSubjectWords(dependency.message.split("\n")[0] ?? ""),
  };

  for (const file of dependency.files) {
    const signals = fileSignals.get(file.path);
    if (!signals) {
      continue;
    }

    for (const symbol of signals.providedSymbols) {
      dependencyContext.dependencyProvidedSymbols.add(symbol);
    }
    for (const word of signals.pathWords) {
      dependencyContext.dependencyPathWords.add(word);
      if (!isTestLikePath(file.path)) {
        dependencyContext.dependencyImplementationPathWords.add(word);
      }
    }
  }

  return dependencyContext;
}

/** Build the initial zero-indegree queue in deterministic dependency order. */
export function buildReadyQueue(
  indegree: number[],
  orderingProfiles: CommitOrderingProfile[],
  edges: Map<number, Set<number>>,
  edgeWeights: Map<string, number>,
): number[] {
  return indegree
    .map((degree, index) => ({ degree, index }))
    .filter((entry) => entry.degree === 0)
    .map((entry) => entry.index)
    .sort((left, right) =>
      compareReadyIndexes(left, right, orderingProfiles, edges, edgeWeights),
    );
}

/** Choose a deterministic next index when cycles prevent the ready queue from progressing. */
export function chooseDependencyOrderIndex(
  remainingIndexes: Set<number>,
  orderingProfiles: CommitOrderingProfile[],
  indegree: number[],
  edges: Map<number, Set<number>>,
  edgeWeights: Map<string, number>,
): number | undefined {
  let selected: DependencySelection | undefined;

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

    if (
      shouldSelectDependencyOrderCandidate(
        index,
        selected,
        indegree,
        incomingWeight,
        outgoingWeight,
        orderingProfiles,
      )
    ) {
      selected = { incomingWeight, index, outgoingWeight };
    }
  }

  return selected?.index;
}

/** Decrement dependents and enqueue any commits that are now dependency-ready. */
export function enqueueReadyDependents(
  index: number,
  indegree: number[],
  edges: Map<number, Set<number>>,
  queue: number[],
  orderingProfiles: CommitOrderingProfile[],
  edgeWeights: Map<string, number>,
): void {
  for (const nextIndex of edges.get(index) ?? []) {
    indegree[nextIndex]--;
    if (indegree[nextIndex] === 0) {
      queue.push(nextIndex);
      queue.sort((left, right) =>
        compareReadyIndexes(left, right, orderingProfiles, edges, edgeWeights),
      );
    }
  }
}

/** Score one file's dependency relationship against an already-built dependency context. */
export function scoreDependencyForFile(
  filePath: string,
  fileSignals: Map<string, FileChangeSignals>,
  dependencyContext: DependencyContext,
): number {
  const signals = fileSignals.get(filePath);
  if (!signals) {
    return 0;
  }

  const score =
    scoreImportedPathDependencies(filePath, signals, dependencyContext) +
    scoreReferencedSymbolDependencies(signals, dependencyContext);

  return score + scoreTestValidationAffinity(filePath, signals, dependencyContext);
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
    path.includes("/__tests__/") ||
    path.startsWith("tests/") ||
    /(?:^|\/)[^.]+\.(?:spec|test)\.[^.]+$/u.test(path)
  );
}

function scoreImportedPathDependencies(
  filePath: string,
  signals: FileChangeSignals,
  dependencyContext: DependencyContext,
): number {
  let score = 0;

  for (const importedPath of signals.importedPaths) {
    if (!dependencyContext.dependencyPaths.has(importedPath)) {
      continue;
    }

    score +=
      isTestLikePath(filePath) && dependencyContext.dependencyHasImplementationFiles
        ? 8
        : 6;
  }

  return score;
}

function scoreReferencedSymbolDependencies(
  signals: FileChangeSignals,
  dependencyContext: DependencyContext,
): number {
  let score = 0;

  for (const symbol of signals.referencedSymbols) {
    if (dependencyContext.dependencyProvidedSymbols.has(symbol)) {
      score += 4;
    }
  }

  return score;
}

function scoreTestValidationAffinity(
  filePath: string,
  signals: FileChangeSignals,
  dependencyContext: DependencyContext,
): number {
  if (!isTestLikePath(filePath) || !dependencyContext.dependencyHasImplementationFiles) {
    return 0;
  }

  const sharedValidatedPathWordCount = countSharedSubjectWords(
    signals.pathWords,
    dependencyContext.dependencyImplementationPathWords,
  );
  return sharedValidatedPathWordCount > 0
    ? Math.min(sharedValidatedPathWordCount + 2, 4)
    : 0;
}

function shouldSelectDependencyOrderCandidate(
  index: number,
  selected: DependencySelection | undefined,
  indegree: number[],
  incomingWeight: number,
  outgoingWeight: number,
  orderingProfiles: CommitOrderingProfile[],
): boolean {
  if (!selected) {
    return true;
  }

  if (indegree[index] !== indegree[selected.index]) {
    return indegree[index] < indegree[selected.index];
  }
  if (incomingWeight !== selected.incomingWeight) {
    return incomingWeight < selected.incomingWeight;
  }
  if (outgoingWeight !== selected.outgoingWeight) {
    return outgoingWeight > selected.outgoingWeight;
  }

  return compareCommitOrderingProfile(
    orderingProfiles[index],
    orderingProfiles[selected.index],
  ) < 0;
}