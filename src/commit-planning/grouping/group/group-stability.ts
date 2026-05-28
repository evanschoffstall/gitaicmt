import type { CommitMessageRuleOptions } from "../../prompts/index.js";

import { emitAiOutputEvent } from "../../openai-client.js";
import { validateAndNormalizeGrouping } from "../../response-validation.js";
import {
  getCoverageMismatchDiagnostics,
  hasMatchingCoverage,
} from "../commit-coverage.js";
import { orderCommitsByDependencies } from "../dependency/index.js";
import {
  type FileChangeSignals,
  type FileDiff,
  type PlannedCommit,
} from "../grouping-types.js";
import { splitWeakConsolidations } from "../repartition.js";
import {
  absorbIncidentalAdjacentGroups,
  hasMostlyImplementationTail,
} from "./adjacent/index.js";
import {
  getClusterSizeDiagnostics,
  hasMeaningfulConsolidationChange,
  hasSupportAttachedToMixedImplementationRoots,
} from "./consolidation-shape.js";
import {
  emitClusterMergeResolutionEvent,
  emitFinalizePlannedGroupsEvent,
  emitRepartitionAfterConsolidationEvent,
} from "./events.js";
import { mergeCommitClusters } from "./merge.js";
import { harmonizeConsolidatedMessages } from "./message-harmonization.js";
import { describeError, emitPlannerFallbackEvent } from "./stage.js";

const MIN_CONSOLIDATION_TAIL_GROUP_COUNT = 5;

export interface ClusterMergeResult {
  rawMerged: PlannedCommit[];
  stabilized: PlannedCommit[];
}

export function finalizeStabilizedGroups(
  inputGroupCount: number,
  premergedGroupCount: number,
  repartitionedGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  startedAtMs: number,
): PlannedCommit[] {
  emitRepartitionAfterConsolidationEvent(
    premergedGroupCount,
    repartitionedGroups.length,
    startedAtMs,
  );

  const ordered = orderCommitsByDependencies(repartitionedGroups, fileSignals);
  const stabilized = absorbIncidentalAdjacentGroups(ordered, fileByPath);
  if (stabilized.length < ordered.length) {
    emitAiOutputEvent({
      content: JSON.stringify({
        decision: "incidental-follow-up-merge",
        inputGroupCount: ordered.length,
        outputGroupCount: stabilized.length,
      }),
      durationMs: performance.now() - startedAtMs,
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });
  }

  emitFinalizePlannedGroupsEvent({
    diagnostics: {
      absorbedGroupCount: ordered.length - stabilized.length,
      dependencyOrderedGroupCount: ordered.length,
    },
    finalGroups: stabilized,
    inputGroupCount,
    premergedGroupCount,
    repartitionedGroups,
  });

  return stabilized;
}

export function finalizeWithoutConsolidation(
  groups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
  inputGroupCount: number,
  startedAtMs: number,
): PlannedCommit[] {
  const ordered = orderCommitsByDependencies(groups, fileSignals);
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "skip-consolidation",
      finalGroupCount: ordered.length,
      inputGroupCount,
      reason: "no-potential-merge-signals",
    }),
    durationMs: performance.now() - startedAtMs,
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
  return ordered;
}

export function hasValidConsolidationCoverage(
  groups: PlannedCommit[],

  consolidated: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): boolean {
  return !getCoverageMismatchDiagnostics(groups, consolidated, fileByPath);
}

export function mergeClusterPass(
  current: PlannedCommit[],
  clusters: number[][],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
): ClusterMergeResult | null {
  // Reject any cluster that collapses too many unrelated groups in one step.
  // Very large clusters (8+) are almost always planner-wide umbrella families
  // that splitWeakConsolidations will have to mostly undo anyway.
  const MAX_SINGLE_CLUSTER_SIZE = 7;
  const sizeDiagnostics = getClusterSizeDiagnostics(
    current,
    clusters,
    MAX_SINGLE_CLUSTER_SIZE,
  );
  const oversizedClusterRejection = getOversizedClusterRejection(
    current.length,
    clusters.length,
    sizeDiagnostics,
    MAX_SINGLE_CLUSTER_SIZE,
  );
  if (oversizedClusterRejection) {
    emitRejectedClusterMergeResolution(...oversizedClusterRejection);
    return null;
  }

  const rawMerged = mergeCommitClusters(current, clusters, fileByPath);
  const rawMergeRejection = getRawMergeRejection(
    current,
    clusters.length,
    rawMerged,
    fileByPath,
    sizeDiagnostics.largestClusterSize,
  );
  if (rawMergeRejection) {
    emitRejectedClusterMergeResolution(...rawMergeRejection);
    return null;
  }

  const stabilized = splitWeakConsolidations(
    current,
    rawMerged,
    fileByPath,
    fileSignals,
  );
  emitAcceptedClusterMergeResolution(
    current.length,
    clusters.length,
    sizeDiagnostics.largestClusterSize,
    rawMerged.length,
    stabilized.length,
  );

  return {
    rawMerged,
    stabilized,
  };
}

export function readConsolidatedGroups(
  parsed: unknown,
  fileByPath: Map<string, FileDiff>,
  inputGroupCount: number,
  options: CommitMessageRuleOptions = {},
): null | PlannedCommit[] {
  try {
    return validateAndNormalizeGrouping(parsed, fileByPath, options);
  } catch (error: unknown) {
    emitPlannerFallbackEvent(
      "consolidation-fallback",
      "invalid-consolidation-response",
      "consolidate",
      {
        error: describeError(error),
        inputGroupCount,
      },
    );
    return null;
  }
}

