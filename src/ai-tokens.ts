import {
  batchFilesForGrouping,
  batchingMakesProgress,
  shouldBatchFiles,
} from "./ai-batching.js";
import {
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
  buildGroupingSystemPrompt,
  buildGroupingUserPrompt,
  buildMergePrompt,
  buildSystemPrompt,
  buildUserPrompt,
  type GroupingPromptContext,
} from "./ai-prompt-builders.js";
import { type Config } from "./config.js";
import {
  GROUPING_BASE_TOKENS,
  MIN_COMMIT_MESSAGE_TOKENS,
  MIN_GROUPING_TOKENS,
  TOKENS_PER_FILE,
} from "./constants.js";

type DiffChunk = import("./diff.js").DiffChunk;
type DiffStats = import("./diff.js").DiffStats;
type FileDiff = import("./diff.js").FileDiff;
type PlannedCommit = import("./ai-types.js").PlannedCommit;

const REQUEST_OVERHEAD_TOKENS = 24;
const CHARS_PER_TOKEN = 4;

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenEstimateSummary {
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
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function estimateGenerateOperationTokens(
  chunks: DiffChunk[],
  stats: DiffStats,
  cfg: Config,
): TokenEstimateSummary {
  if (chunks.length === 0) {
    return emptySummary();
  }

  const requests = chunks.map((chunk) =>
    estimateCompletionTokens(
      buildSystemPrompt(),
      buildUserPrompt(chunk, stats),
      cfg.openai.maxTokens,
    ),
  );

  if (chunks.length > 1) {
    requests.push(
      estimateCompletionTokens(
        buildSystemPrompt(),
        buildMergePrompt(buildPlaceholderMessages(chunks.length), stats),
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
  if (files.length === 0) {
    return emptySummary();
  }

  if (files.length === 1 && files[0].hunks.length <= 1) {
    const content = formatFileDiff(files[0]);
    return summarizeRequests([
      estimateCompletionTokens(
        buildSystemPrompt(),
        buildUserPrompt(
          {
            content,
            files: [files[0].path],
            id: 0,
            lineCount: content.split("\n").length,
          },
          undefined,
        ),
        cfg.openai.maxTokens,
      ),
    ]);
  }

  if (files.length > 1 && shouldBatchFiles(files)) {
    const batches = batchFilesForGrouping(files);
    if (batchingMakesProgress(files, batches)) {
      const allFiles = promptContext?.allFiles ?? files;
      const batchSummaries = batches.map((batch, batchIndex) =>
        estimatePlanOperationTokens(batch, formatFileDiff, cfg, {
          allFiles,
          batchCount: batches.length,
          batchIndex,
        }),
      );

      const summaries = [...batchSummaries];
      if (batches.length > 1) {
        summaries.push(
          summarizeRequests([
            estimateCompletionTokens(
              buildConsolidationSystemPrompt(),
              buildConsolidationUserPrompt(
                allFiles,
                buildPlaceholderPlanGroups(batches),
              ),
              cfg.openai.maxTokens,
            ),
          ]),
        );
      }

      return combineSummaries(summaries);
    }
  }

  const groupingTokens = getGroupingResponseTokenBudget(
    cfg.openai.maxTokens,
    files.length,
  );

  return summarizeRequests([
    estimateCompletionTokens(
      buildGroupingSystemPrompt(),
      buildGroupingUserPrompt(files, formatFileDiff, promptContext),
      groupingTokens,
    ),
  ]);
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

function buildPlaceholderMessages(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    [
      `chore(batch): summarize part ${String(index + 1)}`,
      "",
      `- Summarize the staged changes from batch ${String(index + 1)}.`,
    ].join("\n"),
  );
}

function buildPlaceholderPlanGroups(batches: FileDiff[][]): PlannedCommit[] {
  return batches.map((batch, index) => ({
    files: batch.map((file) => ({ path: file.path })),
    message: [
      `chore(plan): batch ${String(index + 1)}`,
      "",
      `- Cover the staged changes grouped in batch ${String(index + 1)}.`,
    ].join("\n"),
  }));
}

function combineSummaries(
  summaries: TokenEstimateSummary[],
): TokenEstimateSummary {
  return summaries.reduce<TokenEstimateSummary>(
    (combined, summary) => ({
      peakRequestTokens: Math.max(
        combined.peakRequestTokens,
        summary.peakRequestTokens,
      ),
      requestCount: combined.requestCount + summary.requestCount,
      totalInputTokens: combined.totalInputTokens + summary.totalInputTokens,
      totalOutputTokens: combined.totalOutputTokens + summary.totalOutputTokens,
      totalTokens: combined.totalTokens + summary.totalTokens,
    }),
    emptySummary(),
  );
}

function emptySummary(): TokenEstimateSummary {
  return {
    peakRequestTokens: 0,
    requestCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
  };
}

function summarizeRequests(requests: TokenEstimate[]): TokenEstimateSummary {
  return requests.reduce<TokenEstimateSummary>(
    (summary, request) => ({
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
