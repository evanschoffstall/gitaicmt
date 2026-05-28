import type { PlannedCommit } from "../../types.js";
import type { PersistedPlanBundle } from "../schemas.js";

import { getStagedPatch } from "../../../git/index.js";
import {
  buildBundleContentHashes,
  formatHashMismatchDiagnostic,
  normalizePatchContent,
} from "../hashes.js";
import { getPlanCommitHashMismatch } from "./plan-commit-mismatch.js";

/**
 * One skipped resume commit with the reason it failed commit-scoped
 * validation against the current staged patch.
 */
export interface InvalidResumeCommit {
  index: number;
  message: string;
  mismatch: string;
}

/**
 * Result of filtering a selected resume plan through commit-scoped hash
 * validation.
 */
export interface ValidatedResumePlan {
  invalidCommits: InvalidResumeCommit[];
  validPlan: PlannedCommit[];
}

/**
 * Keep only resume commits whose persisted file or hunk hashes still match the
 * current staged patch.
 */
export function filterValidPlanCommitsForResume(
  bundle: PersistedPlanBundle,
  selectedIndexes: number[],
  cwd?: string,
): ValidatedResumePlan {
  const stagedPatch = normalizePatchContent(getStagedPatch(cwd));
  const currentContentHashes = buildBundleContentHashes(stagedPatch);
  const invalidCommits: InvalidResumeCommit[] = [];
  const validPlan: PlannedCommit[] = [];

  for (const selectedIndex of selectedIndexes) {
    const planIndex = selectedIndex - 1;
    if (
      planIndex < 0 ||
      planIndex >= bundle.plan.length ||
      planIndex >= bundle.planCommitHashes.length
    ) {
      continue;
    }

    const plannedCommit = bundle.plan[planIndex];
    const commitHashes = bundle.planCommitHashes[planIndex];
    const mismatch = getPlanCommitHashMismatch(
      commitHashes,
      currentContentHashes,
    );
    if (mismatch) {
      invalidCommits.push({
        index: selectedIndex,
        message: plannedCommit.message,
        mismatch: formatHashMismatchDiagnostic(mismatch),
      });
      continue;
    }

    validPlan.push(plannedCommit);
  }

  return {
    invalidCommits,
    validPlan,
  };
}
