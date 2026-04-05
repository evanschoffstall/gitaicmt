import {
  CLUSTERING_THRESHOLD,
  MAX_CLUSTER_PASSES,
  MAX_CONSOLIDATION_PASSES,
} from "../../../application/constants.js";
import {
  buildClusterSystemPrompt,
  buildClusterUserPrompt,
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
} from "../../prompt-builders/index.js";
import { buildFileChangeSignals } from "../file-signals.js";
import {
  type FileChangeSignals,
  type FileDiff,
  type PlannedCommit,
} from "../grouping-types.js";
import { splitWeakConsolidations } from "../repartition.js";
import {
  hasPotentialMergeSignals,
} from "../subject/analysis.js";
import { premergeBySubject } from "../subject/premerge.js";
import {
  emitClusterPassEvent,
  emitClusterStopEvent,
  emitConsolidationDiminishingReturnsStop,
  emitCoverageMismatchFallback,
  finalizeStabilizedGroups,
  finalizeWithoutConsolidation,
  hasValidConsolidationCoverage,
  mergeClusterPass,
  readConsolidatedGroups,
  resolveHarmonizedConsolidation,
  shouldStopConsolidationPass,
} from "./group-stability.js";
import {
  callCluster,
  completePlannerStage,
} from "./planner-stage.js";

/** Finalizes batched planner output into stable, coverage-safe commit groups. */
export async function finalizePlannedGroups(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
): Promise<PlannedCommit[]> {
  if (groups.length < 2) {
    return groups;
  }

  const startedAtMs = performance.now();
  const fileByPath = new Map(allFiles.map((file) => [file.path, file]));
  const fileSignals = buildFileChangeSignals(allFiles);

  let current = premergeBySubject(groups, fileByPath);
  const baselineGroups = current;

  if (!hasPotentialMergeSignals(current)) {
    return finalizeWithoutConsolidation(
      current,
      fileSignals,
      groups.length,
      startedAtMs,
    );
  }

  current = await clusterAndMerge(current, fileByPath, fileSignals);
  current = await runConsolidationPasses(
    allFiles,
    current,
    fileByPath,
    fileSignals,
    startedAtMs,
  );
  const repartitioned = splitWeakConsolidations(
    baselineGroups,
    current,
    fileByPath,
    fileSignals,
  );

  return finalizeStabilizedGroups(
    groups.length,
    baselineGroups.length,
    repartitioned,
    fileByPath,
    fileSignals,
    startedAtMs,
  );
}

async function clusterAndMerge(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
): Promise<PlannedCommit[]> {
  let current = groups;

  for (
    let pass = 0;
    pass < MAX_CLUSTER_PASSES &&
    current.length >= CLUSTERING_THRESHOLD &&
    hasPotentialMergeSignals(current);
    pass++
  ) {
    const passStartedAtMs = performance.now();
    const clusters = await callCluster(
      current,
      buildClusterUserPrompt,
      buildClusterSystemPrompt,
    );
    if (!clusters) {
      break;
    }

    const merged = mergeClusterPass(current, clusters, fileByPath, fileSignals);
    if (!merged) {
      break;
    }

    if (merged.stabilized.length >= current.length) {
      emitClusterStopEvent(current.length, clusters.length, merged, passStartedAtMs, pass + 1);
      break;
    }

    emitClusterPassEvent(current.length, clusters.length, merged, passStartedAtMs, pass + 1);

    current = merged.stabilized;
  }

  return current;
}

async function consolidateOnce(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
): Promise<null | PlannedCommit[]> {
  const startedAtMs = performance.now();
  const plannerResult = await completePlannerStage(
    buildConsolidationUserPrompt(allFiles, groups),
    "consolidate",
    buildConsolidationSystemPrompt(),
    groups,
  );
  if (plannerResult === null) {
    return null;
  }
  const consolidated = readConsolidatedGroups(
    plannerResult.parsed,
    fileByPath,
    groups.length,
  );
  if (!consolidated) {
    return null;
  }

  if (!hasValidConsolidationCoverage(groups, consolidated, fileByPath)) {
    emitCoverageMismatchFallback(groups, consolidated, fileByPath);
    return null;
  }

  const harmonized = harmonizeConsolidationResult(
    startedAtMs,
    groups,
    consolidated,
    fileByPath,
    fileSignals,
  );
  if (!harmonized) {
    return null;
  }
  return harmonized;
}

function harmonizeConsolidationResult(
  startedAtMs: number,
  groups: PlannedCommit[],
  consolidated: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
): null | PlannedCommit[] {
  return resolveHarmonizedConsolidation(
    groups,
    consolidated,
    fileByPath,
    fileSignals,
    startedAtMs,
  );
}

async function runConsolidationPasses(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  startedAtMs: number,
): Promise<PlannedCommit[]> {
  let current = groups;
  let previousReduction = Number.POSITIVE_INFINITY;

  for (let pass = 0; pass < MAX_CONSOLIDATION_PASSES && current.length > 1; pass++) {
    if (!hasPotentialMergeSignals(current)) {
      break;
    }
    if (shouldStopConsolidationPass(current, previousReduction)) {
      emitConsolidationDiminishingReturnsStop(
        current.length,
        previousReduction,
        startedAtMs,
      );
      break;
    }

    const consolidated = await consolidateOnce(
      allFiles,
      current,
      fileByPath,
      fileSignals,
    );
    if (!consolidated) {
      break;
    }

    previousReduction = current.length - consolidated.length;
    current = consolidated;
    if (previousReduction <= 0 || consolidated.length <= 2) {
      break;
    }
  }

  return current;
}
