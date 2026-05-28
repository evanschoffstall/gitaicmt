import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { PersistedPlanBundle } from "./schemas.js";

import { resolveGitAICmtCacheDirectory } from "../../application/cache-paths.js";
import { loadConfig } from "../../application/config/index.js";
import { getRepositoryRoot } from "../../git/index.js";

export interface BundleFileEntry {
  createdAtMs: number;
  filePath: string;
  repoRoot: null | string;
}

export function evictOverflowPlanBundles(cwd?: string): void {
  const directory = resolvePlanBundleDirectory();
  if (!existsSync(directory)) {
    return;
  }

  const repositoryRoot = resolve(getRepositoryRoot(cwd));
  const entries = listPlanBundleFiles(directory).filter(
    (entry) => entry.repoRoot === repositoryRoot,
  );
  const maxSavedPlanBundles =
    loadConfig(repositoryRoot).performance.maxSavedPlanBundles;
  for (const entry of entries.slice(
    0,
    Math.max(0, entries.length - maxSavedPlanBundles),
  )) {
    unlinkSync(entry.filePath);
  }
}

export function resolvePlanBundleDirectory(): string {
  return resolveGitAICmtCacheDirectory("plan-bundles");
}

export function resolvePlanBundlePath(hash: string): string {
  return join(resolvePlanBundleDirectory(), `${hash}.json`);
}

export function writeBundleFileAtomically(
  path: string,
  bundle: PersistedPlanBundle,
): void {
  const directory = resolvePlanBundleDirectory();
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify(bundle, null, 2) + "\n", "utf-8");
}

function listPlanBundleFiles(directory: string): BundleFileEntry[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const filePath = join(directory, entry);
      return {
        createdAtMs: statSync(filePath).mtimeMs,
        filePath,
        repoRoot: readBundleRepoRoot(filePath),
      };
    })
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
}

/**
 * Best-effort lookup of the owning repository root for a persisted bundle.
 * Invalid or partial bundle files are ignored during repo-scoped eviction so
 * they are never mistaken for the current repository's saved plans.
 */
function readBundleRepoRoot(filePath: string): null | string {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const repoRoot = (parsed as { repoRoot?: unknown }).repoRoot;
    return typeof repoRoot === "string" ? resolve(repoRoot) : null;
  } catch {
    return null;
  }
}
