/**
 * Hunk-level file staging helpers.
 *
 * Extracted from main.ts so tests can import this module
 * without triggering main.ts's unconditional `main()` invocation.
 */
import { ValidationError } from "../../application/errors.js";
import { buildPatch, type FileDiff } from "../../git/diff.js";
import {
  isPathTrackedInIndex,
  stageFiles,
  stagePatch,
} from "../../git/operations.js";
import { resolveTerminalColumns } from "../terminal/columns.js";
import { wrapTerminalTextBlock } from "../terminal/line-wrapping.js";

type PlannedCommitFile =
  import("../../commit-planning/orchestration.js").PlannedCommitFile;

const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * Stage files for a commit group, handling hunk-level staging.
 *
 * Files with specific hunks are staged via `git apply --cached` using a patch
 * built from only those hunks.  Files without hunks (whole-file) are staged
 * normally with `git add`.
 *
 * Validates that all paths exist in the original diff before staging.
 * Filters out gitignored files to prevent staging errors.
 *
 * @throws {Error} if a path is not in `originalFiles`
 * @throws {Error} if a hunk index is out of bounds
 */
export function stageGroupFiles(
  group: PlannedCommitFile[],
  originalFiles: Map<string, FileDiff>,
  cwd?: string,
): void {
  // Build entries: whole-file → all hunks; hunk-specific → those hunks.
  // Always stage via patch (git apply --cached) so that only the originally-staged
  // content is re-applied and any unstaged working-tree changes are left untouched.
  const entries: { file: FileDiff; hunkIndices: number[] }[] = [];

  for (const fileRef of group) {
    // SECURITY: Validate that all paths exist in the original diff
    const file = originalFiles.get(fileRef.path);
    if (!file) {
      throw new ValidationError(
        `AI returned invalid file path not in original diff: ${fileRef.path}`,
      );
    }

    entries.push({ file, hunkIndices: getStageableHunkIndexes(fileRef, file) });
  }

  // Stage all entries via patch (git apply --cached)
  for (const { file, hunkIndices } of entries) {
    const selectedHunks = hunkIndices.map((i) => file.hunks[i]);
    const patchFile = resolvePatchFileForCurrentIndex(file, cwd);
    const patch = buildPatch(patchFile, selectedHunks);
    if (!patch.trim()) {
      if (file.hunks.length === 0) {
        stageFiles([file.path], cwd);
        continue;
      }
      log(
        `${YELLOW}Warning: empty patch for ${file.path} hunks [${hunkIndices.join(", ")}], skipping${RESET}`,
      );
      continue;
    }
    try {
      stagePatch(patch, cwd);
    } catch (err) {
      log(
        `${RED}Error staging hunks [${hunkIndices.join(", ")}] for ${file.path}: ${String(err)}${RESET}`,
      );
      throw err;
    }
  }
}

function getStageableHunkIndexes(
  fileRef: PlannedCommitFile,
  file: FileDiff,
): number[] {
  if (!fileRef.hunks || fileRef.hunks.length === 0) {
    return file.hunks.map((_, index) => index);
  }

  const uniqueHunkIndexes = new Set<number>();
  for (const hunkIndex of fileRef.hunks) {
    if (!Number.isInteger(hunkIndex)) {
      throw new ValidationError(
        `AI returned non-integer hunk index ${String(hunkIndex)} for ${fileRef.path}`,
      );
    }
    if (hunkIndex < 0 || hunkIndex >= file.hunks.length) {
      throw new ValidationError(
        `AI returned out-of-bounds hunk index ${String(hunkIndex)} for ${fileRef.path} (max: ${String(file.hunks.length - 1)})`,
      );
    }
    uniqueHunkIndexes.add(hunkIndex);
  }

  return [...uniqueHunkIndexes].sort((left, right) => left - right);
}

function log(msg: string) {
  const terminalColumns = resolveTerminalColumns({
    fallbackColumns: 100,
    streams: [process.stderr],
  });
  for (const line of wrapTerminalTextBlock(
    msg,
    Math.max(20, terminalColumns - 1),
  )) {
    process.stderr.write(`${line}\n`);
  }
}

/**
 * Re-anchor later rename hunks to the current path after an earlier split
 * commit has already recorded the rename in history.
 */
function resolvePatchFileForCurrentIndex(
  file: FileDiff,
  cwd?: string,
): FileDiff {
  if (!cwd || file.status !== "renamed" || !file.oldPath) {
    return file;
  }

  const oldPathTracked = isPathTrackedInIndex(file.oldPath, cwd);
  if (oldPathTracked) {
    return file;
  }

  const newPathTracked = isPathTrackedInIndex(file.path, cwd);
  if (!newPathTracked) {
    return file;
  }

  return {
    ...file,
    metadataLines: [],
    oldPath: file.path,
    status: "modified",
  };
}
