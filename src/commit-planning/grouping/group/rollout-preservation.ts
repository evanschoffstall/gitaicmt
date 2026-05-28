import type { PlannedCommit } from "../grouping-types.js";

import { evaluateFeatureSurfaceRollout } from "./feature-surface-heuristics.js";
import { emitRolloutPreservationEvent } from "./split-trace-events.js";

/**
 * Preserve a merged same-feature surface rollout when the work stays on direct
 * feature files and shallow sibling module surfaces instead of deep internals.
 */
export function shouldPreserveFeatureSurfaceRollout(
  group: PlannedCommit,
): boolean {
  const evaluation = evaluateFeatureSurfaceRollout(group);
  emitRolloutPreservationEvent({
    diagnostics: evaluation.diagnostics,
    group,
    reason: evaluation.reason,
    resolution: evaluation.shouldPreserve
      ? "preserve-rollout"
      : "split-rollout",
  });
  return evaluation.shouldPreserve;
}
