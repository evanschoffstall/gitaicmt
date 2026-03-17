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
import {
  applyCommitClusters,
  mergeCommitMessages,
  prioritizeMergedCommits,
} from "./commit-merge.js";
import { orderCommitsByDependencies } from "./dependency-ordering.js";
import { buildFileChangeSignals } from "./file-signals.js";
import {
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
  try {
    const raw = await complete(buildClusterSystemPrompt(), buildClusterUserPrompt(groups), {
      stage: "cluster",
    });
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");
    const parsed = JSON.parse(cleaned) as unknown;

    if (!Array.isArray(parsed)) {
      return null;
    }

    const seen = new Set<number>();
    for (const cluster of parsed) {
      if (!Array.isArray(cluster)) {
        return null;
      }
      for (const index of cluster) {
        if (typeof index !== "number" || index < 0 || index >= groups.length) {
          return null;
        }
        if (seen.has(index)) {
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
  } catch {
    return null;
  }
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

    const merged = applyCommitClusters(current, clusters, fileByPath);
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

async function consolidateOnce(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): Promise<null | PlannedCommit[]> {
  try {
    const startedAtMs = performance.now();
    const raw = await complete(
      buildConsolidationSystemPrompt(),
      buildConsolidationUserPrompt(allFiles, groups),
      { stage: "consolidate" },
    );
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");
    const parsed = JSON.parse(cleaned) as unknown;
    const consolidated = validateAndNormalizeGrouping(parsed, fileByPath);

    if (!hasMatchingCoverage(groups, consolidated, fileByPath)) {
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
  } catch {
    return null;
  }
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
