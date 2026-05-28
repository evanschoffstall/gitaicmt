export {
  buildPatch,
  chunkDiffs,
  formatDiffHeaderLines,
  formatFileDiff,
  formatSelectedFileDiff,
  getStats,
  parseDiff,
} from "./diff.js";
export type { DiffChunk, DiffHunk, DiffStats, FileDiff } from "./diff.js";
export {
  commitWithMessage,
  getStagedDiff,
  getStagedFiles,
  getStagedPatch,
  hasCommitHistory,
  hasStagedChanges,
  isGitRepository,
  resetStaging,
  restoreStagedPatch,
  stageAll,
  stageFiles,
  stagePatch,
} from "./operations.js";
export { getHeadCommit, getRepositoryRoot } from "./repository-state.js";
