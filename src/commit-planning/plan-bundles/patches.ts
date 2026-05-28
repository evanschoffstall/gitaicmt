import type { PlannedCommit } from "../types.js";
import type { PersistedPlanBundle } from "./schemas.js";

import { ValidationError } from "../../application/errors.js";
import { buildPatch, type FileDiff, parseDiff } from "../../git/index.js";
import { normalizePatchContent } from "./hashes.js";

/**
 * Build one normalized patch payload per planned commit so resume can restore
 * or validate only the selected commit subset instead of the original full
 * staged patch.
 */
export function buildPlanCommitPatches(
  plan: PlannedCommit[],
  stagedPatch: string,
): string[] {
  const fileDiffsByPath = new Map<string, FileDiff>(
    parseDiff(normalizePatchContent(stagedPatch)).map((fileDiff) => [
      fileDiff.path,
      fileDiff,
    ]),
  );

  return plan.map((plannedCommit, commitIndex) =>
    buildPlanCommitPatch(plannedCommit, fileDiffsByPath, commitIndex),
  );
}

/**
 * Concatenate the persisted patches for the selected resume indexes into the
 * exact patch payload that should be restored when the current index is empty.
 */
export function buildSelectedResumePatch(
  bundle: Pick<PersistedPlanBundle, "planCommitPatches">,
  selectedIndexes: number[],
): string {
  return normalizePatchContent(
    selectedIndexes
      .map((selectedIndex) => bundle.planCommitPatches[selectedIndex - 1] ?? "")
      .join(""),
  );
}

function buildPlanCommitPatch(
  plannedCommit: PlannedCommit,
  fileDiffsByPath: Map<string, FileDiff>,
  commitIndex: number,
): string {
  const patchSegments = plannedCommit.files.map((plannedFile) => {
    const fileDiff = fileDiffsByPath.get(plannedFile.path);
    if (!fileDiff) {
      throw new ValidationError(
        `Planned commit ${String(commitIndex + 1)} references a file that is not present in the saved staged patch: ${plannedFile.path}`,
      );
    }

    return buildPatch(
      fileDiff,
      resolveSelectedPatchHunks(fileDiff, plannedFile.hunks),
    );
  });

  return normalizePatchContent(patchSegments.join(""));
}

function resolveSelectedPatchHunks(
  fileDiff: FileDiff,
  requestedHunks: number[] | undefined,
) {
  if (!requestedHunks || requestedHunks.length === 0) {
    return fileDiff.hunks;
  }

  return requestedHunks.map((hunkIndex) => {
    if (hunkIndex < 0 || hunkIndex >= fileDiff.hunks.length) {
      throw new ValidationError(
        `Planned commit references an out-of-bounds hunk index ${String(hunkIndex)} for ${fileDiff.path}.`,
      );
    }
    return fileDiff.hunks[hunkIndex];
  });
}
