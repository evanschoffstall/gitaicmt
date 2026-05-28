import { type Config } from "../application/config/index.js";
import {
  CONSOLIDATION_RESPONSE_OVERHEAD_TOKENS,
  CONSOLIDATION_RESPONSE_SAFETY_FACTOR,
  GROUPING_BASE_TOKENS,
  MIN_CLUSTERING_TOKENS,
  MIN_COMMIT_MESSAGE_TOKENS,
  MIN_GROUPING_TOKENS,
  TOKENS_PER_CLUSTER_GROUP,
  TOKENS_PER_FILE,
} from "../application/constants.js";
import { estimatePlanOperationDetails } from "./estimation-planner.js";
import {
  buildMergePrompt,
  buildSystemPrompt,
  buildUserPrompt,
  type CommitMessageRuleOptions,
  type GroupingPromptContext,
} from "./prompts/index.js";

type DiffChunk = import("../git/diff.js").DiffChunk;
type DiffStats = import("../git/diff.js").DiffStats;
type FileDiff = import("../git/diff.js").FileDiff;
type PlannedCommit = import("./types.js").PlannedCommit;

const REQUEST_OVERHEAD_TOKENS = 24;
const CHARS_PER_TOKEN = 4;
const REQUEST_ESTIMATE_SAFETY_FACTOR = 1.12;

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenEstimateSummary {
  minimumRequestCount: number;
  minimumTotalTokens: number;
  peakRequestTokens: number;
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

export function estimateCompletionTokens(
  system: string,
  user: string,
  outputTokens: number,
): TokenEstimate {
  const inputTokens =
    estimateTextTokens(system) +
    estimateTextTokens(user) +
    REQUEST_OVERHEAD_TOKENS;

  return {
    inputTokens: Math.ceil(inputTokens * REQUEST_ESTIMATE_SAFETY_FACTOR),
    outputTokens,
    totalTokens:
      Math.ceil(inputTokens * REQUEST_ESTIMATE_SAFETY_FACTOR) + outputTokens,
  };
}

export function estimateGenerateOperationTokens(
  chunks: DiffChunk[],
  stats: DiffStats,
  cfg: Config,
  options: CommitMessageRuleOptions = {},
): TokenEstimateSummary {
  if (chunks.length === 0) {
    return emptySummary();
  }

  const requests = chunks.map((chunk) =>
    estimateCompletionTokens(
      buildSystemPrompt(options),
      buildUserPrompt(chunk, stats),
      cfg.openai.maxTokens,
    ),
  );

  if (chunks.length > 1) {
    requests.push(
      estimateCompletionTokens(
        buildSystemPrompt(options),
        buildMergePrompt(
          buildPlaceholderMessages(chunks.length),
          stats,
          options,
        ),
        cfg.openai.maxTokens,
      ),
    );
  }

  return summarizeRequests(requests);
}

export function estimatePlanOperationTokens(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  cfg: Config,
  promptContext?: GroupingPromptContext,
): TokenEstimateSummary {
  return estimatePlanOperationDetails(
    files,
    formatFileDiff,
    cfg,
    {
      emptySummary,
      estimateCompletionTokens,
      estimateTextTokens,
      getGroupingResponseTokenBudget,
      getPlannerResponseTokenBudget,
      summarizeRequests,
      withLowerBound,
    },
    promptContext,
  ).summary;
}

export function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return 0;
  }

  return Math.ceil(normalized.length / CHARS_PER_TOKEN);
}

export function getGroupingResponseTokenBudget(
  configuredMaxTokens: number,
  fileCount: number,
): number {
  return Math.max(
    configuredMaxTokens,
    Math.max(MIN_COMMIT_MESSAGE_TOKENS, GROUPING_BASE_TOKENS) +
      fileCount * TOKENS_PER_FILE,
    MIN_GROUPING_TOKENS,
  );
}

/**
 * Size planner-stage response budgets from their expected JSON payloads so
 * large cluster reviews and consolidation passes do not truncate mid-plan.
 */
export function getPlannerResponseTokenBudget(
  configuredMaxTokens: number,
  stage: "cluster" | "consolidate",
  groups: PlannedCommit[],
): number {
  if (stage === "cluster") {
    return Math.max(
      configuredMaxTokens,
      MIN_CLUSTERING_TOKENS,
      groups.length * TOKENS_PER_CLUSTER_GROUP,
    );
  }

  const serializedPlanTokens = estimateTextTokens(JSON.stringify(groups));

  return Math.max(
    configuredMaxTokens,
    MIN_GROUPING_TOKENS,
    Math.ceil(serializedPlanTokens * CONSOLIDATION_RESPONSE_SAFETY_FACTOR) +
      CONSOLIDATION_RESPONSE_OVERHEAD_TOKENS,
  );
}

function buildPlaceholderMessages(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    [
      `chore(batch): summarize part ${String(index + 1)}`,
      "",
      `- Summarize the staged changes from batch ${String(index + 1)}.`,
    ].join("\n"),
  );
}

function emptySummary(): TokenEstimateSummary {
  return {
    minimumRequestCount: 0,
    minimumTotalTokens: 0,
    peakRequestTokens: 0,
    requestCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
  };
}

function summarizeRequests(requests: TokenEstimate[]): TokenEstimateSummary {
  return requests.reduce(
    (summary, request) => ({
      minimumRequestCount: summary.minimumRequestCount + 1,
      minimumTotalTokens: summary.minimumTotalTokens + request.totalTokens,
      peakRequestTokens: Math.max(
        summary.peakRequestTokens,
        request.totalTokens,
      ),
      requestCount: summary.requestCount + 1,
      totalInputTokens: summary.totalInputTokens + request.inputTokens,
      totalOutputTokens: summary.totalOutputTokens + request.outputTokens,
      totalTokens: summary.totalTokens + request.totalTokens,
    }),
    emptySummary(),
  );
}

function withLowerBound(
  summary: TokenEstimateSummary,
  lowerBoundSummary: TokenEstimateSummary,
): TokenEstimateSummary {
  return {
    ...summary,
    minimumRequestCount: lowerBoundSummary.requestCount,
    minimumTotalTokens: lowerBoundSummary.totalTokens,
  };
}
