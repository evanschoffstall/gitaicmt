import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigError } from "./errors.js";
import type { Config } from "./schemas.js";
import { ConfigSchema } from "./schemas.js";

export const DEFAULTS: Config = {
  openai: {
    apiKey: "",
    model: "gpt-4o-mini",
    maxTokens: 512,
    temperature: 0.3,
  },
  analysis: {
    maxDiffLines: 2000,
    chunkSize: 800,
    groupByFile: true,
    groupByHunk: true,
  },
  commit: {
    conventional: true,
    maxSubjectLength: 72,
    maxBodyLineLength: 80,
    includeScope: true,
    includeBody: true,
    language: "en",
  },
  performance: {
    parallel: true,
    cacheEnabled: true,
    cacheTTLSeconds: 300,
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
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg || join(homedir(), ".config");
  return join(base, "gitaicmt", "config.json");
}

/** Find a local (project-level) config in `cwd` */
function findLocalConfig(cwd: string): string | null {
  for (const name of LOCAL_CONFIG_NAMES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/* ── Deep merge ───────────────────────────────────────────────── */

/** Check if value is a plain object (not array, null, or built-in) */
function isPlainObject(val: unknown): val is Record<string, unknown> {
  return (
    val !== null &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    Object.getPrototypeOf(val) === Object.prototype
  );
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
      // Type-check basic types to prevent mismatches
      if (bv !== undefined && ov !== null) {
        const baseType = typeof bv;
        const overrideType = typeof ov;
        // Allow number -> number, string -> string, boolean -> boolean
        // Arrays replace entirely (no element merge)
        if (
          baseType !== overrideType &&
          !(baseType === "number" && overrideType === "number") &&
          !(baseType === "string" && overrideType === "string") &&
          !(baseType === "boolean" && overrideType === "boolean")
        ) {
          // Skip mismatched types; keep base value
          continue;
        }
      }
      out[key] = ov;
    }
  }
  return out as T;
}

/* ── Read a JSON config file (returns null on missing / bad JSON) */

function readJsonConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ── loadConfig ───────────────────────────────────────────────── */

let _cached: Config | null = null;

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
    merged = deepMerge(merged, globalRaw) as Record<string, unknown>;
  }

  // 2. User config
  const userRaw = readJsonConfig(userConfigPath());
  if (userRaw) {
    merged = deepMerge(merged, userRaw) as Record<string, unknown>;
  }

  // 3. Local config (project-level)
  const localFile = findLocalConfig(dir);
  if (localFile) {
    const localRaw = readJsonConfig(localFile);
    if (localRaw) {
      merged = deepMerge(merged, localRaw) as Record<string, unknown>;
    }
  }

  // 4. Env override for API key (HIGHEST priority - overrides all configs)
  if (process.env["OPENAI_API_KEY"]) {
    (merged.openai as Record<string, unknown>).apiKey =
      process.env["OPENAI_API_KEY"];
  }

  // 5. Validate with Zod schema
  try {
    _cached = ConfigSchema.parse(merged);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "errors" in err) {
      const zodErr = err as {
        errors: Array<{ path: string[]; message: string }>;
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
  // Also reset OpenAI client to prevent stale API key usage
  // Dynamic import to avoid circular dependency
  import("./ai.js").then((ai) => ai.resetClient()).catch(() => {});
}

export function initConfig(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const target = resolve(dir, "gitaicmt.config.json");
  if (existsSync(target)) return target;
  writeFileSync(target, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf-8");
  return target;
}
