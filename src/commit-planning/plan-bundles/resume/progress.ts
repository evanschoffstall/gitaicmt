import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { PersistedPlanBundle } from "../schemas.js";

import { resolveGitAICmtCacheDirectory } from "../../../application/cache-paths.js";
import { getHeadCommit, getRecentCommitMessages } from "../../../git/index.js";

interface PersistedResumeProgress {
  bundleHash: string;
  completedIndexes: number[];
  latestHeadCommit: null | string;
  repoRoot: string;
}

/**
 * Clear stored replay progress once a resume run completes successfully.
 */
export function clearPlanBundleResumeProgress(bundleHash: string): void {
  const path = resolveResumeProgressPath(bundleHash);
  if (!existsSync(path)) {
    return;
  }

  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup only.
  }
}

/**
 * Remove already completed bundle indexes only when the current HEAD still
 * matches the HEAD recorded after the latest successful replay step.
 */
export function filterPendingResumeIndexes(
  bundle: Pick<PersistedPlanBundle, "hash" | "plan" | "repoRoot">,
  selectedIndexes: number[],
  cwd?: string,
): number[] {
  const uniqueSelectedIndexes = Array.from(new Set(selectedIndexes));
  const persistedProgress = readResumeProgress(bundle.hash);
  if (!persistedProgress) {
    return uniqueSelectedIndexes.slice(
      inferCompletedResumePrefixLength(bundle, uniqueSelectedIndexes, cwd),
    );
  }

  if (resolve(persistedProgress.repoRoot) !== resolve(bundle.repoRoot)) {
    return uniqueSelectedIndexes;
  }

  if (getHeadCommit(cwd) !== persistedProgress.latestHeadCommit) {
    return uniqueSelectedIndexes;
  }

  const completedIndexes = new Set(
    persistedProgress.completedIndexes.filter(
      (index) => Number.isInteger(index) && index > 0,
    ),
  );
  return uniqueSelectedIndexes.filter((index) => !completedIndexes.has(index));
}

/**
 * Persist the original bundle index of each successful resume replay step so a
 * later retry can stage only the unfinished suffix.
 */
export function markPlanBundleResumeCommitCompleted(
  bundle: Pick<PersistedPlanBundle, "hash" | "repoRoot">,
  completedIndex: number,
  cwd?: string,
): void {
  if (!Number.isInteger(completedIndex) || completedIndex < 1) {
    return;
  }

  const existingProgress = readResumeProgress(bundle.hash);
  const completedIndexes = new Set(
    existingProgress &&
      resolve(existingProgress.repoRoot) === resolve(bundle.repoRoot)
      ? existingProgress.completedIndexes
      : [],
  );
  completedIndexes.add(completedIndex);

  try {
    const directory = resolveResumeProgressDirectory();
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolveResumeProgressPath(bundle.hash),
      JSON.stringify(
        {
          bundleHash: bundle.hash,
          completedIndexes: Array.from(completedIndexes).sort(
            (left, right) => left - right,
          ),
          latestHeadCommit: getHeadCommit(cwd),
          repoRoot: resolve(bundle.repoRoot),
        } satisfies PersistedResumeProgress,
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  } catch {
    // Best-effort progress persistence only.
  }
}

function inferCompletedResumePrefixLength(
  bundle: Pick<PersistedPlanBundle, "plan">,
  selectedIndexes: number[],
  cwd?: string,
): number {
  if (selectedIndexes.length === 0) {
    return 0;
  }

  const recentCommitMessages = getRecentCommitMessages(
    selectedIndexes.length,
    cwd,
  );
  const maxPrefixLength = Math.min(
    selectedIndexes.length,
    recentCommitMessages.length,
  );
  for (
    let prefixLength = maxPrefixLength;
    prefixLength > 0;
    prefixLength -= 1
  ) {
    if (
      matchesCompletedResumePrefix(
        bundle,
        selectedIndexes,
        recentCommitMessages,
        prefixLength,
      )
    ) {
      return prefixLength;
    }
  }

  return 0;
}

function matchesCompletedResumePrefix(
  bundle: Pick<PersistedPlanBundle, "plan">,
  selectedIndexes: number[],
  recentCommitMessages: string[],
  prefixLength: number,
): boolean {
  for (let offset = 0; offset < prefixLength; offset += 1) {
    const selectedIndex = selectedIndexes[prefixLength - 1 - offset];
    const actualMessage = recentCommitMessages[offset];
    if (
      bundle.plan[selectedIndex - 1].message.trim() !== actualMessage.trim()
    ) {
      return false;
    }
  }

  return true;
}

function readResumeProgress(
  bundleHash: string,
): null | PersistedResumeProgress {
  const path = resolveResumeProgressPath(bundleHash);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const completedIndexes = (parsed as { completedIndexes?: unknown })
      .completedIndexes;
    const latestHeadCommit = (parsed as { latestHeadCommit?: unknown })
      .latestHeadCommit;
    const repoRoot = (parsed as { repoRoot?: unknown }).repoRoot;
    const bundleHashValue = (parsed as { bundleHash?: unknown }).bundleHash;
    if (
      bundleHashValue !== bundleHash ||
      !Array.isArray(completedIndexes) ||
      !(latestHeadCommit === null || typeof latestHeadCommit === "string") ||
      typeof repoRoot !== "string"
    ) {
      return null;
    }

    return {
      bundleHash,
      completedIndexes: completedIndexes.filter((index): index is number =>
        Number.isInteger(index),
      ),
      latestHeadCommit,
      repoRoot,
    };
  } catch {
    return null;
  }
}

/**
 * Keep resume progress in a sidecar so immutable saved bundle payloads do not
 * need to change after replay starts.
 */
function resolveResumeProgressDirectory(): string {
  return resolveGitAICmtCacheDirectory("plan-bundle-resume-progress");
}

function resolveResumeProgressPath(bundleHash: string): string {
  return join(resolveResumeProgressDirectory(), `${bundleHash}.json`);
}
