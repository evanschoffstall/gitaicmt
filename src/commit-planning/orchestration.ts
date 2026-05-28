import { loadConfig } from "../application/config/index.js";
import {
  DEFAULT_EMPTY_COMMIT_MESSAGE,
  GROUPING_TIMEOUT_MS,
} from "../application/constants.js";
import { ValidationError } from "../application/errors.js";
import {
  formatLabeledDiff,
  suppressCommitMessageBreaking,
  validateCommitMessage,
} from "../commit-messages/formatting.js";
import {
  batchFilesForGrouping,
  batchingMakesProgress,
  shouldBatchFiles,
} from "./file-batching.js";
import { finalizePlannedGroups } from "./grouping/index.js";
import { complete, emitAiOutputEvent } from "./openai-client.js";
import {
  buildMissedFilesChunk,
  buildPlanCacheContext,
  collectMissedPlannedFiles,
  finalizePlannedCommitGroups,
  getEmittedCachedPlan,
  parseGroupingResponse,
  validatePlanRecursionDepth,
} from "./planning-workflow.js";
import {
  type BreakingChangeMode,
  buildGroupingSystemPrompt,
  buildGroupingUserPrompt,
  buildMergePrompt,
  buildSystemPrompt,
  buildUserPrompt,
  type GroupingPromptContext,
  resolveBreakingChangeMode,
} from "./prompts/index.js";
import { validateAndNormalizeGrouping } from "./response-validation.js";
import {
  getCachedMessage,
  setCachedMessage,
  setCachedPlan,
} from "./result-cache.js";
import { getGroupingResponseTokenBudget } from "./token-estimation.js";
import { type PlannedCommit, type PlannedCommitFile } from "./types.js";

interface CommitGenerationOptions {
  breakingMode?: BreakingChangeMode;
}
type DiffChunk = import("../git/diff.js").DiffChunk;
type DiffStats = import("../git/diff.js").DiffStats;

type FileDiff = import("../git/diff.js").FileDiff;

export {
  getTokenUsageByStage,
  getTokenUsageSummary,
  resetTokenUsageSummary,
  setAiOutputObserver,
  validateOpenAIConfiguration,
} from "./openai-client.js";
export type { AiOutputEvent } from "./openai-client.js";
export {
  getBundleFileDiffs,
  loadPlanBundle,
  preparePlanBundleForResume,
  savePlanBundle,
} from "./plan-bundles/index.js";
export {
  estimateGenerateOperationTokens,
  estimatePlanOperationTokens,
} from "./token-estimation.js";
export type { TokenEstimateSummary } from "./token-estimation.js";
export { buildGroupingSystemPrompt, buildGroupingUserPrompt };
export type { PlannedCommit, PlannedCommitFile };

export async function generateForChunk(
  chunk: DiffChunk,
  stats?: DiffStats,
  options: CommitGenerationOptions = {},
): Promise<string> {
  const breakingMode = resolveBreakingChangeMode(options);
  const promptMode =
    breakingMode === "sensitive"
      ? "breaking-sensitive"
      : breakingMode === "disabled"
        ? "no-breaking"
        : "default";
  const cached = getCachedMessage(chunk.content, promptMode);
  if (cached) {
    return cached;
  }

  const sys = buildSystemPrompt(options);
  const usr = buildUserPrompt(chunk, stats);
  const rawMessage = await complete(sys, usr, { stage: "generate" });
  const msg = validateCommitMessage(
    breakingMode === "disabled"
      ? suppressCommitMessageBreaking(rawMessage)
      : rawMessage,
  );
  setCachedMessage(chunk.content, msg, promptMode);
  return msg;
}

