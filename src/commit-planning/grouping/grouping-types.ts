import { type PlannedCommit, type PlannedCommitFile } from "../types.js";

/**
 * Semantic signals collected from the changed file text and current file
 * contents so grouping can reason about intent, dependencies, and ownership.
 */
export interface FileChangeSignals {
  importedPaths: Set<string>;
  intentWords: Set<string>;
  isCoordinatorLike: boolean;
  pathWords: Set<string>;
  providedSymbols: Set<string>;
  referencedSymbols: Set<string>;
}

/** Shared planner file diff type used by grouping internals. */
export type FileDiff = import("../../git/diff.js").FileDiff;

/** Parsed conventional-commit subject metadata used by merge heuristics. */
export interface SubjectWords {
  scope: string;
  type: string;
  words: Set<string>;
}

export type { PlannedCommit, PlannedCommitFile };
