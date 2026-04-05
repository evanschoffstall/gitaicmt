import { emitAiOutputEvent } from "../../openai-client.js";
import { validateAndNormalizeGrouping } from "../../response-validation.js";
import {
  getCoverageMismatchDiagnostics,
  hasMatchingCoverage,
} from "../commit-coverage.js";
import { orderCommitsByDependencies } from "../dependency-ordering.js";
import {
  type FileChangeSignals,
  type FileDiff,
  type PlannedCommit,
} from "../grouping-types.js";
import { splitWeakConsolidations } from "../repartition.js";
import {
  absorbIncidentalAdjacentGroups,
  hasMostlyImplementationTail,
} from "./adjacent-absorption.js";
import { mergeCommitClusters } from "./merge.js";
import { harmonizeConsolidatedMessages } from "./message-harmonization.js";
import {
  describeError,
  emitPlannerFallbackEvent,
} from "./planner-stage.js";

const MIN_CONSOLIDATION_TAIL_GROUP_COUNT = 5;

export interface ClusterMergeResult {
  rawMerged: PlannedCommit[];
  stabilized: PlannedCommit[];
}

export function emitClusterPassEvent(
  inputGroupCount: number,
  clusterCount: number,
  merged: ClusterMergeResult,
  passStartedAtMs: number,
  pass: number,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      clusterCount,
      decision: "cluster-pass",
      inputGroupCount,
      mergedGroupCount: merged.stabilized.length,
      pass,
      rawMergedGroupCount: merged.rawMerged.length,
      repartitionedGroupCount:
        merged.stabilized.length > merged.rawMerged.length
          ? merged.stabilized.length
          : undefined,
    }),
    durationMs: performance.now() - passStartedAtMs,
    kind: "planner-decision",
    stage: "cluster",
    transport: "internal",
  });
}

export function emitClusterStopEvent(
  inputGroupCount: number,
  clusterCount: number,
  merged: ClusterMergeResult,
  passStartedAtMs: number,
  pass: number,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      clusterCount,
      decision: "cluster-stop",
      inputGroupCount,
      mergedGroupCount: merged.rawMerged.length,
      pass,
      reason: "semantic-repartition-undid-merge",
      repartitionedGroupCount: merged.stabilized.length,
    }),
    durationMs: performance.now() - passStartedAtMs,
    kind: "planner-decision",
    stage: "cluster",
    transport: "internal",
  });
}

export function emitConsolidationDiminishingReturnsStop(
  currentLength: number,
  previousReduction: number,
  startedAtMs: number,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "consolidation-stop",
      inputGroupCount: currentLength,
      previousReduction,
      reason: "diminishing-returns",
    }),
    durationMs: performance.now() - startedAtMs,
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

export function emitCoverageMismatchFallback(
  groups: PlannedCommit[],
  consolidated: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): void {
  const coverageMismatch = getCoverageMismatchDiagnostics(
    groups,
    consolidated,
    fileByPath,
  );
  if (!coverageMismatch) {
    return;
  }

  emitPlannerFallbackEvent(
    "consolidation-fallback",
    "coverage-mismatch",
    "consolidate",
    {
      ...coverageMismatch,
      inputGroupCount: groups.length,
      outputGroupCount: consolidated.length,
    },
  );
}

export function emitRepartitionAfterConsolidationEvent(
  premergedGroupCount: number,
  outputGroupCount: number,
  startedAtMs: number,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "repartition-after-consolidation",
      outputGroupCount,
      premergedGroupCount,
    }),
    durationMs: performance.now() - startedAtMs,
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
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

  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "finalize-planned-groups",
      finalGroupCount: stabilized.length,
      inputGroupCount,
      premergedGroupCount,
      repartitionedGroupCount: repartitionedGroups.length,
    }),
    durationMs: performance.now() - startedAtMs,
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
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
  const rawMerged = mergeCommitClusters(current, clusters, fileByPath);
  if (!hasMatchingCoverage(current, rawMerged, fileByPath)) {
    return null;
  }
  if (rawMerged.length >= current.length) {
    return null;
  }

  return {
    rawMerged,
    stabilized: splitWeakConsolidations(
      current,
      rawMerged,
      fileByPath,
      fileSignals,
    ),
  };
}

export function readConsolidatedGroups(
  parsed: unknown,
  fileByPath: Map<string, FileDiff>,
  inputGroupCount: number,
): null | PlannedCommit[] {
  try {
    return validateAndNormalizeGrouping(parsed, fileByPath);
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
): null | PlannedCommit[] {
  const harmonized = harmonizeConsolidatedMessages(groups, consolidated, fileByPath);
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
  if (harmonized.length >= groups.length) {
    emitConsolidationResolution(
      "consolidation-noop",
      groups.length,
      harmonized.length,
      startedAtMs,
      { reason: "no-meaningful-reduction" },
    );
    return null;
  }

  emitConsolidationResolution(
    "consolidation-pass",
    groups.length,
    harmonized.length,
    startedAtMs,
  );
  return harmonized;
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

  return (
    consolidatedReduction >= 2 &&
    repartitionedGroups.length > consolidatedGroups.length &&
    effectiveReduction <= 1
  );
}