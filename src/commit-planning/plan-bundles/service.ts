import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { loadConfig } from "../../application/config/index.js";
import { ValidationError } from "../../application/errors.js";
import {
  type FileDiff,
  getHeadCommit,
  getRepositoryRoot,
  parseDiff,
} from "../../git/index.js";
import { clonePlannedCommits } from "../planned-commit-clone.js";
import {
  buildBundleContentHashes,
  buildPlanCommitHashes,
  formatHashMismatchDiagnostic,
  getBundleHashMismatch,
  hashContent,
  normalizePatchContent,
} from "./hashes.js";
import { buildPlanCommitPatches } from "./patches.js";
import {
  type PersistedPlanBundle,
  PersistedPlanBundleSchema,
  PLAN_BUNDLE_SCHEMA_VERSION,
  SHA256_HASH_PATTERN,
} from "./schemas.js";
import {
  evictOverflowPlanBundles,
  resolvePlanBundlePath,
  writeBundleFileAtomically,
} from "./storage.js";

/**
 * Minimal metadata surfaced back to the CLI after saving a bundle.
 */
export interface SavedPlanBundle {
  createdAt: string;
  hash: string;
  path: string;
}

type PlannedCommit = import("../types.js").PlannedCommit;

export function getBundleFileDiffs(bundle: PersistedPlanBundle): FileDiff[] {
  return parseDiff(bundle.stagedPatch);
}

export function loadPlanBundle(hash: string): PersistedPlanBundle {
  validateBundleHash(hash);
  const path = resolvePlanBundlePath(hash);
  if (!existsSync(path)) {
    throw new ValidationError(`Unknown saved plan bundle: ${hash}`);
  }

  const parsed = parsePersistedBundleJson(hash, path);
  const schemaVersion = resolveSchemaVersion(parsed, hash);
  if (schemaVersion !== PLAN_BUNDLE_SCHEMA_VERSION) {
    throw new ValidationError(
      `Saved plan bundle ${hash} uses unsupported schema version ${String(schemaVersion)} (supported: ${String(PLAN_BUNDLE_SCHEMA_VERSION)}).`,
    );
  }

  const result = PersistedPlanBundleSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(
      `Saved plan bundle ${hash} is invalid: ${result.error.issues[0]?.message ?? "unknown validation failure"}`,
      z.treeifyError(result.error),
    );
  }

  return validateLoadedBundle(hash, result.data);
}

export function savePlanBundle(
  plan: PlannedCommit[],
  stagedPatch: string,
  cwd?: string,
): SavedPlanBundle {
  const repoRoot = resolve(getRepositoryRoot(cwd));
  const cfg = loadConfig(repoRoot);
  if (!cfg.performance.cacheEnabled) {
    throw new ValidationError(
      "Plan bundles are disabled because performance.cacheEnabled is false.",
    );
  }

  const normalizedStagedPatch = normalizePatchContent(stagedPatch);
  if (normalizedStagedPatch.trim().length === 0) {
    throw new ValidationError("Cannot save an empty staged patch plan bundle.");
  }
  const createdAt = new Date().toISOString();
  const runNonce = hashContent(
    `${createdAt}|${process.hrtime.bigint().toString()}|${Math.random().toString(36).slice(2)}`,
  );
  const stagedPatchHash = hashContent(normalizedStagedPatch);
  const contentHashes = buildBundleContentHashes(normalizedStagedPatch);
  const serializablePlan = clonePlannedCommits(plan);
  const planCommitHashes = buildPlanCommitHashes(
    serializablePlan,
    contentHashes,
  );
  const planCommitPatches = buildPlanCommitPatches(
    serializablePlan,
    normalizedStagedPatch,
  );
  const headCommit = getHeadCommit(cwd);
  const hash = hashContent(
    JSON.stringify([
      runNonce,
      contentHashes,
      headCommit,
      planCommitHashes,
      planCommitPatches,
      serializablePlan,
      repoRoot,
      stagedPatchHash,
      PLAN_BUNDLE_SCHEMA_VERSION,
    ]),
  );

  const bundle: PersistedPlanBundle = {
    contentHashes,
    createdAt,
    hash,
    headCommit,
    plan: serializablePlan,
    planCommitHashes,
    planCommitPatches,
    repoRoot,
    schemaVersion: PLAN_BUNDLE_SCHEMA_VERSION,
    stagedPatch: normalizedStagedPatch,
    stagedPatchHash,
  };

  const path = resolvePlanBundlePath(hash);
  writeBundleFileAtomically(path, bundle);
  evictOverflowPlanBundles(repoRoot);
  return { createdAt, hash, path };
}

