import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface OpenAISettings {
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface AnalysisSettings {
  maxDiffLines: number;
  chunkSize: number;
  groupByFile: boolean;
  groupByHunk: boolean;
}

export interface CommitSettings {
  conventional: boolean;
  maxSubjectLength: number;
  maxBodyLineLength: number;
  includeScope: boolean;
  includeBody: boolean;
  language: string;
}

export interface PerformanceSettings {
  parallel: boolean;
  cacheEnabled: boolean;
  cacheTTLSeconds: number;
  timeoutMs: number;
}

export interface Config {
  openai: OpenAISettings;
  analysis: AnalysisSettings;
  commit: CommitSettings;
  performance: PerformanceSettings;
}

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

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const out = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override)) {
    const bv = (base as Record<string, unknown>)[key];
    const ov = override[key];
    if (
      bv &&
      typeof bv === "object" &&
      !Array.isArray(bv) &&
      ov &&
      typeof ov === "object" &&
      !Array.isArray(ov)
    ) {
      out[key] = deepMerge(
        bv as Record<string, unknown>,
        ov as Record<string, unknown>,
      );
    } else {
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

  _cached = merged as unknown as Config;

  // 4. Env override for API key (lowest-priority fallback)
  if (!_cached.openai.apiKey && process.env["OPENAI_API_KEY"]) {
    _cached.openai.apiKey = process.env["OPENAI_API_KEY"];
  }
  return _cached;
}

export function resetConfigCache(): void {
  _cached = null;
}

export function initConfig(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const target = resolve(dir, "gitaicmt.config.json");
  if (existsSync(target)) return target;
  writeFileSync(target, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf-8");
  return target;
}
