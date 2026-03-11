import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ConfigError } from "./errors.js";
import { type Config, ConfigSchema } from "./schemas.js";

// Re-export Config type for external use
export type { Config };

/**
 * Recommended text-generation models for gitaicmt (commit message generation).
 *
 * Stable defaults:
 * - gpt-4o-mini
 * - gpt-4o
 * - gpt-4.1-mini
 * - gpt-4.1
 *
 * Newer options:
 * - gpt-5-mini
 * - gpt-5
 * - gpt-5.3-chat-latest
 * - gpt-5.3-codex
 *
 * Also supported:
 * - o3
 * - o4-mini
 *
 * Note: search/audio/transcribe/tts/realtime model variants are intentionally
 * omitted here because they are not suitable for commit-message text generation.
 */
export const DEFAULTS: Config = {
  analysis: {
    chunkSize: 800,
    groupByFile: true,
    groupByHunk: true,
    maxDiffLines: 2000,
  },
  commit: {
    conventional: true,
    includeBody: true,
    includeScope: true,
    language: "en",
    maxBodyLineLength: 80,
    maxSubjectLength: 72,
  },
  openai: {
    apiKey: "",
    maxTokens: 512,
    model: "gpt-4o-mini",
    temperature: 0.3,
  },
  performance: {
    cacheEnabled: true,
    cacheTTLSeconds: 300,
    parallel: true,
    timeoutMs: 15000,
  },
};

const LOCAL_CONFIG_NAMES = ["gitaicmt.config.json", ".gitaicmt.json"];

/* ── Path helpers ─────────────────────────────────────────────── */

/** System-wide config (Linux/macOS: /etc) */
export function globalConfigPath(): string {
  return "/etc/gitaicmt/config.json";
}

/** Per-user config (XDG_CONFIG_HOME or ~/.config) */
export function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "gitaicmt", "config.json");
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const bv = (base as Record<string, unknown>)[key];
    const ov = override[key];
    // Only merge if both values are plain objects
    if (isPlainObject(bv) && isPlainObject(ov)) {
      out[key] = deepMerge(bv, ov);
    } else {
      // Type-check to prevent mismatches that would break config schema
      if (bv !== undefined && ov !== null && ov !== undefined) {
        const baseType = typeof bv;
        const overrideType = typeof ov;
        const baseIsArray = Array.isArray(bv);
        const overrideIsArray = Array.isArray(ov);

        // Check for type mismatches
        if (baseIsArray !== overrideIsArray) {
          // Skip: array/non-array mismatch
          continue;
        }

        if (!baseIsArray && baseType !== overrideType) {
          // Skip: primitive type mismatch (number/string, string/boolean, etc.)
          continue;
        }
      }
      out[key] = ov;
    }
  }
  return out as T;
}

/* ── Deep merge ───────────────────────────────────────────────── */

/** Find a local (project-level) config in `cwd` */
function findLocalConfig(cwd: string): null | string {
  for (const name of LOCAL_CONFIG_NAMES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Check if value is a plain object (not array, null, or built-in) */
function isPlainObject(val: unknown): val is Record<string, unknown> {
  return (
    val !== null &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    Object.getPrototypeOf(val) === Object.prototype
  );
}

/* ── Read a JSON config file (returns null on missing / bad JSON) */

function readJsonConfig(path: string): null | Record<string, unknown> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ── loadConfig ───────────────────────────────────────────────── */

let _cached: Config | null = null;

export function initConfig(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const target = resolve(dir, "gitaicmt.config.json");
  if (existsSync(target)) return target;
  writeFileSync(target, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf-8");
  return target;
}

/**
 * Load config with multi-level merge (lowest → highest priority):
 *   DEFAULTS → global (/etc) → user (~/.config) → local (cwd) → env vars
 *
 * @throws {ConfigError} If configuration is invalid
 */
export function loadConfig(cwd?: string): Config {
  if (_cached) return _cached;
  const dir = cwd ?? process.cwd();

  let merged: Record<string, unknown> = {
    ...(DEFAULTS as unknown as Record<string, unknown>),
  };

  // 1. Global config
  const globalRaw = readJsonConfig(globalConfigPath());
  if (globalRaw) {
    merged = deepMerge(merged, globalRaw);
  }

  // 2. User config
  const userRaw = readJsonConfig(userConfigPath());
  if (userRaw) {
    merged = deepMerge(merged, userRaw);
  }

  // 3. Local config (project-level)
  const localFile = findLocalConfig(dir);
  if (localFile) {
    const localRaw = readJsonConfig(localFile);
    if (localRaw) {
      merged = deepMerge(merged, localRaw);
    }
  }

  // 4. Env override for API key (HIGHEST priority - overrides all configs)
  if (process.env.OPENAI_API_KEY) {
    (merged.openai as Record<string, unknown>).apiKey =
      process.env.OPENAI_API_KEY;
  }

  // 5. Validate with Zod schema
  try {
    _cached = ConfigSchema.parse(merged);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "errors" in err) {
      const zodErr = err as {
        errors: { message: string; path: string[] }[];
      };
      const errors = zodErr.errors
        .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
        .join("\n");
      throw new ConfigError(`Configuration validation failed:\n${errors}`);
    }
    throw new ConfigError(`Configuration validation failed: ${String(err)}`);
  }

  return _cached;
}

export function resetConfigCache(): void {
  _cached = null;
}
