import {
  CLUSTERING_THRESHOLD,
  MAX_CLUSTER_PASSES,
  MAX_CONSOLIDATION_PASSES,
} from "../../application/constants.js";
import { complete, emitAiOutputEvent } from "../openai-client.js";
import {
  buildClusterSystemPrompt,
  buildClusterUserPrompt,
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
} from "../prompt-builders/index.js";
import { validateAndNormalizeGrouping } from "../response-validation.js";
import {
  groupCoversGroup,
  hasMatchingCoverage,
} from "./commit-coverage.js";
import { orderCommitsByDependencies } from "./dependency-ordering.js";
import { buildFileChangeSignals } from "./file-signals.js";
import {
  mergeCommitClusters,
  mergeCommitMessages,
  prioritizeMergedCommits,
} from "./group-merge.js";
import {
  type FileChangeSignals,
  type FileDiff,
  type PlannedCommit,
} from "./grouping-types.js";
import { splitWeakConsolidations } from "./repartition.js";
import {
  hasPotentialMergeSignals,
  isSupportLikeType,
  parseSubjectWords,
} from "./subject-analysis.js";
import { premergeBySubject } from "./subject-premerge.js";

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
    const ordered = orderCommitsByDependencies(current, fileSignals);
    emitAiOutputEvent({
      content: JSON.stringify({
        decision: "skip-consolidation",
        finalGroupCount: ordered.length,
        inputGroupCount: groups.length,
        reason: "no-potential-merge-signals",
      }),
      durationMs: performance.now() - startedAtMs,
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });
    return ordered;
  }

  current = await clusterAndMerge(current, fileByPath);

  for (
    let pass = 0;
    pass < MAX_CONSOLIDATION_PASSES && current.length > 1;
    pass++
  ) {
    if (!hasPotentialMergeSignals(current)) {
      break;
    }

    const previousLength = current.length;
    const consolidated = await consolidateOnce(allFiles, current, fileByPath);
    if (!consolidated) {
      break;
    }

    current = consolidated;
    if (consolidated.length >= previousLength || consolidated.length <= 2) {
      break;
    }
  }

  current = splitWeakConsolidations(
    baselineGroups,
    current,
    fileByPath,
    fileSignals,
  );

  const ordered = orderCommitsByDependencies(current, fileSignals);
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "finalize-planned-groups",
      finalGroupCount: ordered.length,
      inputGroupCount: groups.length,
      premergedGroupCount: baselineGroups.length,
    }),
    durationMs: performance.now() - startedAtMs,
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });

  return ordered;
}

async function callCluster(groups: PlannedCommit[]): Promise<null | number[][]> {
  const result = await completePlannerStage(
    buildClusterUserPrompt(groups),
    "cluster",
    buildClusterSystemPrompt(),
    groups.length,
  );
  if (result === null) {
    return null;
  }
  const parsed = result.parsed;

  if (!Array.isArray(parsed)) {
    emitPlannerFallbackEvent("cluster-fallback", "invalid-cluster-shape", "cluster", {
      inputGroupCount: groups.length,
    });
    return null;
  }

  const seen = new Set<number>();
  for (const cluster of parsed) {
    if (!Array.isArray(cluster)) {
      emitPlannerFallbackEvent("cluster-fallback", "invalid-cluster-entry", "cluster", {
        inputGroupCount: groups.length,
      });
      return null;
    }
    for (const index of cluster) {
      if (typeof index !== "number" || index < 0 || index >= groups.length) {
        emitPlannerFallbackEvent("cluster-fallback", "cluster-index-out-of-range", "cluster", {
          inputGroupCount: groups.length,
        });
        return null;
      }
      if (seen.has(index)) {
        emitPlannerFallbackEvent("cluster-fallback", "duplicate-cluster-index", "cluster", {
          inputGroupCount: groups.length,
        });
        return null;
      }
      seen.add(index);
    }
  }

  const clusters = parsed as number[][];
  for (let index = 0; index < groups.length; index++) {
    if (!seen.has(index)) {
      clusters.push([index]);
    }
  }

  return clusters.some((cluster) => cluster.length > 1) ? clusters : null;
}

