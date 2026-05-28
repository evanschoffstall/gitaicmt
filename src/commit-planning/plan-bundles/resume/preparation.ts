import { resolve } from "node:path";

import type { PersistedPlanBundle } from "../schemas.js";

import { ValidationError } from "../../../application/errors.js";
import {
  getRepositoryRoot,
  getStagedPatch,
  resetStaging,
  restoreStagedPatch,
} from "../../../git/index.js";
import { hashContent, normalizePatchContent } from "../hashes.js";
import { buildSelectedResumePatch } from "../patches.js";

/**
 * Validate repository identity for a saved plan bundle and, when the index is
 * empty, restore only the selected commit patches for the requested resume set.
 */
export function preparePlanBundleForResume(
  bundle: PersistedPlanBundle,
  selectedIndexes: number[],
  cwd?: string,
): void {
  validateBundleResumeRepository(bundle, cwd);

  if (safeGetStagedPatch(cwd).trim().length > 0) {
    return;
  }

  const selectedResumePatch = buildSelectedResumePatch(bundle, selectedIndexes);
  restoreResumeSelectionOrThrow(selectedResumePatch, cwd);
  validateRestoredResumeSelection(selectedResumePatch, cwd);
}

function restoreResumeSelectionOrThrow(
  selectedResumePatch: string,
  cwd?: string,
): void {
  const previousPatch = safeGetStagedPatch(cwd);
  try {
    resetStaging(cwd);
    if (selectedResumePatch.trim().length > 0) {
      restoreStagedPatch(selectedResumePatch, cwd);
    }
  } catch (error: unknown) {
    rollbackStaging(previousPatch, cwd);
    throw new ValidationError(
      "Failed to restore the selected saved commit patch set. Ensure index filters or attributes are unchanged before resuming.",
      { cause: String(error) },
    );
  }
}

function rollbackStaging(previousPatch: string, cwd?: string): void {
  try {
    resetStaging(cwd);
    if (previousPatch.trim().length > 0) {
      restoreStagedPatch(previousPatch, cwd);
    }
  } catch {
    // Best-effort rollback only.
  }
}

function safeGetStagedPatch(cwd?: string): string {
  try {
    return normalizePatchContent(getStagedPatch(cwd));
  } catch {
    return "";
  }
}

/**
 * Resume bundles remain repository-scoped, but HEAD and unrelated historical
 * bundle staging no longer gate replay. Commit-scoped patches decide what the
 * caller can restore or execute.
 */
function validateBundleResumeRepository(
  bundle: PersistedPlanBundle,
  cwd?: string,
): void {
  const repoRoot = resolve(getRepositoryRoot(cwd));
  if (repoRoot !== resolve(bundle.repoRoot)) {
    throw new ValidationError(
      "Saved plan bundle belongs to a different repository checkout.",
      { currentRepoRoot: repoRoot, savedRepoRoot: bundle.repoRoot },
    );
  }
}

function validateRestoredResumeSelection(
  selectedResumePatch: string,
  cwd?: string,
): void {
  const restoredPatch = safeGetStagedPatch(cwd);
  if (restoredPatch !== normalizePatchContent(selectedResumePatch)) {
    throw new ValidationError(
      `Saved resume selection failed stagedPatch integrity validation: expected=${hashContent(selectedResumePatch)}, actual=${hashContent(restoredPatch)}.`,
    );
  }
}
