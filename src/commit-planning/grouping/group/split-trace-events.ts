import type { PlannedCommit } from "../grouping-types.js";

import { emitAiOutputEvent } from "../../openai-client.js";
import { summarizeTraceGroup } from "./events.js";

interface RolloutPreservationTraceEvent {
  diagnostics: Record<string, boolean | number | string>;
  group: PlannedCommit;
  reason: string;
  resolution: "preserve-rollout" | "split-rollout";
}

interface StructuralOwnerBucketTraceEvent {
  baseOwnerId: string;
  diagnostics: Record<string, boolean | number | string>;
  reason: string;
  resolution: "preserve-bucket" | "split-bucket";
}

interface StructuralOwnerSplitTraceEvent {
  diagnostics: Record<string, boolean | number | string>;
  group: PlannedCommit;
  outputGroups?: PlannedCommit[];
  reason: string;
  resolution: "preserve-group" | "split-group";
}

/** Emits branch diagnostics for feature-surface rollout preservation checks. */
export function emitRolloutPreservationEvent(
  event: RolloutPreservationTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "feature-surface-rollout",
      diagnostics: event.diagnostics,
      group: summarizeTraceGroup(event.group),
      reason: event.reason,
      resolution: event.resolution,
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

/** Emits one nested bucket evaluation while structural-owner splitting refines a group. */
export function emitStructuralOwnerBucketEvent(
  event: StructuralOwnerBucketTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      baseOwnerId: event.baseOwnerId,
      decision: "structural-owner-bucket-evaluation",
      diagnostics: event.diagnostics,
      reason: event.reason,
      resolution: event.resolution,
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

/** Emits the top-level structural-owner split outcome for one mixed-root group. */
export function emitStructuralOwnerSplitEvent(
  event: StructuralOwnerSplitTraceEvent,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "structural-owner-split",
      diagnostics: event.diagnostics,
      group: summarizeTraceGroup(event.group),
      outputGroups: event.outputGroups?.map((group) =>
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
