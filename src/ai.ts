import {
  batchFilesForGrouping,
  batchingMakesProgress,
  shouldBatchFiles,
} from "./ai-batching.js";
import { getCachedMessage, setCachedMessage } from "./ai-cache.js";
import { complete } from "./ai-client.js";
import {
  formatLabeledDiff,
  formatScalar,
  validateCommitMessage,
} from "./ai-format.js";
import { finalizePlannedGroups } from "./ai-grouping.js";
import {
  buildGroupingSystemPrompt,
  buildGroupingUserPrompt,
  buildMergePrompt,
  buildSystemPrompt,
  buildUserPrompt,
  type GroupingPromptContext,
} from "./ai-prompt-builders.js";
import { getGroupingResponseTokenBudget } from "./ai-tokens.js";
import { type PlannedCommit, type PlannedCommitFile } from "./ai-types.js";
import { validateAndNormalizeGrouping } from "./ai-validation.js";
import { loadConfig } from "./config.js";
import {
  DEFAULT_EMPTY_COMMIT_MESSAGE,
  GROUPING_TIMEOUT_MS,
} from "./constants.js";
import { ValidationError } from "./errors.js";

type DiffChunk = import("./diff.js").DiffChunk;
type DiffStats = import("./diff.js").DiffStats;
type FileDiff = import("./diff.js").FileDiff;

export { buildGroupingSystemPrompt, buildGroupingUserPrompt };
export {
  estimateGenerateOperationTokens,
  estimatePlanOperationTokens,
} from "./ai-tokens.js";
export type { PlannedCommit, PlannedCommitFile };
export type { TokenEstimateSummary } from "./ai-tokens.js";

export async function generateForChunk(
  chunk: DiffChunk,
  stats?: DiffStats,
): Promise<string> {
  const cached = getCachedMessage(chunk.content);
  if (cached) {
    return cached;
  }

  const sys = buildSystemPrompt();
  const usr = buildUserPrompt(chunk, stats);
  const msg = validateCommitMessage(await complete(sys, usr));
  setCachedMessage(chunk.content, msg);
  return msg;
}

export async function generateForChunks(
  chunks: DiffChunk[],
  stats: DiffStats,
): Promise<string> {
  const cfg = loadConfig();

  if (chunks.length === 0) return DEFAULT_EMPTY_COMMIT_MESSAGE;
  if (chunks.length === 1) return generateForChunk(chunks[0], stats);

  let partials: string[];
  if (cfg.performance.parallel) {
    partials = await Promise.all(
      chunks.map((chunk) => generateForChunk(chunk, stats)),
    );
  } else {
    partials = [];
    for (const chunk of chunks) {
      partials.push(await generateForChunk(chunk, stats));
    }
  }

  const sys = buildSystemPrompt();
  const usr = buildMergePrompt(partials, stats);
  return validateCommitMessage(await complete(sys, usr));
}

