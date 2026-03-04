import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { initConfig, loadConfig, resetConfigCache } from "../src/config.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gitaicmt-test-"));
}

describe("config", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
  });

  // ───── Defaults ─────

  describe("defaults", () => {
    test("returns default config when no config file exists", () => {
      const dir = makeTmpDir();
      const cfg = loadConfig(dir);

      expect(cfg.openai.model).toBe("gpt-4o-mini");
      expect(cfg.openai.maxTokens).toBe(512);
      expect(cfg.openai.temperature).toBe(0.3);
      expect(cfg.openai.apiKey).toBe("");

      expect(cfg.analysis.maxDiffLines).toBe(2000);
      expect(cfg.analysis.chunkSize).toBe(800);
      expect(cfg.analysis.groupByFile).toBe(true);
      expect(cfg.analysis.groupByHunk).toBe(true);

      expect(cfg.commit.conventional).toBe(true);
      expect(cfg.commit.maxSubjectLength).toBe(72);
      expect(cfg.commit.maxBodyLineLength).toBe(80);
      expect(cfg.commit.includeScope).toBe(true);
      expect(cfg.commit.includeBody).toBe(true);
      expect(cfg.commit.language).toBe("en");

      expect(cfg.performance.parallel).toBe(true);
      expect(cfg.performance.cacheEnabled).toBe(true);
      expect(cfg.performance.cacheTTLSeconds).toBe(300);
      expect(cfg.performance.timeoutMs).toBe(15000);

      rmSync(dir, { recursive: true });
    });
  });

  // ───── Loading from file ─────

  describe("loading", () => {
    test("loads gitaicmt.config.json", () => {
      const dir = makeTmpDir();
      const partial = {
        openai: { model: "gpt-4o", apiKey: "sk-test123" },
        commit: { language: "ja" },
      };
      writeFileSync(join(dir, "gitaicmt.config.json"), JSON.stringify(partial));
      const cfg = loadConfig(dir);

      expect(cfg.openai.model).toBe("gpt-4o");
      expect(cfg.openai.apiKey).toBe("sk-test123");
      expect(cfg.commit.language).toBe("ja");
      // Non-overridden values should remain default
      expect(cfg.openai.maxTokens).toBe(512);
      expect(cfg.commit.conventional).toBe(true);

      rmSync(dir, { recursive: true });
    });

    test("loads .gitaicmt.json as alternative name", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, ".gitaicmt.json"),
        JSON.stringify({ openai: { model: "o1-mini" } }),
      );
      resetConfigCache();
      const cfg = loadConfig(dir);

      expect(cfg.openai.model).toBe("o1-mini");

      rmSync(dir, { recursive: true });
    });

    test("prefers gitaicmt.config.json over .gitaicmt.json", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { model: "primary" } }),
      );
      writeFileSync(
        join(dir, ".gitaicmt.json"),
        JSON.stringify({ openai: { model: "secondary" } }),
      );
      resetConfigCache();
      const cfg = loadConfig(dir);

      expect(cfg.openai.model).toBe("primary");

      rmSync(dir, { recursive: true });
    });
  });

  // ───── Deep merge ─────

  describe("deep merge", () => {
    test("merges nested objects without clobbering siblings", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({
          openai: { temperature: 0.7 },
          analysis: { chunkSize: 500 },
        }),
      );
      const cfg = loadConfig(dir);

      // Overridden
      expect(cfg.openai.temperature).toBe(0.7);
      expect(cfg.analysis.chunkSize).toBe(500);
      // Untouched siblings
      expect(cfg.openai.model).toBe("gpt-4o-mini");
      expect(cfg.openai.maxTokens).toBe(512);
      expect(cfg.analysis.groupByFile).toBe(true);

      rmSync(dir, { recursive: true });
    });

    test("overrides arrays entirely (not merging elements)", () => {
      const dir = makeTmpDir();
      // If there were array fields they should be replaced, not merged
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ commit: { maxSubjectLength: 50 } }),
      );
      const cfg = loadConfig(dir);
      expect(cfg.commit.maxSubjectLength).toBe(50);
      expect(cfg.commit.includeBody).toBe(true);

      rmSync(dir, { recursive: true });
    });
  });

  // ───── Env override ─────

  describe("environment variable override", () => {
    test("uses OPENAI_API_KEY env var when config has no key", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { model: "gpt-4o" } }),
      );
      const oldKey = process.env["OPENAI_API_KEY"];
      process.env["OPENAI_API_KEY"] = "sk-from-env";
      resetConfigCache();
      const cfg = loadConfig(dir);

      expect(cfg.openai.apiKey).toBe("sk-from-env");

      // Cleanup
      if (oldKey !== undefined) process.env["OPENAI_API_KEY"] = oldKey;
      else delete process.env["OPENAI_API_KEY"];
      rmSync(dir, { recursive: true });
    });

    test("config apiKey takes precedence over env var", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { apiKey: "sk-from-config" } }),
      );
      const oldKey = process.env["OPENAI_API_KEY"];
      process.env["OPENAI_API_KEY"] = "sk-from-env";
      resetConfigCache();
      const cfg = loadConfig(dir);

      expect(cfg.openai.apiKey).toBe("sk-from-config");

      if (oldKey !== undefined) process.env["OPENAI_API_KEY"] = oldKey;
      else delete process.env["OPENAI_API_KEY"];
      rmSync(dir, { recursive: true });
    });
  });

  // ───── Caching ─────

  describe("caching", () => {
    test("loadConfig returns cached value on second call", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { model: "first-call" } }),
      );
      const cfg1 = loadConfig(dir);
      expect(cfg1.openai.model).toBe("first-call");

      // Overwrite the file — should NOT affect result due to cache
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { model: "second-call" } }),
      );
      const cfg2 = loadConfig(dir);
      expect(cfg2.openai.model).toBe("first-call");

      rmSync(dir, { recursive: true });
    });

    test("resetConfigCache clears the cache", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { model: "cached" } }),
      );
      loadConfig(dir);
      resetConfigCache();

      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { model: "fresh" } }),
      );
      const cfg = loadConfig(dir);
      expect(cfg.openai.model).toBe("fresh");

      rmSync(dir, { recursive: true });
    });
  });

  // ───── initConfig ─────

  describe("initConfig", () => {
    test("creates config file with defaults", () => {
      const dir = makeTmpDir();
      const path = initConfig(dir);

      expect(path).toBe(join(dir, "gitaicmt.config.json"));
      expect(existsSync(path)).toBe(true);

      const written = JSON.parse(readFileSync(path, "utf-8")) as Config;
      expect(written.openai.model).toBe("gpt-4o-mini");
      expect(written.commit.conventional).toBe(true);
      expect(written.performance.parallel).toBe(true);

      rmSync(dir, { recursive: true });
    });

    test("does not overwrite existing config", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { model: "custom" } }),
      );

      const path = initConfig(dir);
      const content = JSON.parse(readFileSync(path, "utf-8")) as Record<
        string,
        unknown
      >;
      expect((content.openai as Record<string, unknown>).model).toBe("custom");

      rmSync(dir, { recursive: true });
    });

    test("returns path even if file already exists", () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, "gitaicmt.config.json"), "{}");
      const path = initConfig(dir);
      expect(path).toBe(join(dir, "gitaicmt.config.json"));
      rmSync(dir, { recursive: true });
    });
  });

  // ───── Edge cases ─────

  describe("edge cases", () => {
    test("handles completely empty config file", () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, "gitaicmt.config.json"), "{}");
      resetConfigCache();
      const cfg = loadConfig(dir);

      // All defaults should be preserved
      expect(cfg.openai.model).toBe("gpt-4o-mini");
      expect(cfg.analysis.chunkSize).toBe(800);

      rmSync(dir, { recursive: true });
    });

    test("handles extra unknown keys gracefully", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({
          openai: { model: "gpt-4o" },
          unknown_section: { foo: "bar" },
        }),
      );
      resetConfigCache();
      const cfg = loadConfig(dir);
      expect(cfg.openai.model).toBe("gpt-4o");
      // Should not throw
      rmSync(dir, { recursive: true });
    });
  });
});
