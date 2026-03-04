import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

const DEFAULTS: Config = {
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

const CONFIG_NAMES = ["gitaicmt.config.json", ".gitaicmt.json"];

function findConfig(cwd: string): string | null {
  for (const name of CONFIG_NAMES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

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

let _cached: Config | null = null;

export function loadConfig(cwd?: string): Config {
  if (_cached) return _cached;
  const dir = cwd ?? process.cwd();
  const file = findConfig(dir);
  if (!file) {
    _cached = DEFAULTS;
    return _cached;
  }
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<
    string,
    unknown
  >;
  _cached = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    raw,
  ) as unknown as Config;

  // Allow env override for API key
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