async function clusterAndMerge(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
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
    const clusters = await callCluster(current);
    if (!clusters) {
      break;
    }

    const merged = mergeCommitClusters(current, clusters, fileByPath);
    if (!hasMatchingCoverage(current, merged, fileByPath)) {
      break;
    }
    if (merged.length >= current.length) {
      break;
    }

    emitAiOutputEvent({
      content: JSON.stringify({
        clusterCount: clusters.length,
        decision: "cluster-pass",
        inputGroupCount: current.length,
        mergedGroupCount: merged.length,
        pass: pass + 1,
      }),
      durationMs: performance.now() - passStartedAtMs,
      kind: "planner-decision",
      stage: "cluster",
      transport: "internal",
    });

    current = merged;
  }

  return current;
}

async function completePlannerStage(
  input: string,
  stage: "cluster" | "consolidate",
  system: string,
  inputGroupCount: number,
): Promise<null | { parsed: unknown }> {
  let raw: string;
  try {
    raw = await complete(system, input, { stage });
  } catch (error: unknown) {
    emitPlannerFallbackEvent(
      `${stage === "cluster" ? "cluster" : "consolidation"}-fallback`,
      `${stage === "cluster" ? "cluster" : "consolidation"}-call-failed`,
      stage,
      {
        error: describeError(error),
        inputGroupCount,
      },
    );
    return null;
  }

  const cleaned = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```$/m, "");

  try {
    return { parsed: JSON.parse(cleaned) as unknown };
  } catch (error: unknown) {
    emitPlannerFallbackEvent(
      `${stage === "cluster" ? "cluster" : "consolidation"}-fallback`,
      `invalid-${stage === "cluster" ? "cluster" : "consolidation"}-json`,
      stage,
      {
        error: describeError(error),
        inputGroupCount,
      },
    );
    return null;
  }
}

async function consolidateOnce(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): Promise<null | PlannedCommit[]> {
  const startedAtMs = performance.now();
  const result = await completePlannerStage(
    buildConsolidationUserPrompt(allFiles, groups),
    "consolidate",
    buildConsolidationSystemPrompt(),
    groups.length,
  );
  if (result === null) {
    return null;
  }
  const parsed = result.parsed;

  let consolidated: PlannedCommit[];
  try {
    consolidated = validateAndNormalizeGrouping(parsed, fileByPath);
  } catch (error: unknown) {
    emitPlannerFallbackEvent(
      "consolidation-fallback",
      "invalid-consolidation-response",
      "consolidate",
      {
        error: describeError(error),
        inputGroupCount: groups.length,
      },
    );
    return null;
  }

  if (!hasMatchingCoverage(groups, consolidated, fileByPath)) {
    emitPlannerFallbackEvent(
      "consolidation-fallback",
      "coverage-mismatch",
      "consolidate",
      {
        inputGroupCount: groups.length,
        outputGroupCount: consolidated.length,
      },
    );
    return null;
  }

  const harmonized = harmonizeConsolidatedMessages(
    groups,
    consolidated,
    fileByPath,
  );
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "consolidation-pass",
      inputGroupCount: groups.length,
      outputGroupCount: harmonized.length,
    }),
    durationMs: performance.now() - startedAtMs,
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
  return harmonized;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitPlannerFallbackEvent(
  decision: string,
  reason: string,
  stage: "cluster" | "consolidate",
  extra: Record<string, number | string>,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision,
      reason,
      ...extra,
    }),
    kind: "planner-decision",
    stage,
    transport: "internal",
  });
}

function harmonizeConsolidatedMessages(
  originalGroups: PlannedCommit[],
  consolidatedGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  return consolidatedGroups.map((group) => {
    const coveredGroups = originalGroups.filter((original) =>
      groupCoversGroup(group, original, fileByPath),
    );

    if (coveredGroups.length <= 1) {
      return group;
    }

    const consolidatedSubject = parseSubjectWords(
      group.message.split("\n")[0] ?? "",
    );
    const strongestCovered = prioritizeMergedCommits(coveredGroups)[0];
    const strongestCoveredSubject = parseSubjectWords(
      strongestCovered.message.split("\n")[0] ?? "",
    );

    if (
      consolidatedSubject.type !== "test" ||
      strongestCoveredSubject.type === "" ||
      isSupportLikeType(strongestCoveredSubject.type)
    ) {
      return group;
    }

    return {
      ...group,
      message: mergeCommitMessages([
        { ...group, files: coveredGroups.flatMap((commit) => commit.files) },
        ...coveredGroups,
      ]),
    };
  });
}
