import { createHash } from "crypto";

import { loadConfig } from "../application/config/index.js";
import { CACHE_MAX_SIZE } from "../application/constants.js";
import { clonePlannedCommits } from "./planned-commit-clone.js";

type GroupingPromptContext = import("./prompts/index.js").GroupingPromptContext;
type PlannedCommit = import("./types.js").PlannedCommit;

const cache = new Map<string, { msg: string; ts: number }>();
const planCache = new Map<string, { plan: PlannedCommit[]; ts: number }>();

export function getCachedMessage(
  content: string,
  promptMode = "default",
): null | string {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) {
    return null;
  }

  const key = cacheKey(content, promptMode);
  const entry = cache.get(key);
  if (!entry) {
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

  return clonePlannedCommits(entry.plan);
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
    breakingMode: promptContext?.breakingMode ?? "normal",
    deferFinalization: promptContext?.deferFinalization ?? false,
    files: files.map((file, index) => ({
      content: formattedDiffs[index] ?? "",
      path: file.path,
    })),
  });
}

export function setCachedMessage(
  content: string,
  msg: string,
  promptMode = "default",
): void {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) {
    return;
  }

  cache.set(cacheKey(content, promptMode), { msg, ts: Date.now() });
  evictOldestCacheEntries();
}

export function setCachedPlan(planInput: string, plan: PlannedCommit[]): void {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) {
    return;
  }

  planCache.set(planCacheKey(planInput), {
    plan: clonePlannedCommits(plan),
    ts: Date.now(),
  });
  evictOldestCacheEntries();
}

function cacheKey(content: string, promptMode: string): string {
  const cfg = loadConfig();
  const version = "v6";
  const configFingerprint = `${cfg.openai.model}|${String(cfg.openai.temperature)}|${String(cfg.commit.conventional)}`;
  return createHash("sha256")
    .update(version + configFingerprint + promptMode + content)
    .digest("hex");
}

function evictOldestCacheEntries(): void {
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
