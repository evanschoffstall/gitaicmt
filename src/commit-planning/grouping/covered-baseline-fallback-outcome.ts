import type { PlannedCommit } from "./grouping-types.js";

export type CoveredBaselineFallbackDiagnostics = Record<
  string,
  boolean | number
> & {
  coveredGroupCount: number;
  hasCollapsedImplementationBundle: boolean;
  hasDominantMegaRepartitionedGroup: boolean;
  hasRestoreCoveredBaselineSignal: boolean;
  preserveShallowSurfaceRollout: boolean;
  repartitionedGroupCount: number;
  shouldPreserveIdenticalRepartitionedRollout: boolean;
};

export interface CoveredBaselineFallbackEvaluation {
  diagnostics: CoveredBaselineFallbackDiagnostics;
  groups: null | PlannedCommit[];
  reason:
    | "preserve-shallow-surface-rollout"
    | "repartition-collapsed-without-restore-signal"
    | "repartitioned-identical-rollout"
    | "restore-covered-baseline"
    | "use-repartitioned";
  resolution:
    | "preserve-consolidated"
    | "restore-covered-baseline"
    | "use-repartitioned";
}

export interface CoveredBaselineFallbackSignals {
  coveredGroupCount: number;
  hasCollapsedImplementationBundle: boolean;
  hasDominantMegaRepartitionedGroup: boolean;
  hasRestoreCoveredBaselineSignal: boolean;
  preserveShallowSurfaceRollout: boolean;
  repartitionedGroupCount: number;
  shouldPreserveIdenticalRepartitionedRollout: boolean;
}

export function buildCoveredBaselineFallbackDiagnostics(
  signals: CoveredBaselineFallbackSignals,
): CoveredBaselineFallbackDiagnostics {
  return {
    coveredGroupCount: signals.coveredGroupCount,
    hasCollapsedImplementationBundle: signals.hasCollapsedImplementationBundle,
    hasDominantMegaRepartitionedGroup:
      signals.hasDominantMegaRepartitionedGroup,
    hasRestoreCoveredBaselineSignal: signals.hasRestoreCoveredBaselineSignal,
    preserveShallowSurfaceRollout: signals.preserveShallowSurfaceRollout,
    repartitionedGroupCount: signals.repartitionedGroupCount,
    shouldPreserveIdenticalRepartitionedRollout:
      signals.shouldPreserveIdenticalRepartitionedRollout,
  };
}

export function getPreservedCoveredBaselineFallbackReason(
  signals: CoveredBaselineFallbackSignals,
): CoveredBaselineFallbackEvaluation["reason"] {
  if (signals.preserveShallowSurfaceRollout) {
    return "preserve-shallow-surface-rollout";
  }
  if (signals.shouldPreserveIdenticalRepartitionedRollout) {
    return "repartitioned-identical-rollout";
  }
  return "repartition-collapsed-without-restore-signal";
}
