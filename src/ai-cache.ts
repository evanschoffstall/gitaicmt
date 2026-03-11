import { createHash } from "crypto";

import { loadConfig } from "./config.js";
import { CACHE_MAX_SIZE } from "./constants.js";

const cache = new Map<string, { msg: string; ts: number }>();

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

export function setCachedMessage(content: string, msg: string): void {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) {
    return;
  }

  cache.set(cacheKey(content), { msg, ts: Date.now() });
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

function evictOldestCacheEntries(): void {
  const cfg = loadConfig();
  const now = Date.now();
  const ttlMs = cfg.performance.cacheTTLSeconds * 1000;

  for (const [key, entry] of cache.entries()) {
    if (now - entry.ts > ttlMs) {
      cache.delete(key);
    }
  }

  if (cache.size > CACHE_MAX_SIZE) {
    const entries = Array.from(cache.entries()).sort(
      (left, right) => left[1].ts - right[1].ts,
    );
    const toDelete = entries.slice(0, cache.size - CACHE_MAX_SIZE);
    for (const [key] of toDelete) {
      cache.delete(key);
    }
  }
}
