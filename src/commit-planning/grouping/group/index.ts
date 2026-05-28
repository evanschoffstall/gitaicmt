export {
  absorbIncidentalAdjacentGroups,
  hasMostlyImplementationTail,
} from "./adjacent/index.js";
export {
  emitClusterProgressEvent,
  emitConsolidationDiminishingReturnsStop,
  emitCoverageMismatchFallback,
  emitRepartitionAfterConsolidationEvent,
} from "./events.js";
export { finalizePlannedGroups } from "./finalization.js";
export {
  finalizeStabilizedGroups,
  finalizeWithoutConsolidation,
  hasValidConsolidationCoverage,
  mergeClusterPass,
  readConsolidatedGroups,
  resolveHarmonizedConsolidation,
  shouldStopConsolidationPass,
} from "./group-stability.js";
export type { ClusterMergeResult } from "./group-stability.js";
export {
  mergeCommitClusters,
  mergeCommitFiles,
  mergeCommitMessages,
  mergeCommitsIntoGroup,
  prioritizeMergedCommits,
} from "./merge.js";
export {
  countMessageDetailBullets,
  harmonizeConsolidatedMessages,
  rescopeGroupMessageToCoveredGroups,
} from "./message-harmonization.js";
export {
  callCluster,
  completePlannerStage,
  describeError,
  emitPlannerFallbackEvent,
} from "./stage.js";
