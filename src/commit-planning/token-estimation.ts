import { type Config } from "../application/config.js";
import {
    CLUSTERING_THRESHOLD,
    GROUPING_BASE_TOKENS,
  MAX_CONSOLIDATION_PASSES,
    MIN_COMMIT_MESSAGE_TOKENS,
    MIN_GROUPING_TOKENS,
    TOKENS_PER_FILE,
} from "../application/constants.js";
import {
    batchFilesForGrouping,
    batchingMakesProgress,
    shouldBatchFiles,
} from "./file-batching.js";
import {
    buildClusterSystemPrompt,
    buildClusterUserPrompt,
    buildConsolidationSystemPrompt,
    buildConsolidationUserPrompt,
    buildGroupingSystemPrompt,
    buildGroupingUserPrompt,
    buildMergePrompt,
    buildSystemPrompt,
    buildUserPrompt,
    type GroupingPromptContext,
} from "./prompt-builders/index.js";

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
  return estimatePlanOperationDetails(files, formatFileDiff, cfg, promptContext)
    .summary;
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

function buildPlaceholderPlanGroupsForEstimate(
  files: FileDiff[],
  estimatedGroupCount: number,
): PlannedCommit[] {
  if (estimatedGroupCount <= 1) {
    return [
      {
        files: files.map((file) => ({ path: file.path })),
        message:
          "chore(plan): summarize staged changes\n\n- Cover the staged changes coherently.",
      },
    ];
  }

  const groups: PlannedCommit[] = [];
  const size = Math.max(1, Math.ceil(files.length / estimatedGroupCount));

  for (let index = 0; index < files.length; index += size) {
    const batch = files.slice(index, index + size);
    groups.push({
      files: batch.map((file) => ({ path: file.path })),
      message: [
        `feat(plan): change ${String(groups.length + 1)}`,
        "",
        `- Cover the staged files grouped into change ${String(groups.length + 1)}.`,
      ].join("\n"),
    });
  }

  return groups;
}

function combineSummaries(
  summaries: TokenEstimateSummary[],
): TokenEstimateSummary {
  return summaries.reduce<TokenEstimateSummary>(
    (combined, summary) => ({
      minimumRequestCount:
        combined.minimumRequestCount + summary.minimumRequestCount,
      minimumTotalTokens:
        combined.minimumTotalTokens + summary.minimumTotalTokens,
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
    minimumRequestCount: 0,
    minimumTotalTokens: 0,
    peakRequestTokens: 0,
    requestCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
  };
}

function estimateLikelyConsolidationPassCount(groupCount: number): number {
  let remainingGroups = groupCount;
  let passCount = 0;

  while (remainingGroups > 2) {
    passCount++;
    remainingGroups = Math.max(1, Math.ceil(remainingGroups / 2));
  }

  const bufferedPassCount = groupCount >= 5 ? passCount + 1 : passCount;
  return Math.min(bufferedPassCount, MAX_CONSOLIDATION_PASSES);
}

function estimateLikelyPlanGroupCount(files: FileDiff[]): number {
  if (files.length <= 1) {
    return 1;
  }

  const multiHunkFiles = files.filter((file) => file.hunks.length > 1).length;
  const areaCount = new Set(files.map((file) => getTopLevelArea(file.path)))
    .size;
  const complexityScore =
    files.length + multiHunkFiles + Math.max(0, areaCount - 1);

  return Math.max(2, Math.min(files.length, Math.ceil(complexityScore / 3)));
}

function estimatePlanFollowUpSummaries(
  files: FileDiff[],
  estimatedGroupCount: number,
  cfg: Config,
): TokenEstimateSummary[] {
  if (estimatedGroupCount <= 1) {
    return [];
  }

  const summaries: TokenEstimateSummary[] = [];
  let currentGroups = buildPlaceholderPlanGroupsForEstimate(
    files,
    estimatedGroupCount,
  );

  if (currentGroups.length >= CLUSTERING_THRESHOLD) {
    summaries.push(
      summarizeRequests([
        estimateCompletionTokens(
          buildClusterSystemPrompt(),
          buildClusterUserPrompt(currentGroups),
          cfg.openai.maxTokens,
        ),
      ]),
    );
    currentGroups = buildPlaceholderPlanGroupsForEstimate(
      files,
      Math.max(2, Math.ceil(currentGroups.length / 2)),
    );
  }

  for (
    let pass = 0;
    pass < estimateLikelyConsolidationPassCount(currentGroups.length);
    pass++
  ) {
    summaries.push(
      summarizeRequests([
        estimateCompletionTokens(
          buildConsolidationSystemPrompt(),
          buildConsolidationUserPrompt(files, currentGroups),
          cfg.openai.maxTokens,
        ),
      ]),
    );

    currentGroups = buildPlaceholderPlanGroupsForEstimate(
      files,
      Math.max(1, Math.ceil(currentGroups.length / 2)),
    );
  }

  return summaries;
}

function estimatePlanOperationDetails(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  cfg: Config,
  promptContext?: GroupingPromptContext,
  includeFollowUpEstimates = true,
): { estimatedGroupCount: number; summary: TokenEstimateSummary } {
  if (files.length === 0) {
    return { estimatedGroupCount: 0, summary: emptySummary() };
  }

  if (files.length === 1 && files[0].hunks.length <= 1) {
    const content = formatFileDiff(files[0]);
    return {
      estimatedGroupCount: 1,
      summary: summarizeRequests([
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
      ]),
    };
  }

  if (files.length > 1 && shouldBatchFiles(files)) {
    const batches = batchFilesForGrouping(files);
    if (batchingMakesProgress(files, batches)) {
      const allFiles = promptContext?.allFiles ?? files;
      const batchDetails = batches.map((batch, batchIndex) =>
        estimatePlanOperationDetails(
          batch,
          formatFileDiff,
          cfg,
          {
            allFiles,
            batchCount: batches.length,
            batchIndex,
            deferFinalization: true,
          },
          false,
        ),
      );

      const estimatedGroupCount = batchDetails.reduce(
        (total, detail) => total + detail.estimatedGroupCount,
        0,
      );
      const lowerBoundSummary = combineSummaries(
        batchDetails.map((detail) => detail.summary),
      );
      const summaries = [lowerBoundSummary];
      if (includeFollowUpEstimates) {
        summaries.push(
          ...estimatePlanFollowUpSummaries(allFiles, estimatedGroupCount, cfg),
        );
      }

      const summary = combineSummaries(summaries);

      return {
        estimatedGroupCount,
        summary: withLowerBound(summary, lowerBoundSummary),
      };
    }
  }

  const groupingTokens = getGroupingResponseTokenBudget(
    cfg.openai.maxTokens,
    files.length,
  );

  const estimatedGroupCount = estimateLikelyPlanGroupCount(files);
  const lowerBoundSummary = summarizeRequests([
    estimateCompletionTokens(
      buildGroupingSystemPrompt(),
      buildGroupingUserPrompt(files, formatFileDiff, promptContext),
      groupingTokens,
    ),
  ]);
  const followUpSummaries =
    includeFollowUpEstimates
      ? estimatePlanFollowUpSummaries(files, estimatedGroupCount, cfg)
      : [];
  const summary = combineSummaries([lowerBoundSummary, ...followUpSummaries]);

  return {
    estimatedGroupCount,
    summary: withLowerBound(summary, lowerBoundSummary),
  };
}

function getTopLevelArea(path: string): string {
  const [head, tail] = path.split("/");
  return tail ? head : "(root)";
}

function summarizeRequests(requests: TokenEstimate[]): TokenEstimateSummary {
  return requests.reduce<TokenEstimateSummary>(
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