export async function generateForChunks(
  chunks: DiffChunk[],
  stats: DiffStats,
  options: CommitGenerationOptions = {},
): Promise<string> {
  const cfg = loadConfig();

  if (chunks.length === 0) return DEFAULT_EMPTY_COMMIT_MESSAGE;
  if (chunks.length === 1) return generateForChunk(chunks[0], stats, options);

  let partials: string[];
  if (cfg.performance.parallel) {
    partials = await Promise.all(
      chunks.map((chunk) => generateForChunk(chunk, stats, options)),
    );
  } else {
    partials = [];
    for (const chunk of chunks) {
      partials.push(await generateForChunk(chunk, stats, options));
    }
  }

  const sys = buildSystemPrompt(options);
  const usr = buildMergePrompt(partials, stats, options);
  const breakingMode = resolveBreakingChangeMode(options);
  const rawMessage = await complete(sys, usr, { stage: "merge" });
  return validateCommitMessage(
    breakingMode === "disabled"
      ? suppressCommitMessageBreaking(rawMessage)
      : rawMessage,
  );
}

export async function planCommits(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  recursionDepth = 0,
  promptContext?: GroupingPromptContext,
): Promise<PlannedCommit[]> {
  if (files.length === 0) {
    throw new ValidationError("Cannot plan commits for an empty file set");
  }

  const cfg = loadConfig();
  const { formattedDiffs, planCacheInput } = buildPlanCacheContext(
    files,
    formatFileDiff,
    promptContext,
  );
  const cachedPlan = getEmittedCachedPlan(planCacheInput, files.length);
  if (cachedPlan) {
    return cachedPlan;
  }
  validatePlanRecursionDepth(recursionDepth, files.length);

  const incrementalPlan = await maybePlanIncrementally(
    files,
    formattedDiffs,
    formatFileDiff,
    recursionDepth,
    promptContext,
  );
  if (incrementalPlan) {
    setCachedPlan(planCacheInput, incrementalPlan);
    return incrementalPlan;
  }

  const groups = await buildRequestedGroupingPlan(
    files,
    formatFileDiff,
    promptContext,
    cfg,
  );
  const finalized = await finalizePlannedCommitGroups(
    files,
    groups,
    promptContext?.deferFinalization === true,
    promptContext?.breakingMode,
  );
  setCachedPlan(planCacheInput, finalized);
  return finalized;
}

async function buildFallbackGroupingPlan(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  promptContext?: GroupingPromptContext,
): Promise<PlannedCommit[]> {
  const allContent = files
    .map((file) => formatLabeledDiff(file, formatFileDiff))
    .join("\n");
  const allChunk: DiffChunk = {
    content: allContent,
    files: files.map((file) => file.path),
    id: 0,
    lineCount: allContent.split("\n").length,
  };
  const msg = await generateForChunk(allChunk, undefined, {
    breakingMode: promptContext?.breakingMode,
  });

  return [{ files: files.map((file) => ({ path: file.path })), message: msg }];
}

async function buildRequestedGroupingPlan(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  promptContext: GroupingPromptContext | undefined,
  cfg: ReturnType<typeof loadConfig>,
): Promise<PlannedCommit[]> {
  const raw = await requestGroupingPlan(
    buildGroupingSystemPrompt(promptContext),
    buildGroupingUserPrompt(files, formatFileDiff, promptContext),
    getGroupingResponseTokenBudget(cfg.openai.maxTokens, files.length),
    Math.max(cfg.performance.timeoutMs, GROUPING_TIMEOUT_MS),
    cfg,
  );
  const fileByPath = new Map(files.map((file) => [file.path, file]));

  try {
    return await buildValidatedGroupingPlan(
      raw,
      files,
      formatFileDiff,
      fileByPath,
      promptContext,
    );
  } catch (error: unknown) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }

    emitAiOutputEvent({
      content: JSON.stringify({
        decision: "grouping-fallback",
        error: error.message,
        inputFileCount: files.length,
        reason: "invalid-grouping-response",
      }),
      kind: "planner-decision",
      stage: "group",
      transport: "internal",
    });

    return buildFallbackGroupingPlan(files, formatFileDiff, promptContext);
  }
}

