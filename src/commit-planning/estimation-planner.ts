import {
  CLUSTERING_THRESHOLD,
} from "../application/constants.js";
import {
  batchFilesForGrouping,
  batchingMakesProgress,
  shouldBatchFiles,
} from "./file-batching.js";
import {
  buildPlaceholderPlanGroupsForEstimate,
  estimateLikelyConsolidationPassCount,
  estimateLikelyPlanGroupCount,
} from "./planner-heuristics.js";
import {
  buildClusterSystemPrompt,
  buildClusterUserPrompt,
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
  buildGroupingSystemPrompt,
  buildGroupingUserPrompt,
  type GroupingPromptContext,
} from "./prompt-builders/index.js";

type Config = import("../application/config/index.js").Config;
type FileDiff = import("../git/diff.js").FileDiff;
type PlannedCommit = import("./types.js").PlannedCommit;

interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface TokenEstimateSummary {
  minimumRequestCount: number;
  minimumTotalTokens: number;
  peakRequestTokens: number;
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

export function estimatePlanOperationDetails(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  cfg: Config,
  helpers: {
    emptySummary: () => TokenEstimateSummary;
    estimateCompletionTokens: (
      system: string,
      user: string,
      outputTokens: number,
    ) => TokenEstimate;
    estimateTextTokens: (text: string) => number;
    getGroupingResponseTokenBudget: (
      configuredMaxTokens: number,
      fileCount: number,
    ) => number;
    getPlannerResponseTokenBudget: (
      configuredMaxTokens: number,
      stage: "cluster" | "consolidate",
      groups: PlannedCommit[],
    ) => number;
    summarizeRequests: (requests: TokenEstimate[]) => TokenEstimateSummary;
    withLowerBound: (
      summary: TokenEstimateSummary,
      lowerBoundSummary: TokenEstimateSummary,
    ) => TokenEstimateSummary;
  },
  promptContext?: GroupingPromptContext,
  includeFollowUpEstimates = true,
): { estimatedGroupCount: number; summary: TokenEstimateSummary } {
  const trivialEstimate = estimateTrivialPlanDetails(files, formatFileDiff, cfg, helpers);
  if (trivialEstimate) {
    return trivialEstimate;
  }

  const batchedEstimate = estimateMaybeBatchedPlanDetails(
    files,
    formatFileDiff,
    cfg,
    helpers,
    promptContext,
    includeFollowUpEstimates,
  );
  if (batchedEstimate) {
    return batchedEstimate;
  }

  return estimateDirectPlanDetails(
    files,
    formatFileDiff,
    cfg,
    helpers,
    promptContext,
    includeFollowUpEstimates,
  );
}

function appendConsolidationFollowUps(
  currentGroups: PlannedCommit[],
  files: FileDiff[],
  cfg: Config,
  helpers: Parameters<typeof estimatePlanOperationDetails>[3],
  summaries: TokenEstimateSummary[],
): void {
  const passCount = estimateLikelyConsolidationPassCount(currentGroups.length);
  for (let pass = 0; pass < passCount; pass++) {
    summaries.push(
      helpers.summarizeRequests([
        helpers.estimateCompletionTokens(
          buildConsolidationSystemPrompt(),
          buildConsolidationUserPrompt(files, currentGroups),
          helpers.getPlannerResponseTokenBudget(
            cfg.openai.maxTokens,
            "consolidate",
            currentGroups,
          ),
        ),
      ]),
    );
    currentGroups = buildPlaceholderPlanGroupsForEstimate(
      files,
      Math.max(1, Math.ceil(currentGroups.length / 2)),
    );
    if (currentGroups.length <= 2) {
      break;
    }
  }
}

function combineSummaries(
  summaries: TokenEstimateSummary[],
  emptySummary: () => TokenEstimateSummary,
): TokenEstimateSummary {
  return summaries.reduce(
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

function estimateBatchedPlanDetails(
  batchContext: {
    batches: FileDiff[][];
    files: FileDiff[];
    promptContext: GroupingPromptContext | undefined;
  },
  formatFileDiff: (f: FileDiff) => string,
  cfg: Config,
  helpers: Parameters<typeof estimatePlanOperationDetails>[3],
  includeFollowUpEstimates: boolean,
): { estimatedGroupCount: number; summary: TokenEstimateSummary } {
  const allFiles = batchContext.promptContext?.allFiles ?? batchContext.files;
  const batchDetails = batchContext.batches.map((batch, batchIndex) =>
    estimatePlanOperationDetails(
      batch,
      formatFileDiff,
      cfg,
      helpers,
      {
        allFiles,
        batchCount: batchContext.batches.length,
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
    helpers.emptySummary,
  );
  const summaries = [lowerBoundSummary];
  if (includeFollowUpEstimates) {
    summaries.push(
      ...estimatePlanFollowUpSummaries(allFiles, estimatedGroupCount, cfg, helpers),
    );
  }

  return {
    estimatedGroupCount,
    summary: helpers.withLowerBound(
      combineSummaries(summaries, helpers.emptySummary),
      lowerBoundSummary,
    ),
  };
}

function estimateClusterFollowUp(
  currentGroups: PlannedCommit[],
  files: FileDiff[],
  cfg: Config,
  helpers: Parameters<typeof estimatePlanOperationDetails>[3],
  summaries: TokenEstimateSummary[],
): PlannedCommit[] {
  if (currentGroups.length < CLUSTERING_THRESHOLD) {
    return currentGroups;
  }

  summaries.push(
    helpers.summarizeRequests([
      helpers.estimateCompletionTokens(
        buildClusterSystemPrompt(),
        buildClusterUserPrompt(currentGroups),
        helpers.getPlannerResponseTokenBudget(
          cfg.openai.maxTokens,
          "cluster",
          currentGroups,
        ),
      ),
    ]),
  );

  return buildPlaceholderPlanGroupsForEstimate(
    files,
    Math.max(1, Math.ceil(currentGroups.length / 2)),
  );
}

function estimateDirectPlanDetails(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  cfg: Config,
  helpers: Parameters<typeof estimatePlanOperationDetails>[3],
  promptContext: GroupingPromptContext | undefined,
  includeFollowUpEstimates: boolean,
): { estimatedGroupCount: number; summary: TokenEstimateSummary } {
  const estimatedGroupCount = estimateLikelyPlanGroupCount(files);
  const lowerBoundSummary = helpers.summarizeRequests([
    helpers.estimateCompletionTokens(
      buildGroupingSystemPrompt(),
      buildGroupingUserPrompt(files, formatFileDiff, promptContext),
      helpers.getGroupingResponseTokenBudget(cfg.openai.maxTokens, files.length),
    ),
  ]);
  const summary = combineSummaries(
    [
      lowerBoundSummary,
      ...(includeFollowUpEstimates
        ? estimatePlanFollowUpSummaries(files, estimatedGroupCount, cfg, helpers)
        : []),
    ],
    helpers.emptySummary,
  );

  return {
    estimatedGroupCount,
    summary: helpers.withLowerBound(summary, lowerBoundSummary),
  };
}

function estimateMaybeBatchedPlanDetails(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  cfg: Config,
  helpers: Parameters<typeof estimatePlanOperationDetails>[3],
  promptContext: GroupingPromptContext | undefined,
  includeFollowUpEstimates: boolean,
): null | { estimatedGroupCount: number; summary: TokenEstimateSummary } {
  if (files.length <= 1 || !shouldBatchFiles(files)) {
    return null;
  }

  const batches = batchFilesForGrouping(files);
  if (!batchingMakesProgress(files, batches)) {
    return null;
  }

  return estimateBatchedPlanDetails(
    { batches, files, promptContext },
    formatFileDiff,
    cfg,
    helpers,
    includeFollowUpEstimates,
  );
}

function estimatePlanFollowUpSummaries(
  files: FileDiff[],
  estimatedGroupCount: number,
  cfg: Config,
  helpers: Parameters<typeof estimatePlanOperationDetails>[3],
): TokenEstimateSummary[] {
  if (estimatedGroupCount <= 1) {
    return [];
  }

  const summaries: TokenEstimateSummary[] = [];
  let currentGroups = buildPlaceholderPlanGroupsForEstimate(
    files,
    estimatedGroupCount,
  );

  currentGroups = estimateClusterFollowUp(currentGroups, files, cfg, helpers, summaries);
  appendConsolidationFollowUps(currentGroups, files, cfg, helpers, summaries);
  return summaries;
}

function estimateSingleFilePlanDetails(
  file: FileDiff,
  formatFileDiff: (f: FileDiff) => string,
  cfg: Config,
  helpers: Parameters<typeof estimatePlanOperationDetails>[3],
): { estimatedGroupCount: number; summary: TokenEstimateSummary } {
  return {
    estimatedGroupCount: 1,
    summary: helpers.summarizeRequests([
      helpers.estimateCompletionTokens(
        buildGroupingSystemPrompt(),
        buildGroupingUserPrompt([file], formatFileDiff),
        helpers.getGroupingResponseTokenBudget(cfg.openai.maxTokens, 1),
      ),
    ]),
  };
}

function estimateTrivialPlanDetails(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  cfg: Config,
  helpers: Parameters<typeof estimatePlanOperationDetails>[3],
): null | { estimatedGroupCount: number; summary: TokenEstimateSummary } {
  if (files.length === 0) {
    return { estimatedGroupCount: 0, summary: helpers.emptySummary() };
  }
  if (files.length === 1 && files[0].hunks.length <= 1) {
    return estimateSingleFilePlanDetails(files[0], formatFileDiff, cfg, helpers);
  }
  return null;
}