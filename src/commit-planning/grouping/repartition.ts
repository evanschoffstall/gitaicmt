import {
  evaluateCoveredBaselineFallback,
  shouldRestoreDistinctDirectFileBaseline,
} from "./baseline-restoration.js";
import {
  partitionGroupIndexes,
  repartitionByIntent,
} from "./component-routing.js";
import { emitWeakConsolidationResolutionEvent } from "./group/events.js";
import { mergeCommitsIntoGroup } from "./group/merge.js";
import { shouldPreserveFeatureSurfaceRollout } from "./group/rollout-preservation.js";
import {
  type FileChangeSignals,
  type FileDiff,
  type PlannedCommit,
} from "./grouping-types.js";
import {
  collapseSharedDescriptionStyleGroups,
  getDominantGroupOwner,
  mergeRepartitionComponents,
} from "./implementation-components.js";
import { getCoveredBaselineGroups } from "./merge-heuristics.js";
import { shouldPreserveDivergentSupportBaseline } from "./preservation-rules.js";
import { splitBroadStyleGroups } from "./style-splitting/index.js";
import {
  attachSupportIndexes,
  shouldSplitSupportGroupForAttachment,
} from "./support-attachment/component-attachment.js";
import {
  getPreservedWeakConsolidationGroups,
  type PreservedWeakConsolidationEvaluation,
} from "./weak-consolidation-preservation.js";

export { buildSplitSupportMessage } from "./support-attachment/component-attachment.js";

/**
 * Splits over-consolidated groups by re-grouping via intent affinity, then
 * re-attaches support commits to the closest implementation cluster.
 */
export function splitWeakConsolidations(
  baselineGroups: PlannedCommit[],
  consolidatedGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
): PlannedCommit[] {
  const result: PlannedCommit[] = [];

  for (const group of consolidatedGroups) {
    const coveredGroups = getCoveredBaselineGroups(
      baselineGroups,
      group,
      fileByPath,
    );
    const resolution = resolveWeakConsolidationGroup(
      group,
      coveredGroups,
      fileByPath,
      fileSignals,
    );
    emitWeakConsolidationResolutionEvent({
      coveredGroups,
      diagnostics: resolution.diagnostics,
      inputGroup: group,
      outputGroups: resolution.outputGroups,
      reason: resolution.reason,
      resolution: resolution.resolution,
    });
    result.push(...resolution.outputGroups);
  }

  return finalizeRepartitionedGroups(
    result,
    fileByPath,
    fileSignals,
    consolidatedGroups.length <= 2,
  );
}

function attachStandaloneSupportGroups(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  allowCompactSupportAttachment: boolean,
): PlannedCommit[] {
  const { implementationIndexes, supportIndexes } =
    partitionGroupIndexes(groups);
  const attachableSupportIndexes = allowCompactSupportAttachment
    ? supportIndexes
    : supportIndexes.filter((index) =>
        shouldSplitSupportGroupForAttachment(groups[index]),
      );
  if (
    implementationIndexes.length === 0 ||
    attachableSupportIndexes.length === 0
  ) {
    return groups;
  }

  const components = implementationIndexes.map((index) => [index]);
  attachSupportIndexes(
    groups,
    attachableSupportIndexes,
    components,
    fileSignals,
  );

  components.push(
    ...supportIndexes
      .filter((index) => !attachableSupportIndexes.includes(index))
      .map((index) => [index]),
  );

  return mergeRepartitionComponents(groups, components, fileByPath);
}

function buildFallbackResolutionDiagnostics(
  preservedDiagnostics: PreservedWeakConsolidationEvaluation["diagnostics"],
  coveredBaselineFallbackResolution: string,
  preserveShallowSurfaceRollout: boolean,
  repartitionedGroupCount: number,
  shouldRestoreDistinctDirectFileBaseline: boolean,
  fallbackDiagnostics: Record<string, boolean | number | string> = {},
): Record<string, boolean | number | string> {
  return {
    ...preservedDiagnostics,
    ...fallbackDiagnostics,
    coveredBaselineFallbackResolution,
    preserveShallowSurfaceRollout,
    repartitionedGroupCount,
    shouldRestoreDistinctDirectFileBaseline,
  };
}

