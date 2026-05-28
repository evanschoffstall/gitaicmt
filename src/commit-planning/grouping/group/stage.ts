import type { PlannedCommit } from "../grouping-types.js";

import { loadConfig } from "../../../application/config/index.js";
import { GROUPING_TIMEOUT_MS } from "../../../application/constants.js";
import {
  OpenAIError,
  OpenAITimeoutError,
} from "../../../application/errors.js";
import { complete, emitAiOutputEvent } from "../../openai-client.js";
import {
  estimateTextTokens,
  getPlannerResponseTokenBudget,
} from "../../token-estimation.js";

const MAX_PLANNER_CALL_ATTEMPTS = 2;
const MAX_PLANNER_REVIEW_TIMEOUT_MS = 120_000;
const PLANNER_RETRY_TIMEOUT_MULTIPLIER = 1.5;
const PLANNER_TIMEOUT_PER_1K_TOKENS_MS = 4_000;

/**
 * Runs the clustering stage and normalizes the returned cluster indexes into
 * a complete non-overlapping cluster list.
 */
export async function callCluster(
  groups: PlannedCommit[],
  buildUserPrompt: (groups: PlannedCommit[]) => string,
  buildSystemPrompt: () => string,
): Promise<null | number[][]> {
  const result = await completePlannerStage(
    buildUserPrompt(groups),
    "cluster",
    buildSystemPrompt(),
    groups,
  );
  if (result === null) {
    return null;
  }

  return normalizeClusters(result.parsed, groups.length);
}

/** Executes one planner stage request and parses the raw JSON payload. */
export async function completePlannerStage(
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
      if (shouldRetryPlannerCall(failedAttemptCount, error)) {
        emitPlannerRetryEvent(
          stage,
          inputGroupCount,
          failedAttemptCount,
          error,
        );
        continue;
      }

      emitPlannerFailure(stage, failedAttemptCount, inputGroupCount, error);
      throw toPlannerStageError(stage, failedAttemptCount, error);
    }
  }

  if (raw === null) {
    throw toPlannerStageError(stage, MAX_PLANNER_CALL_ATTEMPTS, lastError);
  }

  return parsePlannerStageResponse(raw, stage, inputGroupCount);
}

/** Converts unknown planner failures into a stable trace string. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Emits a structured internal planner decision event for fallback handling. */
export function emitPlannerFallbackEvent(
  decision: string,
  reason: string,
  stage: "cluster" | "consolidate",
  extra: Record<string, number | string | string[]>,
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

function emitPlannerFailure(
  stage: "cluster" | "consolidate",
  failedAttemptCount: number,
  inputGroupCount: number,
  error: unknown,
): void {
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

function normalizeClusters(parsed: unknown, groupCount: number): null | number[][] {
  if (!Array.isArray(parsed)) {
    emitPlannerFallbackEvent("cluster-fallback", "invalid-cluster-shape", "cluster", {
      inputGroupCount: groupCount,
    });
    return null;
  }

  const seen = new Set<number>();
  for (const cluster of parsed) {
    if (!recordClusterIndexes(cluster, groupCount, seen)) {
      return null;
    }
  }

  const clusters = parsed as number[][];
  for (let index = 0; index < groupCount; index++) {
    if (!seen.has(index)) {
      clusters.push([index]);
    }
  }

  return clusters.some((cluster) => cluster.length > 1) ? clusters : null;
}

function parsePlannerStageResponse(
  raw: string,
  stage: "cluster" | "consolidate",
  inputGroupCount: number,
): null | { parsed: unknown } {
  try {
    return { parsed: JSON.parse(stripJsonFences(raw)) as unknown };
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

function recordClusterIndexes(
  cluster: unknown,
  groupCount: number,
  seen: Set<number>,
): boolean {
  if (!Array.isArray(cluster)) {
    emitPlannerFallbackEvent("cluster-fallback", "invalid-cluster-entry", "cluster", {
      inputGroupCount: groupCount,
    });
    return false;
  }

  for (const index of cluster) {
    if (typeof index !== "number" || index < 0 || index >= groupCount) {
      emitPlannerFallbackEvent("cluster-fallback", "cluster-index-out-of-range", "cluster", {
        inputGroupCount: groupCount,
      });
      return false;
    }
    if (seen.has(index)) {
      emitPlannerFallbackEvent("cluster-fallback", "duplicate-cluster-index", "cluster", {
        inputGroupCount: groupCount,
      });
      return false;
    }
    seen.add(index);
  }

  return true;
}

function shouldRetryPlannerCall(
  failedAttemptCount: number,
  error: unknown,
): boolean {
  return (
    failedAttemptCount < MAX_PLANNER_CALL_ATTEMPTS &&
    isRetryablePlannerError(error)
  );
}

function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "");
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
