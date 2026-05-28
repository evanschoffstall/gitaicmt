import type { FileDiff, PlannedCommit } from "../grouping-types.js";

import { emitAiOutputEvent } from "../../openai-client.js";
import { getCoverageMismatchDiagnostics } from "../commit-coverage.js";
import { emitPlannerFallbackEvent } from "./stage.js";

interface ClusterMergeResult {
  rawMerged: PlannedCommit[];
  stabilized: PlannedCommit[];
}

const TRACE_GROUP_FILE_PREVIEW_LIMIT = 6;

interface AdjacentAbsorptionTraceEvent {
  candidateGroup: PlannedCommit;
  diagnostics: Record<string, boolean | number | string>;
  mergedGroup: PlannedCommit;
  previousGroup: PlannedCommit;
  reason: "adjacent-follow-up" | "support-pair";
}

interface ClusterMergeResolutionTraceEvent {
  clusterCount: number;
  diagnostics: Record<string, boolean | number | string>;
  inputGroupCount: number;
  largestClusterSize: number;
  outputGroupCount?: number;
  reason: string;
  resolution: "accepted" | "rejected";
}

interface FinalizePlannedGroupsTraceEvent {
  diagnostics: Record<string, boolean | number | string>;
  finalGroups: PlannedCommit[];
  inputGroupCount: number;
  premergedGroupCount: number;
  repartitionedGroups: PlannedCommit[];
}

interface MessageHarmonizationTraceEvent {
  diagnostics: Record<string, boolean | number | string>;
  inputGroup: PlannedCommit;
  operation: "harmonize-covered" | "harmonize-uncovered" | "rescope-covered";
  outputGroup: PlannedCommit;
  reason: string;
  resolution: "preserve-message" | "rewrite-message" | "rewrite-subject-only";
}

interface NormalizationTraceEvent {
  inputGroup: PlannedCommit;
  normalizationKind: string;
  outputGroups?: PlannedCommit[];
  reason?: string;
  resolution: "preserve" | "split";
}

interface PremergePairEvaluationTraceEvent {
  diagnostics: Record<string, boolean | number | string>;
  leftGroup: PlannedCommit;
  matchedRules: string[];
  resolution: "keep-separate" | "merge";
  rightGroup: PlannedCommit;
}

interface PremergeSummaryTraceEvent {
  diagnostics: Record<string, boolean | number | string>;
  inputGroups: PlannedCommit[];
  outputGroups: PlannedCommit[];
  reason: string;
  resolution: "preserve-input" | "use-premerged";
}

interface RepartitionByIntentTraceEvent {
  componentCount?: number;
  diagnostics?: Record<string, boolean | number | string>;
  implementationGroupCount: number;
  inputGroupCount: number;
  outputGroupCount: number;
  resolution: string;
  supportAttachmentEnabled: boolean;
  supportGroupCount: number;
  usedOwnerSplit?: boolean;
}

interface SupportAttachmentBreadthPenaltyTraceEvent {
  diagnostics: Record<string, boolean | number | string>;
  penalty: number;
  supportGroup: PlannedCommit;
}

interface SupportAttachmentScoreTraceEvent {
  diagnostics: Record<string, boolean | number | string>;
  rejectionReason?: string;
  score: number;
  supportGroup: PlannedCommit;
  targetGroup: PlannedCommit;
}

type SupportAttachmentTraceEvent =
  | (SupportAttachmentBreadthPenaltyTraceEvent & { kind: "breadth-penalty" })
  | (SupportAttachmentScoreTraceEvent & { kind: "score" });

interface WeakConsolidationResolutionTraceEvent {
  coveredGroups: PlannedCommit[];
  diagnostics: Record<string, boolean | number | string>;
  inputGroup: PlannedCommit;
  outputGroups: PlannedCommit[];
  reason: string;
  resolution: string;
}

/** Emits one structured trace event for a successful adjacent-group merge. */
export function emitAdjacentAbsorptionEvent(
  event: AdjacentAbsorptionTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      candidateGroup: summarizeTraceGroup(event.candidateGroup),
      decision: "incidental-adjacent-merge",
      diagnostics: event.diagnostics,
      mergedGroup: summarizeTraceGroup(event.mergedGroup),
      previousGroup: summarizeTraceGroup(event.previousGroup),
      reason: event.reason,
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

/** Emits branch diagnostics for one evaluated cluster merge pass outcome. */
export function emitClusterMergeResolutionEvent(
  event: ClusterMergeResolutionTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      clusterCount: event.clusterCount,
      decision: "cluster-merge-resolution",
      diagnostics: event.diagnostics,
      inputGroupCount: event.inputGroupCount,
      largestClusterSize: event.largestClusterSize,
      outputGroupCount: event.outputGroupCount,
      reason: event.reason,
      resolution: event.resolution,
    }),
    kind: "planner-decision",
    stage: "cluster",
    transport: "internal",
  });
}

