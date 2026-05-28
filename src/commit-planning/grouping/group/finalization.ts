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
  type CommitMessageRuleOptions,
} from "../../prompts/index.js";
import { getCoverageMismatchDiagnostics } from "../commit-coverage.js";
import { buildFileChangeSignals } from "../file/index.js";
import {
  type FileChangeSignals,
  type FileDiff,
  type PlannedCommit,
} from "../grouping-types.js";
import { splitWeakConsolidations } from "../repartition.js";
import { hasPotentialMergeSignals } from "../subject/analysis.js";
import { premergeBySubject } from "../subject/premerge/index.js";
import {
  emitCoverageMismatchPartialSalvage,
  salvageCoverageSafeConsolidation,
} from "./coverage-salvage.js";
import {
  emitClusterProgressEvent,
  emitConsolidationDiminishingReturnsStop,
  emitCoverageMismatchFallback,
} from "./events.js";
import {
  finalizeStabilizedGroups,
  finalizeWithoutConsolidation,
  hasValidConsolidationCoverage,
  mergeClusterPass,
  readConsolidatedGroups,
  resolveHarmonizedConsolidation,
  shouldStopConsolidationPass,
} from "./group-stability.js";
import {
  hasOnlyScopedSingleFileTestPairs,
  normalizeBroadSupportGroups,
  normalizeMixedRootImplementationGroups,
} from "./normalization.js";
import { callCluster, completePlannerStage } from "./stage.js";

/** Finalizes batched planner output into stable, coverage-safe commit groups. */
export async function finalizePlannedGroups(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
  options: CommitMessageRuleOptions = {},
): Promise<PlannedCommit[]> {
  if (groups.length < 2) {
    return groups;
  }

  const startedAtMs = performance.now();
  const fileByPath = new Map(allFiles.map((file) => [file.path, file]));
  const fileSignals = buildFileChangeSignals(allFiles);
  const baselineGroups = prepareBaselineGroups(groups, fileByPath);
  let current = baselineGroups;

  if (!hasPotentialMergeSignals(current)) {
    return finalizeWithoutConsolidation(
      current,
      fileSignals,
      groups.length,
      startedAtMs,
    );
  }

  current = await clusterAndMerge(
    current,
    fileByPath,
    fileSignals,
    groups.length,
  );
  if (
    current.length < baselineGroups.length &&
    hasOnlyScopedSingleFileTestPairs(current)
  ) {
    return finalizeStabilizedGroups(
      groups.length,
      baselineGroups.length,
      current,
      fileByPath,
      fileSignals,
      startedAtMs,
    );
  }
  current = await runConsolidationPasses(
    allFiles,
    current,
    fileByPath,
    fileSignals,
    startedAtMs,
    options,
  );
  return finalizeConsolidatedGroups(
    groups.length,
    baselineGroups,
    current,
    fileByPath,
    fileSignals,
    startedAtMs,
  );
}

async function clusterAndMerge(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  originalGroupCount: number,
): Promise<PlannedCommit[]> {
  let current = groups;

  for (
    let pass = 0;
    pass < MAX_CLUSTER_PASSES &&
    (current.length >= CLUSTERING_THRESHOLD ||
      (pass === 0 && originalGroupCount >= CLUSTERING_THRESHOLD)) &&
    (hasPotentialMergeSignals(current) ||
      (pass === 0 && originalGroupCount >= CLUSTERING_THRESHOLD));
    pass++
  ) {
    const next = await runClusterMergePass(
      current,
      fileByPath,
      fileSignals,
      pass,
    );
    if (next === null) {
      break;
    }
    current = next;
  }

  return current;
}