export async function planCommits(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  recursionDepth = 0,
  promptContext?: GroupingPromptContext,
): Promise<PlannedCommit[]> {
  const cfg = loadConfig();
  const maxRecursionDepth = 5;
  if (recursionDepth > maxRecursionDepth) {
    throw new ValidationError(
      `Maximum recursion depth exceeded while planning commits. Too many files (${formatScalar(files.length)}) to process safely.`,
      { depth: recursionDepth, fileCount: files.length },
    );
  }

  if (files.length === 1 && files[0].hunks.length <= 1) {
    const chunk: DiffChunk = {
      content: formatFileDiff(files[0]),
      files: [files[0].path],
      id: 0,
      lineCount: formatFileDiff(files[0]).split("\n").length,
    };
    const msg = await generateForChunk(chunk);
    return [{ files: [{ path: files[0].path }], message: msg }];
  }

  if (files.length > 1 && shouldBatchFiles(files)) {
    const batches = batchFilesForGrouping(files);
    if (batchingMakesProgress(files, batches)) {
      const batchResults = await Promise.all(
        batches.map((batch, batchIndex) =>
          planCommits(batch, formatFileDiff, recursionDepth + 1, {
            allFiles: promptContext?.allFiles ?? files,
            batchCount: batches.length,
            batchIndex,
          }),
        ),
      );
      return await finalizePlannedGroups(files, batchResults.flat());
    }
  }

  const sys = buildGroupingSystemPrompt();
  const usr = buildGroupingUserPrompt(files, formatFileDiff, promptContext);
  const groupingTokens = getGroupingResponseTokenBudget(
    cfg.openai.maxTokens,
    files.length,
  );
  const groupingTimeout = Math.max(
    cfg.performance.timeoutMs,
    GROUPING_TIMEOUT_MS,
  );
  const raw = await complete(sys, usr, {
    maxTokens: groupingTokens,
    temperature: Math.min(cfg.openai.temperature, 0.3),
    timeoutMs: groupingTimeout,
  });

  const fileByPath = new Map(files.map((file) => [file.path, file]));

  let groups: PlannedCommit[];
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      throw new ValidationError(
        `AI returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
    }

    groups = validateAndNormalizeGrouping(parsed, fileByPath);

    const assignedHunks = new Map<string, Set<number>>();
    for (const group of groups) {
      for (const fileRef of group.files) {
        let assigned = assignedHunks.get(fileRef.path);
        if (!assigned) {
          assigned = new Set<number>();
          assignedHunks.set(fileRef.path, assigned);
        }
        const file = fileByPath.get(fileRef.path);
        if (!file) {
          throw new ValidationError(
            `Unknown file in commit group: ${fileRef.path}`,
          );
        }
        if (fileRef.hunks) {
          for (const hunk of fileRef.hunks) {
            assigned.add(hunk);
          }
        } else {
          for (let i = 0; i < file.hunks.length; i++) {
            assigned.add(i);
          }
        }
      }
    }

    const missedFiles: PlannedCommitFile[] = [];
    for (const file of files) {
      const assigned = assignedHunks.get(file.path);
      if (!assigned || assigned.size === 0) {
        missedFiles.push({ path: file.path });
        continue;
      }
      if (assigned.size >= file.hunks.length) {
        continue;
      }

      const missedHunks: number[] = [];
      for (let i = 0; i < file.hunks.length; i++) {
        if (!assigned.has(i)) {
          missedHunks.push(i);
        }
      }
      if (missedHunks.length > 0) {
        missedFiles.push({ hunks: missedHunks, path: file.path });
      }
    }

    if (missedFiles.length > 0) {
      const missedContent = missedFiles
        .map((missedFile) => {
          const file = fileByPath.get(missedFile.path);
          if (!file) {
            throw new ValidationError(
              `Unknown missed file: ${missedFile.path}`,
            );
          }
          if (missedFile.hunks) {
            const selectedHunks = missedFile.hunks.map(
              (index) => file.hunks[index],
            );
            const parts = [
              `--- ${file.oldPath ?? file.path}`,
              `+++ ${file.path}`,
            ];
            for (const hunk of selectedHunks) {
              parts.push(hunk.header, ...hunk.lines);
            }
            return parts.join("\n");
          }
          return formatFileDiff(file);
        })
        .join("\n");

      const missedChunk: DiffChunk = {
        content: missedContent,
        files: missedFiles.map((file) => file.path),
        id: 999,
        lineCount: missedContent.split("\n").length,
      };
      const missedMsg = await generateForChunk(missedChunk);
      groups.push({ files: missedFiles, message: missedMsg });
    }
  } catch {
    const allContent = files
      .map((file) => formatLabeledDiff(file, formatFileDiff))
      .join("\n");
    const allChunk: DiffChunk = {
      content: allContent,
      files: files.map((file) => file.path),
      id: 0,
      lineCount: allContent.split("\n").length,
    };
    const msg = await generateForChunk(allChunk);
    groups = [
      { files: files.map((file) => ({ path: file.path })), message: msg },
    ];
  }

  return await finalizePlannedGroups(files, groups);
}