function buildFallbackResolutionResult(input: {
  diagnostics: PreservedWeakConsolidationEvaluation["diagnostics"];
  fallbackDiagnostics?: Record<string, boolean | number | string>;
  outputGroups: PlannedCommit[];
  preserveShallowSurfaceRollout: boolean;
  reason: string;
  repartitionedGroupCount: number;
  resolution: string;
  shouldRestoreDistinctDirectFile: boolean;
}): {
  diagnostics: Record<string, boolean | number | string>;
  outputGroups: PlannedCommit[];
  reason: string;
  resolution: string;
} {
  return {
    diagnostics: buildFallbackResolutionDiagnostics(
      input.diagnostics,
      input.resolution,
      input.preserveShallowSurfaceRollout,
      input.repartitionedGroupCount,
      input.shouldRestoreDistinctDirectFile,
      input.fallbackDiagnostics,
    ),
    outputGroups: input.outputGroups,
    reason: input.reason,
    resolution: input.resolution,
  };
}

function finalizeRepartitionedGroups(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  allowCompactSupportAttachment: boolean,
): PlannedCommit[] {
  return splitBroadStyleGroups(
    collapseSharedDescriptionStyleGroups(
      attachStandaloneSupportGroups(
        groups,
        fileByPath,
        fileSignals,
        allowCompactSupportAttachment,
      ),
      fileByPath,
    ),
  );
}

function resolveFallbackWeakConsolidationGroup(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  repartitioned: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  preservedEvaluation: PreservedWeakConsolidationEvaluation,
): {
  diagnostics: Record<string, boolean | number | string>;
  outputGroups: PlannedCommit[];
  reason: string;
  resolution: string;
} {
  const preserveShallowSurfaceRollout = shouldPreserveFeatureSurfaceRollout(
    mergeCommitsIntoGroup(coveredGroups, fileByPath),
  );
  const shouldRestoreDistinctDirectFile =
    shouldRestoreDistinctDirectFileBaseline(group, coveredGroups);
  const fallbackResultBase = {
    diagnostics: preservedEvaluation.diagnostics,
    preserveShallowSurfaceRollout,
    repartitionedGroupCount: repartitioned.length,
    shouldRestoreDistinctDirectFile,
  };
  if (
    repartitioned.length <= 1 &&
    !preserveShallowSurfaceRollout &&
    shouldRestoreDistinctDirectFile
  ) {
    return buildFallbackResolutionResult({
      ...fallbackResultBase,
      outputGroups: coveredGroups,
      reason: "distinct-direct-file-baseline",
      resolution: "restore-covered-baseline",
    });
  }

  const coveredBaselineFallback = evaluateCoveredBaselineFallback(
    group,
    coveredGroups,
    repartitioned,
    preserveShallowSurfaceRollout,
    getDominantGroupOwner,
  );
  if (coveredBaselineFallback.groups !== null) {
    return buildFallbackResolutionResult({
      ...fallbackResultBase,
      fallbackDiagnostics: coveredBaselineFallback.diagnostics,
      outputGroups: coveredBaselineFallback.groups,
      reason: coveredBaselineFallback.reason,
      resolution: coveredBaselineFallback.resolution,
    });
  }

  return buildFallbackResolutionResult({
    ...fallbackResultBase,
    fallbackDiagnostics: coveredBaselineFallback.diagnostics,
    outputGroups: repartitioned,
    reason: "use-repartitioned",
    resolution: "use-repartitioned",
  });
}

function resolveWeakConsolidationGroup(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
): {
  diagnostics: Record<string, boolean | number | string>;
  outputGroups: PlannedCommit[];
  reason: string;
  resolution: string;
} {
  const preservedEvaluation = getPreservedWeakConsolidationGroups(
    group,
    coveredGroups,
    fileSignals,
  );
  if (preservedEvaluation.groups !== null) {
    return {
      diagnostics: preservedEvaluation.diagnostics,
      outputGroups: preservedEvaluation.groups,
      reason: preservedEvaluation.reason,
      resolution: preservedEvaluation.resolution,
    };
  }

  const repartitioned = repartitionByIntent(
    coveredGroups,
    fileByPath,
    fileSignals,
    shouldPreserveDivergentSupportBaseline,
  );
  return resolveFallbackWeakConsolidationGroup(
    group,
    coveredGroups,
    repartitioned,
    fileByPath,
    preservedEvaluation,
  );
}
