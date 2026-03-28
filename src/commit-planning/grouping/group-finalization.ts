import { loadConfig } from "../../application/config.js";
import {
  CLUSTERING_THRESHOLD,
  GROUPING_TIMEOUT_MS,
  MAX_CLUSTER_PASSES,
  MAX_CONSOLIDATION_PASSES,
} from "../../application/constants.js";
import {
  OpenAIError,
  OpenAITimeoutError,
} from "../../application/errors.js";
import { complete, emitAiOutputEvent } from "../openai-client.js";
import {
  buildClusterSystemPrompt,
  buildClusterUserPrompt,
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
} from "../prompt-builders/index.js";
import { validateAndNormalizeGrouping } from "../response-validation.js";
import {
  estimateTextTokens,
  getPlannerResponseTokenBudget,
} from "../token-estimation.js";
import {
  groupCoversGroup,
  groupsSharePaths,
 hasMatchingCoverage } from "./commit-coverage.js";
import { orderCommitsByDependencies } from "./dependency-ordering.js";
import { buildFileChangeSignals } from "./file-signals.js";
import {
  mergeCommitClusters,
  mergeCommitMessages,
  mergeCommitsIntoGroup,
  prioritizeMergedCommits,
} from "./group-merge.js";
import {
  type FileChangeSignals,
  type FileDiff,
  type PlannedCommit,
} from "./grouping-types.js";
import { splitWeakConsolidations } from "./repartition.js";
import {
  countSharedSubjectWords,
  hasPotentialMergeSignals,
  isSupportLikeType,
  parseSubjectWords,
  scopesRelated,
} from "./subject-analysis.js";
import { premergeBySubject } from "./subject-premerge.js";

const MAX_PLANNER_CALL_ATTEMPTS = 2;
const MIN_CONSOLIDATION_TAIL_GROUP_COUNT = 5;
const MAX_PLANNER_REVIEW_TIMEOUT_MS = 120_000;
const PLANNER_RETRY_TIMEOUT_MULTIPLIER = 1.5;
const PLANNER_TIMEOUT_PER_1K_TOKENS_MS = 4_000;

/**
 * Absorbs adjacent tiny follow-up commits into the prior broader change when
 * they touch the same surface and read like incidental cleanup.
 */
export function absorbIncidentalAdjacentGroups(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const absorbed: PlannedCommit[] = [];

  for (const group of groups) {
    const previous = absorbed.at(-1);
    if (previous && shouldAbsorbAdjacentGroup(previous, group)) {
      absorbed[absorbed.length - 1] = mergeCommitsIntoGroup(
        [previous, group],
        fileByPath,
      );
      continue;
    }

    absorbed.push(group);
  }

  return absorbed;
}

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

  current = await clusterAndMerge(current, fileByPath, fileSignals);
  let previousReduction = Number.POSITIVE_INFINITY;

  for (
    let pass = 0;
    pass < MAX_CONSOLIDATION_PASSES && current.length > 1;
    pass++
  ) {
    if (!hasPotentialMergeSignals(current)) {
      break;
    }
    if (
      current.length <= MIN_CONSOLIDATION_TAIL_GROUP_COUNT &&
      previousReduction <= 1 &&
      hasMostlyImplementationTail(current)
    ) {
      emitAiOutputEvent({
        content: JSON.stringify({
          decision: "consolidation-stop",
          inputGroupCount: current.length,
          previousReduction,
          reason: "diminishing-returns",
        }),
        durationMs: performance.now() - startedAtMs,
        kind: "planner-decision",
        stage: "consolidate",
        transport: "internal",
      });
      break;
    }

    const previousLength = current.length;
    const consolidated = await consolidateOnce(
      allFiles,
      current,
      fileByPath,
      fileSignals,
    );
    if (!consolidated) {
      break;
    }

    previousReduction = previousLength - consolidated.length;
    current = consolidated;
    if (previousReduction <= 0 || consolidated.length <= 2) {
      break;
    }
  }

  current = splitWeakConsolidations(
    baselineGroups,
    current,
    fileByPath,
    fileSignals,
  );

  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "repartition-after-consolidation",
      outputGroupCount: current.length,
      premergedGroupCount: baselineGroups.length,
    }),
    durationMs: performance.now() - startedAtMs,
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });

  const ordered = orderCommitsByDependencies(current, fileSignals);
  const stabilized = absorbIncidentalAdjacentGroups(ordered, fileByPath);
  if (stabilized.length < ordered.length) {
    emitAiOutputEvent({
      content: JSON.stringify({
        decision: "incidental-follow-up-merge",
        inputGroupCount: ordered.length,
        outputGroupCount: stabilized.length,
      }),
      durationMs: performance.now() - startedAtMs,
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });
  }
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "finalize-planned-groups",
      finalGroupCount: stabilized.length,
      inputGroupCount: groups.length,
      premergedGroupCount: baselineGroups.length,
      repartitionedGroupCount: current.length,
    }),
    durationMs: performance.now() - startedAtMs,
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });

  return stabilized;
}