async function buildValidatedGroupingPlan(
  raw: string,
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  fileByPath: Map<string, FileDiff>,
  promptContext: GroupingPromptContext | undefined,
): Promise<PlannedCommit[]> {
  const groups = validateAndNormalizeGrouping(
    parseGroupingResponse(raw),
    fileByPath,
    promptContext,
  );
  const missedFiles = collectMissedPlannedFiles(groups, files, fileByPath);

  if (missedFiles.length === 0) {
    return groups;
  }

  const missedMessage = await generateForChunk(
    buildMissedFilesChunk(missedFiles, fileByPath, formatFileDiff),
    undefined,
    { breakingMode: promptContext?.breakingMode },
  );
  return [...groups, { files: missedFiles, message: missedMessage }];
}

async function maybePlanIncrementally(
  files: FileDiff[],
  formattedDiffs: string[],
  formatFileDiff: (f: FileDiff) => string,
  recursionDepth: number,
  promptContext: GroupingPromptContext | undefined,
): Promise<PlannedCommit[] | undefined> {
  if (files.length === 1 && files[0].hunks.length <= 1) {
    return planSingleFileCommit(
      files[0],
      formattedDiffs[0],
      formatFileDiff,
      promptContext,
    );
  }

  if (files.length <= 1 || !shouldBatchFiles(files)) {
    return undefined;
  }

  const batches = batchFilesForGrouping(files);
  if (!batchingMakesProgress(files, batches)) {
    return undefined;
  }

  return planBatchedCommits(
    files,
    batches,
    formatFileDiff,
    recursionDepth,
    promptContext,
  );
}

async function planBatchedCommits(
  files: FileDiff[],
  batches: FileDiff[][],
  formatFileDiff: (f: FileDiff) => string,
  recursionDepth: number,
  promptContext: GroupingPromptContext | undefined,
): Promise<PlannedCommit[]> {
  const batchStartedAtMs = performance.now();
  const batchResults = await Promise.all(
    batches.map((batch, batchIndex) =>
      planCommits(batch, formatFileDiff, recursionDepth + 1, {
        allFiles: promptContext?.allFiles ?? files,
        batchCount: batches.length,
        batchIndex,
        breakingMode: promptContext?.breakingMode,
        deferFinalization: true,
      }),
    ),
  );
  const mergedGroups = batchResults.flat();
  const finalized = await finalizePlannedGroups(files, mergedGroups, {
    breakingMode: promptContext?.breakingMode,
  });

  emitAiOutputEvent({
    content: JSON.stringify({
      batchCount: batches.length,
      decision: "batched-plan-finalization",
      deferredFinalization: true,
      finalCommitCount: finalized.length,
      inputFileCount: files.length,
      intermediateCommitCount: mergedGroups.length,
    }),
    durationMs: performance.now() - batchStartedAtMs,
    kind: "planner-decision",
    stage: "group",
    transport: "internal",
  });

  return finalized;
}

async function planSingleFileCommit(
  file: FileDiff,
  formattedDiff: string | undefined,
  formatFileDiff: (f: FileDiff) => string,
  promptContext?: GroupingPromptContext,
): Promise<PlannedCommit[]> {
  const content = formattedDiff ?? formatFileDiff(file);
  const chunk: DiffChunk = {
    content,
    files: [file.path],
    id: 0,
    lineCount: content.split("\n").length,
  };
  const msg = await generateForChunk(chunk, undefined, {
    breakingMode: promptContext?.breakingMode,
  });

  return [{ files: [{ path: file.path }], message: msg }];
}

async function requestGroupingPlan(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  timeoutMs: number,
  cfg: ReturnType<typeof loadConfig>,
): Promise<string> {
  return complete(systemPrompt, userPrompt, {
    maxTokens,
    stage: "group",
    temperature: Math.min(cfg.openai.temperature, 0.3),
    timeoutMs,
  });
}
