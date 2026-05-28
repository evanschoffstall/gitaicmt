import {
  type FileChangeSignals,
  type PlannedCommit,
} from "./grouping-types.js";
import {
  isDeepNestedInternalUmbrella,
  shouldPreserveCompactImplementationSupportRollout,
  shouldPreserveCompactSupportFamily,
  shouldPreserveImplementationLedChoreRollout,
  shouldPreserveScopedSingleTestRollout,
  shouldRestoreBroadTestCoverageBaseline,
} from "./preservation-rules.js";
import { shouldPreserveIdenticalRollout } from "./rollout-preservation.js";

export interface PreservedWeakConsolidationEvaluation {
  diagnostics: {
    coveredGroupCount: number;
    isDeepNestedInternalUmbrella: boolean;
    shouldPreserveCompactImplementationSupportRollout: boolean;
    shouldPreserveCompactSupportFamily: boolean;
    shouldPreserveIdenticalCoveredRollout: boolean;
    shouldPreserveImplementationLedChoreRollout: boolean;
    shouldPreserveScopedSingleTestRollout: boolean;
    shouldRestoreBroadTestCoverageBaseline: boolean;
  };
  groups: null | PlannedCommit[];
  reason:
    | "compact-implementation-support-rollout"
    | "compact-support-family"
    | "covered-group-count<=1"
    | "deep-nested-internal-umbrella"
    | "identical-covered-rollout"
    | "implementation-led-chore-rollout"
    | "restore-broad-test-coverage-baseline"
    | "scoped-single-test-rollout"
    | "use-repartition";
  resolution:
    | "preserve-consolidated"
    | "restore-covered-baseline"
    | "use-repartitioned";
}

/** Reads preservation rules before intent repartition decides how to split. */
export function getPreservedWeakConsolidationGroups(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
): PreservedWeakConsolidationEvaluation {
  if (coveredGroups.length <= 1) {
    return {
      diagnostics: buildPreservedWeakConsolidationDiagnostics({
        coveredGroupCount: coveredGroups.length,
      }),
      groups: [group],
      reason: "covered-group-count<=1",
      resolution: "preserve-consolidated",
    };
  }

  const diagnostics = collectPreservedWeakConsolidationDiagnostics(
    group,
    coveredGroups,
    fileSignals,
  );

  if (
    diagnostics.shouldRestoreBroadTestCoverageBaseline ||
    diagnostics.isDeepNestedInternalUmbrella
  ) {
    return {
      diagnostics,
      groups: coveredGroups,
      reason: diagnostics.shouldRestoreBroadTestCoverageBaseline
        ? "restore-broad-test-coverage-baseline"
        : "deep-nested-internal-umbrella",
      resolution: "restore-covered-baseline",
    };
  }

  const preservedReason = resolvePreservedWeakConsolidationReason(diagnostics);
  if (preservedReason !== null) {
    return {
      diagnostics,
      groups: [group],
      reason: preservedReason,
      resolution: "preserve-consolidated",
    };
  }

  return {
    diagnostics,
    groups: null,
    reason: "use-repartition",
    resolution: "use-repartitioned",
  };
}

function buildPreservedWeakConsolidationDiagnostics(
  diagnostics: Partial<PreservedWeakConsolidationEvaluation["diagnostics"]> & {
    coveredGroupCount: number;
  },
): PreservedWeakConsolidationEvaluation["diagnostics"] {
  return {
    coveredGroupCount: diagnostics.coveredGroupCount,
    isDeepNestedInternalUmbrella:
      diagnostics.isDeepNestedInternalUmbrella ?? false,
    shouldPreserveCompactImplementationSupportRollout:
      diagnostics.shouldPreserveCompactImplementationSupportRollout ?? false,
    shouldPreserveCompactSupportFamily:
      diagnostics.shouldPreserveCompactSupportFamily ?? false,
    shouldPreserveIdenticalCoveredRollout:
      diagnostics.shouldPreserveIdenticalCoveredRollout ?? false,
    shouldPreserveImplementationLedChoreRollout:
      diagnostics.shouldPreserveImplementationLedChoreRollout ?? false,
    shouldPreserveScopedSingleTestRollout:
      diagnostics.shouldPreserveScopedSingleTestRollout ?? false,
    shouldRestoreBroadTestCoverageBaseline:
      diagnostics.shouldRestoreBroadTestCoverageBaseline ?? false,
  };
}

function collectPreservedWeakConsolidationDiagnostics(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
): PreservedWeakConsolidationEvaluation["diagnostics"] {
  return buildPreservedWeakConsolidationDiagnostics({
    coveredGroupCount: coveredGroups.length,
    isDeepNestedInternalUmbrella: isDeepNestedInternalUmbrella(coveredGroups),
    shouldPreserveCompactImplementationSupportRollout:
      shouldPreserveCompactImplementationSupportRollout(group, coveredGroups),
    shouldPreserveCompactSupportFamily: shouldPreserveCompactSupportFamily(
      group,
      coveredGroups,
    ),
    shouldPreserveIdenticalCoveredRollout:
      shouldPreserveIdenticalRollout(coveredGroups),
    shouldPreserveImplementationLedChoreRollout:
      shouldPreserveImplementationLedChoreRollout(group, coveredGroups),
    shouldPreserveScopedSingleTestRollout:
      shouldPreserveScopedSingleTestRollout(group, coveredGroups, fileSignals),
    shouldRestoreBroadTestCoverageBaseline:
      shouldRestoreBroadTestCoverageBaseline(group, coveredGroups),
  });
}

function resolvePreservedWeakConsolidationReason(
  diagnostics: PreservedWeakConsolidationEvaluation["diagnostics"],
): null | PreservedWeakConsolidationEvaluation["reason"] {
  if (diagnostics.shouldPreserveCompactSupportFamily) {
    return "compact-support-family";
  }
  if (diagnostics.shouldPreserveScopedSingleTestRollout) {
    return "scoped-single-test-rollout";
  }
  if (diagnostics.shouldPreserveImplementationLedChoreRollout) {
    return "implementation-led-chore-rollout";
  }
  if (diagnostics.shouldPreserveCompactImplementationSupportRollout) {
    return "compact-implementation-support-rollout";
  }
  if (diagnostics.shouldPreserveIdenticalCoveredRollout) {
    return "identical-covered-rollout";
  }

  return null;
}
