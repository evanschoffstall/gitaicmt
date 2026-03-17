import { createHash } from "crypto";

import { loadConfig } from "../application/config.js";
import { CACHE_MAX_SIZE } from "../application/constants.js";

type GroupingPromptContext =
  import("./prompt-builders/index.js").GroupingPromptContext;
type PlannedCommit = import("./types.js").PlannedCommit;

const cache = new Map<string, { msg: string; ts: number }>();
const planCache = new Map<string, { plan: PlannedCommit[]; ts: number }>();

export function getCachedMessage(content: string): null | string {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) {
    return null;
  }

  const key = cacheKey(content);
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > cfg.performance.cacheTTLSeconds * 1000) {
    cache.delete(key);
    return null;
  }
  return entry.msg;
}

export function getCachedPlan(planInput: string): null | PlannedCommit[] {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) {
    return null;
  }

  const key = planCacheKey(planInput);
  const entry = planCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > cfg.performance.cacheTTLSeconds * 1000) {
    planCache.delete(key);
    return null;
  }

  return clonePlan(entry.plan);
}

export function resetAiCache(): void {
  cache.clear();
  planCache.clear();
}

export function serializePlanCacheInput(
  files: { path: string }[],
  formattedDiffs: string[],
  promptContext?: GroupingPromptContext,
): string {
  return JSON.stringify({
    allFiles: promptContext?.allFiles?.map((file) => file.path) ?? [],
    batchCount: promptContext?.batchCount ?? 0,
    batchIndex: promptContext?.batchIndex ?? 0,
    deferFinalization: promptContext?.deferFinalization ?? false,
    files: files.map((file, index) => ({
      content: formattedDiffs[index] ?? "",
      path: file.path,
    })),
  });
}

export function setCachedMessage(content: string, msg: string): void {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) {
    return;
  }

  cache.set(cacheKey(content), { msg, ts: Date.now() });
  evictOldestCacheEntries();
}

export function setCachedPlan(planInput: string, plan: PlannedCommit[]): void {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) {
    return;
  }

  planCache.set(planCacheKey(planInput), {
    plan: clonePlan(plan),
    ts: Date.now(),
  });
  evictOldestCacheEntries();
}

function cacheKey(content: string): string {
  const cfg = loadConfig();
  const version = "v3";
  const configFingerprint = `${cfg.openai.model}|${String(cfg.openai.temperature)}|${String(cfg.commit.conventional)}`;
  return createHash("sha256")
    .update(version + configFingerprint + content)
    .digest("hex");
}

function clonePlan(plan: PlannedCommit[]): PlannedCommit[] {
  return plan.map((group) => ({
    files: group.files.map((file) => ({
      ...(file.hunks ? { hunks: [...file.hunks] } : {}),
      path: file.path,
    })),
    message: group.message,
  }));
}

function evictOldestCacheEntries(): void {
  const cfg = loadConfig();
  const now = Date.now();
  const ttlMs = cfg.performance.cacheTTLSeconds * 1000;

  for (const [key, entry] of cache.entries()) {
    if (now - entry.ts > ttlMs) {
      cache.delete(key);
    }
  }

  for (const [key, entry] of planCache.entries()) {
    if (now - entry.ts > ttlMs) {
      planCache.delete(key);
    }
  }

  evictOverflow(cache);
  evictOverflow(planCache);
}

function evictOverflow<T>(target: Map<string, T & { ts: number }>): void {
  if (target.size <= CACHE_MAX_SIZE) {
    return;
  }

  const entries = Array.from(target.entries()).sort(
    (left, right) => left[1].ts - right[1].ts,
  );
  const toDelete = entries.slice(0, target.size - CACHE_MAX_SIZE);
  for (const [key] of toDelete) {
    target.delete(key);
  }
}

function planCacheKey(content: string): string {
  const cfg = loadConfig();
  const version = "v1";
  const configFingerprint = [
    cfg.openai.model,
    String(cfg.openai.temperature),
    String(cfg.commit.conventional),
    String(cfg.commit.includeScope),
    String(cfg.commit.includeBody),
    cfg.commit.language,
    String(cfg.commit.maxSubjectLength),
    String(cfg.commit.maxBodyLineLength),
  ].join("|");

  return createHash("sha256")
    .update(version + configFingerprint + content)
    .digest("hex");
}