async function callCluster(groups: PlannedCommit[]): Promise<null | number[][]> {
  const result = await completePlannerStage(
    buildClusterUserPrompt(groups),
    "cluster",
    buildClusterSystemPrompt(),
    groups,
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

    const stabilized = splitWeakConsolidations(
      current,
      merged,
      fileByPath,
      fileSignals,
    );
    if (stabilized.length >= current.length) {
      emitAiOutputEvent({
        content: JSON.stringify({
          clusterCount: clusters.length,
          decision: "cluster-stop",
          inputGroupCount: current.length,
          mergedGroupCount: merged.length,
          pass: pass + 1,
          reason: "semantic-repartition-undid-merge",
          repartitionedGroupCount: stabilized.length,
        }),
        durationMs: performance.now() - passStartedAtMs,
        kind: "planner-decision",
        stage: "cluster",
        transport: "internal",
      });
      break;
    }

    emitAiOutputEvent({
      content: JSON.stringify({
        clusterCount: clusters.length,
        decision: "cluster-pass",
        inputGroupCount: current.length,
        mergedGroupCount: stabilized.length,
        pass: pass + 1,
        rawMergedGroupCount: merged.length,
        repartitionedGroupCount:
          stabilized.length > merged.length ? stabilized.length : undefined,
      }),
      durationMs: performance.now() - passStartedAtMs,
      kind: "planner-decision",
      stage: "cluster",
      transport: "internal",
    });

    current = stabilized;
  }

  return current;
}

async function completePlannerStage(
  input: string,
  stage: "cluster" | "consolidate",
  system: string,
  groups: PlannedCommit[],
): Promise<null | { parsed: unknown }> {
  const cfg = loadConfig();
  const inputGroupCount = groups.length;
  const maxTokens = getPlannerResponseTokenBudget(
    cfg.openai.maxTokens,
    stage,
    groups,
  );
  let raw: null | string = null;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_PLANNER_CALL_ATTEMPTS; attempt++) {
    try {
      raw = await complete(system, input, {
        maxTokens,
        stage,
        timeoutMs: getPlannerReviewTimeoutMs(stage, system, input, attempt),
      });
      break;
    } catch (error: unknown) {
      lastError = error;
      const failedAttemptCount = attempt + 1;
      if (
        failedAttemptCount < MAX_PLANNER_CALL_ATTEMPTS &&
        isRetryablePlannerError(error)
      ) {
        emitPlannerRetryEvent(stage, inputGroupCount, failedAttemptCount, error);
        continue;
      }

      emitPlannerFallbackEvent(
        `${stage === "cluster" ? "cluster" : "consolidation"}-failed`,
        failedAttemptCount > 1
          ? "retry-exhausted-call-failed"
          : `${stage === "cluster" ? "cluster" : "consolidation"}-call-failed`,
        stage,
        {
          attemptCount: failedAttemptCount,
          error: describeError(error),
          inputGroupCount,
        },
      );
      throw toPlannerStageError(stage, failedAttemptCount, error);
    }
  }

  if (raw === null) {
    throw toPlannerStageError(stage, MAX_PLANNER_CALL_ATTEMPTS, lastError);
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
  fileSignals: Map<string, FileChangeSignals>,
): Promise<null | PlannedCommit[]> {
  const startedAtMs = performance.now();
  const result = await completePlannerStage(
    buildConsolidationUserPrompt(allFiles, groups),
    "consolidate",
    buildConsolidationSystemPrompt(),
    groups,
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
  const repartitioned = splitWeakConsolidations(
    groups,
    harmonized,
    fileByPath,
    fileSignals,
  );

  if (shouldRejectUnstableConsolidation(groups, harmonized, repartitioned)) {
    emitAiOutputEvent({
      content: JSON.stringify({
        decision: "consolidation-stop",
        inputGroupCount: groups.length,
        outputGroupCount: harmonized.length,
        reason: "semantic-repartition-would-undo-merge",
        repartitionedGroupCount: repartitioned.length,
      }),
      durationMs: performance.now() - startedAtMs,
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });
    return null;
  }

  if (harmonized.length >= groups.length) {
    emitAiOutputEvent({
      content: JSON.stringify({
        decision: "consolidation-noop",
        inputGroupCount: groups.length,
        outputGroupCount: harmonized.length,
        reason: "no-meaningful-reduction",
      }),
      durationMs: performance.now() - startedAtMs,
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });
    return null;
  }

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

function countMessageDetailBullets(message: string): number {
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ")).length;
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

function emitPlannerRetryEvent(
  stage: "cluster" | "consolidate",
  inputGroupCount: number,
  failedAttemptCount: number,
  error: unknown,
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: `${stage === "cluster" ? "cluster" : "consolidation"}-retry-scheduled`,
      error: describeError(error),
      failedAttemptCount,
      inputGroupCount,
      maxAttemptCount: MAX_PLANNER_CALL_ATTEMPTS,
      nextAction: "retry",
      reason: "transient-call-failure",
    }),
    kind: "planner-decision",
    stage,
    transport: "internal",
  });
}