async function consolidateOnce(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  options: CommitMessageRuleOptions,
): Promise<null | PlannedCommit[]> {
  const startedAtMs = performance.now();
  const plannerResult = await completePlannerStage(
    buildConsolidationUserPrompt(allFiles, groups, options),
    "consolidate",
    buildConsolidationSystemPrompt(options),
    groups,
  );
  if (plannerResult === null) {
    return null;
  }
  const consolidated = readConsolidatedGroups(
    plannerResult.parsed,
    fileByPath,
    groups.length,
    options,
  );
  if (!consolidated) {
    return null;
  }

  if (!hasValidConsolidationCoverage(groups, consolidated, fileByPath)) {
    return resolveCoverageMismatchConsolidation(
      startedAtMs,
      groups,
      consolidated,
      fileByPath,
      fileSignals,
      options,
    );
  }

  const harmonized = harmonizeConsolidationResult(
    startedAtMs,
    groups,
    consolidated,
    fileByPath,
    fileSignals,
    options,
  );
  if (!harmonized) {
    return null;
  }
  return harmonized;
}

function finalizeConsolidatedGroups(
  inputGroupCount: number,
  baselineGroups: PlannedCommit[],
  current: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  startedAtMs: number,
): PlannedCommit[] {
  const repartitioned = splitWeakConsolidations(
    baselineGroups,
    current,
    fileByPath,
    fileSignals,
  );
  const renormalized = normalizeBroadSupportGroups(
    normalizeMixedRootImplementationGroups(
      repartitioned,
      baselineGroups,
      fileByPath,
    ),
    baselineGroups,
    fileByPath,
  );

  return finalizeStabilizedGroups(
    inputGroupCount,
    baselineGroups.length,
    renormalized,
    fileByPath,
    fileSignals,
    startedAtMs,
  );
}

function harmonizeConsolidationResult(
  startedAtMs: number,
  groups: PlannedCommit[],
  consolidated: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  options: CommitMessageRuleOptions,
): null | PlannedCommit[] {
  return resolveHarmonizedConsolidation(
    groups,
    consolidated,
    fileByPath,
    fileSignals,
    startedAtMs,
    options,
  );
}

function prepareBaselineGroups(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const premergedGroups = premergeBySubject(groups, fileByPath);

  return normalizeBroadSupportGroups(
    normalizeMixedRootImplementationGroups(premergedGroups, groups, fileByPath),
    groups,
    fileByPath,
  );
}

function resolveCoverageMismatchConsolidation(
  startedAtMs: number,
  groups: PlannedCommit[],
  consolidated: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  options: CommitMessageRuleOptions,
): null | PlannedCommit[] {
  const coverageMismatch = getCoverageMismatchDiagnostics(
    groups,
    consolidated,
    fileByPath,
  );
  const salvaged = salvageCoverageSafeConsolidation(
    groups,
    consolidated,
    fileByPath,
  );
  if (!coverageMismatch || !salvaged) {
    emitCoverageMismatchFallback(groups, consolidated, fileByPath);
    return null;
  }

  emitCoverageMismatchPartialSalvage(
    coverageMismatch,
    groups,
    consolidated,
    salvaged,
  );
  return harmonizeConsolidationResult(
    startedAtMs,
    groups,
    salvaged,
    fileByPath,
    fileSignals,
    options,
  );
}

async function runClusterMergePass(
  current: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  pass: number,
): Promise<null | PlannedCommit[]> {
  const passStartedAtMs = performance.now();
  const clusters = await callCluster(
    current,
    buildClusterUserPrompt,
    buildClusterSystemPrompt,
  );
  if (!clusters) {
    return null;
  }

  const merged = mergeClusterPass(current, clusters, fileByPath, fileSignals);
  if (!merged) {
    return null;
  }

  if (merged.stabilized.length >= current.length) {
    emitClusterProgressEvent(
      current.length,
      clusters.length,
      merged,
      passStartedAtMs,
      pass + 1,
      true,
    );
    return null;
  }

  emitClusterProgressEvent(
    current.length,
    clusters.length,
    merged,
    passStartedAtMs,
    pass + 1,
    false,
  );

  return merged.stabilized;
}

async function runConsolidationPasses(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  startedAtMs: number,
  options: CommitMessageRuleOptions,
): Promise<PlannedCommit[]> {
  let current = groups;
  let previousReduction = Number.POSITIVE_INFINITY;

  for (
    let pass = 0;
    pass < MAX_CONSOLIDATION_PASSES && current.length > 1;
    pass++
  ) {
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
      options,
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
