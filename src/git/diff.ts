/**
 * Diff parsing and chunking module
 * Parses git diffs into structured data and chunks them for AI analysis
 * All git command execution has been moved to git.ts
 */


export { chunkDiffs } from "./chunks.js";
export {
  formatDiffHeaderLines,
  formatFileDiff,
  formatSelectedFileDiff,
  getStats,
} from "./formatting.js";
export type { DiffChunk, DiffHunk, DiffStats, FileDiff } from "./models.js";
export { parseDiff } from "./parser.js";
export { buildPatch } from "./patches.js";

