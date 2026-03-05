/**
 * Hunk-level file staging helpers.
 *
 * Extracted from cli.ts so tests can import this module without triggering
 * cli.ts's unconditional `main()` invocation.
 */

import type { PlannedCommitFile } from "./ai.js";
import type { FileDiff } from "./diff.js";
import { buildPatch } from "./diff.js";
import { filterIgnoredFiles, stageFiles, stagePatch } from "./git.js";

const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function log(msg: string) {
  process.stderr.write(msg + "\n");
}

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
  // Separate whole-file entries from hunk-specific entries
  const wholeFiles: string[] = [];
  const hunkEntries: { file: FileDiff; hunkIndices: number[] }[] = [];

  for (const fileRef of group) {
    // SECURITY: Validate that all paths exist in the original diff
    if (!originalFiles.has(fileRef.path)) {
      throw new Error(
        `AI returned invalid file path not in original diff: ${fileRef.path}`,
      );
    }
    const file = originalFiles.get(fileRef.path)!;

    if (fileRef.hunks && fileRef.hunks.length > 0) {
      // SECURITY: Validate hunk indices are within bounds
      for (const hunkIndex of fileRef.hunks) {
        if (hunkIndex < 0 || hunkIndex >= file.hunks.length) {
          throw new Error(
            `AI returned out-of-bounds hunk index ${hunkIndex} for ${fileRef.path} (max: ${file.hunks.length - 1})`,
          );
        }
      }
      hunkEntries.push({ file, hunkIndices: fileRef.hunks });
    } else {
      wholeFiles.push(fileRef.path);
    }
  }

  // Stage whole files via git add
  if (wholeFiles.length > 0) {
    const safeToStage = filterIgnoredFiles(wholeFiles, cwd);
    if (safeToStage.length === 0) {
      log(
        `${YELLOW}Warning: All whole-file entries in this group are gitignored, skipping${RESET}`,
      );
    } else {
      if (safeToStage.length < wholeFiles.length) {
        const ignoredCount = wholeFiles.length - safeToStage.length;
        log(
          `${YELLOW}Warning: Skipping ${ignoredCount} gitignored file(s)${RESET}`,
        );
      }
      try {
        stageFiles(safeToStage, cwd);
      } catch (err) {
        log(`${RED}Error staging files: ${err}${RESET}`);
        throw err;
      }
    }
  }

  // Stage specific hunks via patch (git apply --cached)
  for (const { file, hunkIndices } of hunkEntries) {
    const selectedHunks = hunkIndices.map((i) => file.hunks[i]);
    const patch = buildPatch(file, selectedHunks);
    if (!patch.trim()) {
      log(
        `${YELLOW}Warning: empty patch for ${file.path} hunks [${hunkIndices.join(", ")}], skipping${RESET}`,
      );
      continue;
    }
    try {
      stagePatch(patch, cwd);
    } catch (err) {
      log(
        `${RED}Error staging hunks [${hunkIndices.join(", ")}] for ${file.path}: ${err}${RESET}`,
      );
      throw err;
    }
  }
}
