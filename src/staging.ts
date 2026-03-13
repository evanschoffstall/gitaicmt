/**
 * Hunk-level file staging helpers.
 *
 * Extracted from cli.ts so tests can import this module without triggering
 * cli.ts's unconditional `main()` invocation.
 */
import { buildPatch, type FileDiff } from "./diff.js";
import { stageFiles, stagePatch } from "./git.js";

type PlannedCommitFile = import("./ai.js").PlannedCommitFile;

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
      throw new Error(
        `AI returned invalid file path not in original diff: ${fileRef.path}`,
      );
    }

    if (fileRef.hunks && fileRef.hunks.length > 0) {
      // SECURITY: Validate hunk indices are within bounds
      for (const hunkIndex of fileRef.hunks) {
        if (hunkIndex < 0 || hunkIndex >= file.hunks.length) {
          throw new Error(
            `AI returned out-of-bounds hunk index ${String(hunkIndex)} for ${fileRef.path} (max: ${String(file.hunks.length - 1)})`,
          );
        }
      }
      entries.push({ file, hunkIndices: fileRef.hunks });
    } else {
      // Whole-file: use all hunks so we never accidentally pick up unstaged changes
      entries.push({ file, hunkIndices: file.hunks.map((_, i) => i) });
    }
  }

  // Stage all entries via patch (git apply --cached)
  for (const { file, hunkIndices } of entries) {
    const selectedHunks = hunkIndices.map((i) => file.hunks[i]);
    const patch = buildPatch(file, selectedHunks);
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

function log(msg: string) {
  process.stderr.write(msg + "\n");
}
