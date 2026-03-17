import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { type Config, ConfigSchema } from "./config-schema.js";
import { ConfigError } from "./errors.js";

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
    promptOnTokenWarning: true,
    tokenWarningThreshold: 10000,
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
const configCache = new Map<string, Config>();

/** System-wide config (Linux/macOS: /etc) */
export function globalConfigPath(): string {
  return "/etc/gitaicmt/config.json";
}

/* ── Path helpers ─────────────────────────────────────────────── */

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
  const dir = resolve(cwd ?? process.cwd());
  const cached = configCache.get(dir);
  if (cached) {
    return cached;
  }

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
  merged = applyEnvironmentOverrides(merged);

  // 5. Validate with Zod schema
  try {
    const parsedConfig = ConfigSchema.parse(merged);
    configCache.set(dir, parsedConfig);
    return parsedConfig;
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
}

export function resetConfigCache(): void {
  configCache.clear();
}

/* ── Deep merge ───────────────────────────────────────────────── */

/** Per-user config (XDG_CONFIG_HOME or ~/.config) */
export function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "gitaicmt", "config.json");
}

/**
 * Apply environment-derived overrides without assuming prior config shape.
 */
function applyEnvironmentOverrides(
  merged: Record<string, unknown>,
): Record<string, unknown> {
  if (!process.env.OPENAI_API_KEY) {
    return merged;
  }

  return {
    ...merged,
    openai: {
      ...(isPlainObject(merged.openai) ? merged.openai : {}),
      apiKey: process.env.OPENAI_API_KEY,
    },
  };
}

/* ── Read a JSON config file (returns null on missing, throws on invalid) */

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const bv = (base as Record<string, unknown>)[key];
    const ov = override[key];
    if (isPlainObject(bv) && isPlainObject(ov)) {
      out[key] = deepMerge(bv, ov);
    } else {
      out[key] = ov;
    }
  }
  return out as T;
}

/* ── loadConfig ───────────────────────────────────────────────── */

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

function readJsonConfig(path: string): null | Record<string, unknown> {
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    throw new ConfigError(`Invalid JSON in configuration file: ${path}`);
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(
      `Configuration file must contain a JSON object: ${path}`,
    );
  }

  return parsed;
}