export function resolveHarmonizedConsolidation(
  groups: PlannedCommit[],
  consolidated: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  startedAtMs: number,
  options: CommitMessageRuleOptions = {},
): null | PlannedCommit[] {
  const harmonized = harmonizeConsolidatedMessages(
    groups,
    consolidated,
    fileByPath,
    options,
  );
  const repartitioned = splitWeakConsolidations(
    groups,
    harmonized,
    fileByPath,
    fileSignals,
  );

  if (shouldRejectUnstableConsolidation(groups, harmonized, repartitioned)) {
    emitConsolidationResolution(
      "consolidation-stop",
      groups.length,
      harmonized.length,
      startedAtMs,
      {
        reason: "semantic-repartition-would-undo-merge",
        repartitionedGroupCount: repartitioned.length,
      },
    );
    return null;
  }
  if (repartitioned.length >= groups.length) {
    if (hasMeaningfulConsolidationChange(groups, repartitioned)) {
      emitConsolidationResolution(
        "consolidation-pass",
        groups.length,
        repartitioned.length,
        startedAtMs,
      );
      return repartitioned;
    }

    emitConsolidationResolution(
      "consolidation-noop",
      groups.length,
      repartitioned.length,
      startedAtMs,
      { reason: "no-meaningful-reduction" },
    );
    return null;
  }

  emitConsolidationResolution(
    "consolidation-pass",
    groups.length,
    repartitioned.length,
    startedAtMs,
  );
  return repartitioned;
}

export function shouldStopConsolidationPass(
  groups: PlannedCommit[],
  previousReduction: number,
): boolean {
  return (
    groups.length <= MIN_CONSOLIDATION_TAIL_GROUP_COUNT &&
    previousReduction <= 1 &&
    hasMostlyImplementationTail(groups)
  );
}

function emitAcceptedClusterMergeResolution(
  inputGroupCount: number,
  clusterCount: number,
  largestClusterSize: number,
  rawMergedGroupCount: number,
  stabilizedGroupCount: number,
): void {
  emitClusterMergeResolutionEvent({
    clusterCount,
    diagnostics: {
      rawMergedGroupCount,
      stabilizedGroupCount,
    },
    inputGroupCount,
    largestClusterSize,
    outputGroupCount: stabilizedGroupCount,
    reason: "cluster-merge-accepted",
    resolution: "accepted",
  });
}

function emitConsolidationResolution(
  decision: "consolidation-noop" | "consolidation-pass" | "consolidation-stop",
  inputGroupCount: number,
  outputGroupCount: number,
  startedAtMs: number,
  extra?: Record<string, number | string>,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision,
      inputGroupCount,
      outputGroupCount,
      ...extra,
    }),
    durationMs: performance.now() - startedAtMs,
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

function emitRejectedClusterMergeResolution(
  inputGroupCount: number,
  clusterCount: number,
  largestClusterSize: number,
  reason: string,
  diagnostics: Record<string, number>,
  outputGroupCount?: number,
): void {
  emitClusterMergeResolutionEvent({
    clusterCount,
    diagnostics,
    inputGroupCount,
    largestClusterSize,
    outputGroupCount,
    reason,
    resolution: "rejected",
  });
}

function getOversizedClusterRejection(
  currentLength: number,
  clusterCount: number,
  sizeDiagnostics: ReturnType<typeof getClusterSizeDiagnostics>,
  maxSingleClusterSize: number,
): [number, number, number, string, Record<string, number>, number?] | null {
  if (!sizeDiagnostics.hasOversizedNonStyleCluster) {
    return null;
  }

  return [
    currentLength,
    clusterCount,
    sizeDiagnostics.largestClusterSize,
    "oversized-non-style-cluster",
    {
      maxSingleClusterSize,
      oversizedClusterCount: sizeDiagnostics.oversizedClusterCount,
    },
  ];
}

function getRawMergeRejection(
  current: PlannedCommit[],
  clusterCount: number,
  rawMerged: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  largestClusterSize: number,
): [number, number, number, string, Record<string, number>, number?] | null {
  if (!hasMatchingCoverage(current, rawMerged, fileByPath)) {
    return [
      current.length,
      clusterCount,
      largestClusterSize,
      "coverage-mismatch",
      { rawMergedGroupCount: rawMerged.length },
    ];
  }

  if (rawMerged.length >= current.length) {
    return [
      current.length,
      clusterCount,
      largestClusterSize,
      "no-group-count-reduction",
      { rawMergedGroupCount: rawMerged.length },
      rawMerged.length,
    ];
  }

  return null;
}

function shouldRejectUnstableConsolidation(
  inputGroups: PlannedCommit[],
  consolidatedGroups: PlannedCommit[],
  repartitionedGroups: PlannedCommit[],
): boolean {
  if (inputGroups.length < 4) {
    return false;
  }

  const consolidatedReduction = inputGroups.length - consolidatedGroups.length;
  const effectiveReduction = inputGroups.length - repartitionedGroups.length;

  // Reject when repartition undoes the consolidation almost entirely,
  // or when consolidation produced fewer commits than repartition deemed stable.
  if (
    consolidatedReduction >= 2 &&
    repartitionedGroups.length > consolidatedGroups.length &&
    effectiveReduction <= 1
  ) {
    return true;
  }

  if (
    consolidatedReduction >= 2 &&
    hasSupportAttachedToMixedImplementationRoots(repartitionedGroups)
  ) {
    return true;
  }

  // Also reject when repartition expands the consolidation by more than 30%:
  // this indicates the consolidation joined groups that should stay separate
  // and late repair is doing the majority of semantic cleanup.
  const expansionRatio =
    consolidatedGroups.length > 0
      ? repartitionedGroups.length / consolidatedGroups.length
      : 1;

  return (
    consolidatedReduction >= 3 &&
    expansionRatio >= 1.3 &&
    repartitionedGroups.length >= inputGroups.length
  );
}