function getPlanCommitHashMismatchSummary(
  expected: { hash: string }[],
  actual: { hash: string }[],
): null | string {
  if (expected.length !== actual.length) {
    return `expected ${String(expected.length)} commit hash entries, found ${String(actual.length)}`;
  }

  for (let index = 0; index < expected.length; index++) {
    if (expected[index]?.hash !== actual[index]?.hash) {
      return `commit ${String(index + 1)} hash differs`;
    }
  }

  return null;
}

function getPlanCommitPatchMismatchSummary(
  expected: string[],
  actual: string[],
): null | string {
  if (expected.length !== actual.length) {
    return `expected ${String(expected.length)} commit patch entries, found ${String(actual.length)}`;
  }

  for (let index = 0; index < expected.length; index++) {
    if (expected[index] !== actual[index]) {
      return `commit ${String(index + 1)} patch differs`;
    }
  }

  return null;
}

function parsePersistedBundleJson(hash: string, path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error: unknown) {
    throw new ValidationError(
      `Saved plan bundle ${hash} contains invalid JSON content.`,
      { cause: String(error) },
    );
  }
}

function resolveSchemaVersion(parsed: unknown, hash: string): number {
  if (!parsed || typeof parsed !== "object") {
    throw new ValidationError(`Saved plan bundle ${hash} is not an object.`);
  }

  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw new ValidationError(
      `Saved plan bundle ${hash} is invalid: missing an integer schemaVersion field.`,
    );
  }

  return schemaVersion;
}

function validateBundleHash(hash: string): void {
  if (!SHA256_HASH_PATTERN.test(hash)) {
    throw new ValidationError(
      `Saved plan bundle hash must be a 64-character lowercase hex string: ${hash}`,
    );
  }
}

function validateLoadedBundle(
  expectedHash: string,
  bundle: PersistedPlanBundle,
): PersistedPlanBundle {
  if (bundle.hash !== expectedHash) {
    throw new ValidationError(
      `Saved plan bundle hash mismatch: expected ${expectedHash}, found ${bundle.hash}.`,
    );
  }

  const expectedStagedPatchHash = hashContent(bundle.stagedPatch);
  if (expectedStagedPatchHash !== bundle.stagedPatchHash) {
    throw new ValidationError(
      `Saved plan bundle ${bundle.hash} failed stagedPatch integrity validation.`,
    );
  }

  const recalculatedContentHashes = buildBundleContentHashes(
    bundle.stagedPatch,
  );
  const contentMismatch = getBundleHashMismatch(
    bundle.contentHashes,
    recalculatedContentHashes,
  );
  if (contentMismatch) {
    throw new ValidationError(
      `Saved plan bundle ${bundle.hash} failed content hash validation: ${formatHashMismatchDiagnostic(contentMismatch)}.`,
    );
  }

  const recalculatedPlanCommitHashes = buildPlanCommitHashes(
    bundle.plan,
    recalculatedContentHashes,
  );
  const planCommitHashMismatch = getPlanCommitHashMismatchSummary(
    bundle.planCommitHashes,
    recalculatedPlanCommitHashes,
  );
  if (planCommitHashMismatch) {
    throw new ValidationError(
      `Saved plan bundle ${bundle.hash} failed plan commit hash validation: ${planCommitHashMismatch}.`,
    );
  }

  const recalculatedPlanCommitPatches = buildPlanCommitPatches(
    bundle.plan,
    bundle.stagedPatch,
  );
  const planCommitPatchMismatch = getPlanCommitPatchMismatchSummary(
    bundle.planCommitPatches,
    recalculatedPlanCommitPatches,
  );
  if (planCommitPatchMismatch) {
    throw new ValidationError(
      `Saved plan bundle ${bundle.hash} failed plan commit patch validation: ${planCommitPatchMismatch}.`,
    );
  }

  return {
    ...bundle,
    plan: clonePlannedCommits(bundle.plan),
  };
}