function getPlannerReviewTimeoutMs(
  stage: "cluster" | "consolidate",
  system: string,
  input: string,
  attempt: number,
): number {
  const cfg = loadConfig();
  const stageFloor = stage === "consolidate" ? 45_000 : GROUPING_TIMEOUT_MS;
  const promptTokens = estimateTextTokens(system) + estimateTextTokens(input);
  const promptBudgetMs =
    Math.ceil(promptTokens / 1000) * PLANNER_TIMEOUT_PER_1K_TOKENS_MS;
  const baseTimeout = Math.max(
    cfg.performance.timeoutMs,
    GROUPING_TIMEOUT_MS,
    stageFloor,
  );
  const scaledTimeout = baseTimeout + promptBudgetMs;
  const retryAdjustedTimeout =
    attempt === 0
      ? scaledTimeout
      : Math.ceil(scaledTimeout * PLANNER_RETRY_TIMEOUT_MULTIPLIER);
  return Math.min(MAX_PLANNER_REVIEW_TIMEOUT_MS, retryAdjustedTimeout);
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

function hasMostlyImplementationTail(groups: PlannedCommit[]): boolean {
  let supportLikeGroupCount = 0;

  for (const group of groups) {
    const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
    if (isSupportLikeType(subject.type)) {
      supportLikeGroupCount++;
    }
  }

  return supportLikeGroupCount <= 1;
}

function isRetryablePlannerError(error: unknown): boolean {
  if (error instanceof OpenAITimeoutError) {
    return true;
  }

  if (error instanceof OpenAIError) {
    const message = error.message.toLowerCase();
    return (
      message.includes("aborted") ||
      message.includes("timeout") ||
      message.includes("timed out")
    );
  }

  return false;
}

function isSingleSurfaceGroup(group: PlannedCommit): boolean {
  return (
    group.files.length === 1 &&
    group.files.every(
      (file) => !file.hunks || file.hunks.length <= 1,
    )
  );
}

function shouldAbsorbAdjacentGroup(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): boolean {
  if (!isSingleSurfaceGroup(candidate)) {
    return false;
  }

  const previousSubject = parseSubjectWords(previous.message.split("\n")[0] ?? "");
  const candidateSubject = parseSubjectWords(candidate.message.split("\n")[0] ?? "");
  if (isSupportLikeType(previousSubject.type)) {
    return false;
  }

  const sharedScope =
    previousSubject.scope.length > 0 &&
    candidateSubject.scope.length > 0 &&
    scopesRelated(previousSubject.scope, candidateSubject.scope);
  const sharedSubjectWords = countSharedSubjectWords(
    previousSubject.words,
    candidateSubject.words,
  );
  const sharedPaths = groupsSharePaths(previous, candidate);
  if (!sharedPaths && !sharedScope && sharedSubjectWords === 0) {
    return false;
  }

  const candidateDetailCount = countMessageDetailBullets(candidate.message);
  const previousDetailCount = countMessageDetailBullets(previous.message);
  const candidateSupportLike = isSupportLikeType(candidateSubject.type);
  const previousIsBroader =
    previous.files.length > candidate.files.length ||
    previousDetailCount > candidateDetailCount;

  return (
    previousIsBroader &&
    (candidateSupportLike || sharedPaths || (sharedScope && sharedSubjectWords > 0))
  );
}

function shouldRejectUnstableConsolidation(
  inputGroups: PlannedCommit[],
  consolidatedGroups: PlannedCommit[],
  repartitionedGroups: PlannedCommit[],
): boolean {
  if (inputGroups.length < 4) {
    return false;
  }

  const consolidatedReduction = inputGroups.length - consolidatedGroups.length;
  const effectiveReduction = inputGroups.length - repartitionedGroups.length;

  return (
    consolidatedReduction >= 2 &&
    repartitionedGroups.length > consolidatedGroups.length &&
    effectiveReduction <= 1
  );
}

function toPlannerStageError(
  stage: "cluster" | "consolidate",
  attemptCount: number,
  error: unknown,
): Error {
  if (error instanceof Error) {
    return error;
  }

  return new OpenAIError(
    `${stage === "cluster" ? "Cluster" : "Consolidation"} planner call failed after ${String(attemptCount)} attempt(s): ${String(error)}`,
  );
}
