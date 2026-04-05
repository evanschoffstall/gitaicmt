import type { GroupingPromptContext } from "./prompt-builders/index.js";
import type { PlannedCommit, PlannedCommitFile } from "./types.js";

import { ValidationError } from "../application/errors.js";
import { formatSelectedFileDiff } from "../git/diff.js";
import { finalizePlannedGroups, premergeBySubject } from "./grouping/index.js";
import { emitAiOutputEvent } from "./openai-client.js";
import {
  getCachedPlan,
  serializePlanCacheInput,
} from "./result-cache.js";

type DiffChunk = import("../git/diff.js").DiffChunk;
type FileDiff = import("../git/diff.js").FileDiff;

export function buildMissedFilesChunk(
  missedFiles: PlannedCommitFile[],
  fileByPath: Map<string, FileDiff>,
  formatFileDiff: (f: FileDiff) => string,
): DiffChunk {
  const content = missedFiles
    .map((missedFile) => formatMissedFileDiff(missedFile, fileByPath, formatFileDiff))
    .join("\n");

  return {
    content,
    files: missedFiles.map((file) => file.path),
    id: 999,
    lineCount: content.split("\n").length,
  };
}

export function buildPlanCacheContext(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  promptContext: GroupingPromptContext | undefined,
): { formattedDiffs: string[]; planCacheInput: string } {
  const formattedDiffs = files.map((file) => formatFileDiff(file));

  return {
    formattedDiffs,
    planCacheInput: serializePlanCacheInput(files, formattedDiffs, promptContext),
  };
}

export function collectMissedPlannedFiles(
  groups: PlannedCommit[],
  files: FileDiff[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommitFile[] {
  const { assignedFiles, assignedHunks } = collectAssignedPlanCoverage(groups, fileByPath);
  const missedFiles: PlannedCommitFile[] = [];

  for (const file of files) {
    if (!assignedFiles.has(file.path)) {
      missedFiles.push({ path: file.path });
      continue;
    }
    if (file.hunks.length === 0) {
      continue;
    }

    const assigned = assignedHunks.get(file.path);
    if (!assigned || assigned.size === 0 || assigned.size >= file.hunks.length) {
      continue;
    }

    const missedHunks = file.hunks
      .map((_, index) => index)
      .filter((index) => !assigned.has(index));
    if (missedHunks.length > 0) {
      missedFiles.push({ hunks: missedHunks, path: file.path });
    }
  }

  return missedFiles;
}

export async function finalizePlannedCommitGroups(
  files: FileDiff[],
  groups: PlannedCommit[],
  shouldDeferFinalization: boolean,
): Promise<PlannedCommit[]> {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  if (shouldDeferFinalization) {
    return premergeBySubject(groups, fileByPath);
  }

  const finalizationStartedAtMs = performance.now();
  const finalized = await finalizePlannedGroups(files, groups);
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "plan-finalization",
      finalCommitCount: finalized.length,
      generatedGroupCount: groups.length,
      inputFileCount: files.length,
    }),
    durationMs: performance.now() - finalizationStartedAtMs,
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });

  return finalized;
}

export function getEmittedCachedPlan(
  planCacheInput: string,
  fileCount: number,
): PlannedCommit[] | undefined {
  const cachedPlan = getCachedPlan(planCacheInput);
  if (!cachedPlan) {
    return undefined;
  }

  emitAiOutputEvent({
    content: JSON.stringify({
      cachedCommitCount: cachedPlan.length,
      cacheKeyFiles: fileCount,
      decision: "plan-cache-hit",
    }),
    kind: "cache",
    stage: "group",
    transport: "internal",
  });

  return cachedPlan;
}

export function parseGroupingResponse(raw: string): unknown {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```$/m, "");

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    throw new ValidationError(
      `AI returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    );
  }
}

export function validatePlanRecursionDepth(
  recursionDepth: number,
  fileCount: number,
): void {
  const maxRecursionDepth = 5;
  if (recursionDepth <= maxRecursionDepth) {
    return;
  }

  throw new ValidationError(
    `Maximum recursion depth exceeded while planning commits. Too many files (${String(fileCount)}) to process safely.`,
    { depth: recursionDepth, fileCount },
  );
}

function collectAssignedPlanCoverage(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): {
  assignedFiles: Set<string>;
  assignedHunks: Map<string, Set<number>>;
} {
  const assignedFiles = new Set<string>();
  const assignedHunks = new Map<string, Set<number>>();

  for (const group of groups) {
    for (const fileRef of group.files) {
      assignedFiles.add(fileRef.path);
      const assigned = assignedHunks.get(fileRef.path) ?? new Set<number>();
      assignedHunks.set(fileRef.path, assigned);

      const file = fileByPath.get(fileRef.path);
      if (!file) {
        throw new ValidationError(`Unknown file in commit group: ${fileRef.path}`);
      }

      if (fileRef.hunks) {
        for (const hunk of fileRef.hunks) {
          assigned.add(hunk);
        }
        continue;
      }

      for (let index = 0; index < file.hunks.length; index++) {
        assigned.add(index);
      }
    }
  }

  return { assignedFiles, assignedHunks };
}

function formatMissedFileDiff(
  missedFile: PlannedCommitFile,
  fileByPath: Map<string, FileDiff>,
  formatFileDiff: (f: FileDiff) => string,
): string {
  const file = fileByPath.get(missedFile.path);
  if (!file) {
    throw new ValidationError(`Unknown missed file: ${missedFile.path}`);
  }
  if (!missedFile.hunks) {
    return formatFileDiff(file);
  }

  return formatSelectedFileDiff(
    file,
    missedFile.hunks.map((index) => file.hunks[index]),
  );
}