export function emitClusterProgressEvent(
  inputGroupCount: number,
  clusterCount: number,
  merged: ClusterMergeResult,
  passStartedAtMs: number,
  pass: number,
  stopped: boolean,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      clusterCount,
      decision: stopped ? "cluster-stop" : "cluster-pass",
      inputGroupCount,
      mergedGroupCount: stopped
        ? merged.rawMerged.length
        : merged.stabilized.length,
      pass,
      rawMergedGroupCount: stopped ? undefined : merged.rawMerged.length,
      reason: stopped ? "semantic-repartition-undid-merge" : undefined,
      repartitionedGroupCount: stopped
        ? merged.stabilized.length
        : merged.stabilized.length > merged.rawMerged.length
          ? merged.stabilized.length
          : undefined,
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

/** Emits the final consolidate-stage summary after stabilization completes. */
export function emitFinalizePlannedGroupsEvent(
  event: FinalizePlannedGroupsTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "finalize-planned-groups",
      diagnostics: event.diagnostics,
      finalGroupCount: event.finalGroups.length,
      finalGroups: event.finalGroups.map((group) => summarizeTraceGroup(group)),
      inputGroupCount: event.inputGroupCount,
      premergedGroupCount: event.premergedGroupCount,
      repartitionedGroupCount: event.repartitionedGroups.length,
      repartitionedGroups: event.repartitionedGroups.map((group) =>
        summarizeTraceGroup(group),
      ),
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

/** Emits detailed branch diagnostics for message harmonization decisions. */
export function emitMessageHarmonizationEvent(
  event: MessageHarmonizationTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "message-harmonization",
      diagnostics: event.diagnostics,
      inputGroup: summarizeTraceGroup(event.inputGroup),
      operation: event.operation,
      outputGroup: summarizeTraceGroup(event.outputGroup),
      reason: event.reason,
      resolution: event.resolution,
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

export function emitNormalizationEvent(event: NormalizationTraceEvent): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision:
        event.resolution === "preserve"
          ? "normalization-preserve"
          : "normalization-split",
      group:
        event.resolution === "preserve"
          ? summarizeTraceGroup(event.inputGroup)
          : undefined,
      inputGroup:
        event.resolution === "split"
          ? summarizeTraceGroup(event.inputGroup)
          : undefined,
      normalizationKind: event.normalizationKind,
      outputGroups: event.outputGroups?.map((group) =>
        summarizeTraceGroup(group),
      ),
      reason: event.reason,
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

/** Emits rule-by-rule diagnostics for one deterministic premerge pair. */
export function emitPremergePairEvaluationEvent(
  event: PremergePairEvaluationTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "premerge-pair-evaluation",
      diagnostics: event.diagnostics,
      leftGroup: summarizeTraceGroup(event.leftGroup),
      matchedRules: event.matchedRules,
      resolution: event.resolution,
      rightGroup: summarizeTraceGroup(event.rightGroup),
    }),
    kind: "planner-decision",
    stage: "group",
    transport: "internal",
  });
}

/** Emits the overall deterministic premerge outcome before AI stages run. */
export function emitPremergeSummaryEvent(
  event: PremergeSummaryTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "premerge-by-subject",
      diagnostics: event.diagnostics,
      inputGroupCount: event.inputGroups.length,
      inputGroups: event.inputGroups.map((group) => summarizeTraceGroup(group)),
      outputGroupCount: event.outputGroups.length,
      outputGroups: event.outputGroups.map((group) =>
        summarizeTraceGroup(group),
      ),
      reason: event.reason,
      resolution: event.resolution,
    }),
    kind: "planner-decision",
    stage: "group",
    transport: "internal",
  });
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

/** Emits one structured trace event describing a repartition-by-intent pass. */
export function emitRepartitionByIntentEvent(
  event: RepartitionByIntentTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      componentCount: event.componentCount,
      decision: "repartition-by-intent",
      diagnostics: event.diagnostics,
      implementationGroupCount: event.implementationGroupCount,
      inputGroupCount: event.inputGroupCount,
      outputGroupCount: event.outputGroupCount,
      resolution: event.resolution,
      supportAttachmentEnabled: event.supportAttachmentEnabled,
      supportGroupCount: event.supportGroupCount,
      usedOwnerSplit: event.usedOwnerSplit,
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

/** Emits one structured trace event for breadth-penalty evaluation. */
export function emitSupportAttachmentTraceEvent(
  event: SupportAttachmentTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision:
        event.kind === "breadth-penalty"
          ? "support-attachment-breadth-penalty"
          : "support-attachment-score",
      diagnostics: event.diagnostics,
      penalty: event.kind === "breadth-penalty" ? event.penalty : undefined,
      rejectionReason:
        event.kind === "score" ? event.rejectionReason : undefined,
      score: event.kind === "score" ? event.score : undefined,
      supportGroup: summarizeTraceGroup(event.supportGroup),
      targetGroup:
        event.kind === "score"
          ? summarizeTraceGroup(event.targetGroup)
          : undefined,
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

/** Emits detailed branch diagnostics for one weak-consolidation resolution. */
export function emitWeakConsolidationResolutionEvent(
  event: WeakConsolidationResolutionTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      coveredGroupCount: event.coveredGroups.length,
      coveredGroups: event.coveredGroups.map((group) =>
        summarizeTraceGroup(group),
      ),
      decision: "weak-consolidation-resolution",
      diagnostics: event.diagnostics,
      inputGroup: summarizeTraceGroup(event.inputGroup),
      outputGroupCount: event.outputGroups.length,
      outputGroups: event.outputGroups.map((group) =>
        summarizeTraceGroup(group),
      ),
      reason: event.reason,
      resolution: event.resolution,
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

export function summarizeTraceGroup(group: PlannedCommit): {
  fileCount: number;
  filePreview: string[];
  subject: string;
  truncatedFileCount?: number;
} {
  const filePreview = group.files
    .slice(0, TRACE_GROUP_FILE_PREVIEW_LIMIT)
    .map((file) => file.path);
  const truncatedFileCount = group.files.length - filePreview.length;

  return {
    fileCount: group.files.length,
    filePreview,
    subject: group.message.split("\n")[0] ?? group.message,
    truncatedFileCount: truncatedFileCount > 0 ? truncatedFileCount : undefined,
  };
}
