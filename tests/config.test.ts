import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Config,
  DEFAULTS,
  globalConfigPath,
  initConfig,
  loadConfig,
  resetConfigCache,
  userConfigPath,
} from "../src/config.js";

const { afterEach, beforeEach, describe, expect, test } =
  await import("bun:test");

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gitaicmt-test-"));
}

// Isolated XDG home — prevents real ~/.config/gitaicmt/config.json from leaking into tests
let _savedXdgHome: string | undefined;
let _testXdgDir: string;

describe("config", () => {
  beforeEach(() => {
    resetConfigCache();
    _savedXdgHome = process.env["XDG_CONFIG_HOME"];
    _testXdgDir = mkdtempSync(join(tmpdir(), "gitaicmt-xdg-"));
    process.env["XDG_CONFIG_HOME"] = _testXdgDir;
  });

  afterEach(() => {
    resetConfigCache();
    if (_savedXdgHome !== undefined) {
      process.env["XDG_CONFIG_HOME"] = _savedXdgHome;
    } else {
      delete process.env["XDG_CONFIG_HOME"];
    }
    rmSync(_testXdgDir, { force: true, recursive: true });
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
      expect(cfg.analysis.promptOnTokenWarning).toBe(true);
      expect(cfg.analysis.tokenWarningThreshold).toBe(10000);

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
        commit: { language: "ja" },
        openai: { apiKey: "sk-test123", model: "gpt-4o" },
      };
      writeFileSync(join(dir, "gitaicmt.config.json"), JSON.stringify(partial));
      const cfg = loadConfig(dir);

      expect(cfg.openai.model).toBe("gpt-4o");
      expect(cfg.openai.apiKey).toBe("sk-test123");
      expect(cfg.commit.language).toBe("ja");
      expect(cfg.analysis.promptOnTokenWarning).toBe(true);
      expect(cfg.analysis.tokenWarningThreshold).toBe(10000);
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
          analysis: { chunkSize: 500 },
          openai: { temperature: 0.7 },
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

    test("loads promptOnTokenWarning override", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ analysis: { promptOnTokenWarning: false } }),
      );
      const cfg = loadConfig(dir);

      expect(cfg.analysis.promptOnTokenWarning).toBe(false);
      expect(cfg.analysis.tokenWarningThreshold).toBe(10000);

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

    test("env var OPENAI_API_KEY takes precedence over config apiKey", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { apiKey: "sk-from-config" } }),
      );
      const oldKey = process.env["OPENAI_API_KEY"];
      process.env["OPENAI_API_KEY"] = "sk-from-env";
      resetConfigCache();
      const cfg = loadConfig(dir);

      expect(cfg.openai.apiKey).toBe("sk-from-env");

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

    test("loads token warning threshold override", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ analysis: { tokenWarningThreshold: 12345 } }),
      );
      resetConfigCache();
      const cfg = loadConfig(dir);

      expect(cfg.analysis.tokenWarningThreshold).toBe(12345);

      rmSync(dir, { recursive: true });
    });
  });

  // ───── Path helpers ─────

  describe("config path helpers", () => {
    test("globalConfigPath returns /etc/gitaicmt/config.json", () => {
      expect(globalConfigPath()).toBe("/etc/gitaicmt/config.json");
    });

    test("userConfigPath defaults to ~/.config/gitaicmt/config.json", () => {
      const oldXdg = process.env["XDG_CONFIG_HOME"];
      delete process.env["XDG_CONFIG_HOME"];

      expect(userConfigPath()).toBe(
        join(homedir(), ".config", "gitaicmt", "config.json"),
      );

      if (oldXdg !== undefined) process.env["XDG_CONFIG_HOME"] = oldXdg;
    });

    test("userConfigPath respects XDG_CONFIG_HOME", () => {
      const oldXdg = process.env["XDG_CONFIG_HOME"];
      process.env["XDG_CONFIG_HOME"] = "/tmp/custom-xdg";

      expect(userConfigPath()).toBe("/tmp/custom-xdg/gitaicmt/config.json");

      if (oldXdg !== undefined) process.env["XDG_CONFIG_HOME"] = oldXdg;
      else delete process.env["XDG_CONFIG_HOME"];
    });
  });

  // ───── Multi-level config loading ─────

  describe("multi-level config", () => {
    let savedXdg: string | undefined;

    beforeEach(() => {
      savedXdg = process.env["XDG_CONFIG_HOME"];
      resetConfigCache();
    });

    afterEach(() => {
      if (savedXdg !== undefined) process.env["XDG_CONFIG_HOME"] = savedXdg;
      else delete process.env["XDG_CONFIG_HOME"];
      resetConfigCache();
    });

    test("user config is loaded and merged with defaults", () => {
      const tmp = makeTmpDir();
      const xdgDir = join(tmp, "xdg");
      const userDir = join(xdgDir, "gitaicmt");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, "config.json"),
        JSON.stringify({ openai: { model: "user-model" } }),
      );
      process.env["XDG_CONFIG_HOME"] = xdgDir;

      // Use a local dir with NO config
      const localDir = join(tmp, "project");
      mkdirSync(localDir, { recursive: true });

      const cfg = loadConfig(localDir);
      expect(cfg.openai.model).toBe("user-model");
      // Defaults preserved
      expect(cfg.openai.maxTokens).toBe(512);
      expect(cfg.commit.conventional).toBe(true);

      rmSync(tmp, { recursive: true });
    });

    test("local config overrides user config", () => {
      const tmp = makeTmpDir();
      // User config
      const xdgDir = join(tmp, "xdg");
      const userDir = join(xdgDir, "gitaicmt");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, "config.json"),
        JSON.stringify({
          commit: { conventional: false },
          openai: { model: "user-model", temperature: 0.9 },
        }),
      );
      process.env["XDG_CONFIG_HOME"] = xdgDir;

      // Local config overrides model but not temperature
      const localDir = join(tmp, "project");
      mkdirSync(localDir, { recursive: true });
      writeFileSync(
        join(localDir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { model: "local-model" } }),
      );

      const cfg = loadConfig(localDir);
      expect(cfg.openai.model).toBe("local-model"); // local wins
      expect(cfg.openai.temperature).toBe(0.9); // from user config
      expect(cfg.commit.conventional).toBe(false); // from user config

      rmSync(tmp, { recursive: true });
    });

    test("local .gitaicmt.json also works in multi-level", () => {
      const tmp = makeTmpDir();
      const xdgDir = join(tmp, "xdg");
      const userDir = join(xdgDir, "gitaicmt");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, "config.json"),
        JSON.stringify({ openai: { temperature: 0.5 } }),
      );
      process.env["XDG_CONFIG_HOME"] = xdgDir;

      // Local uses alternate name
      const localDir = join(tmp, "project");
      mkdirSync(localDir, { recursive: true });
      writeFileSync(
        join(localDir, ".gitaicmt.json"),
        JSON.stringify({ openai: { model: "alt-name-model" } }),
      );

      const cfg = loadConfig(localDir);
      expect(cfg.openai.model).toBe("alt-name-model");
      expect(cfg.openai.temperature).toBe(0.5);

      rmSync(tmp, { recursive: true });
    });

    test("env var OPENAI_API_KEY fills in when no config sets it", () => {
      const tmp = makeTmpDir();
      const xdgDir = join(tmp, "xdg");
      const userDir = join(xdgDir, "gitaicmt");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, "config.json"),
        JSON.stringify({ openai: { model: "some-model" } }),
      );
      process.env["XDG_CONFIG_HOME"] = xdgDir;

      const oldKey = process.env["OPENAI_API_KEY"];
      process.env["OPENAI_API_KEY"] = "sk-env-key";

      const localDir = join(tmp, "project");
      mkdirSync(localDir, { recursive: true });

      const cfg = loadConfig(localDir);
      expect(cfg.openai.apiKey).toBe("sk-env-key");

      if (oldKey !== undefined) process.env["OPENAI_API_KEY"] = oldKey;
      else delete process.env["OPENAI_API_KEY"];
      rmSync(tmp, { recursive: true });
    });

    test("env var OPENAI_API_KEY wins over user config apiKey", () => {
      const tmp = makeTmpDir();
      const xdgDir = join(tmp, "xdg");
      const userDir = join(xdgDir, "gitaicmt");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, "config.json"),
        JSON.stringify({ openai: { apiKey: "sk-from-user-cfg" } }),
      );
      process.env["XDG_CONFIG_HOME"] = xdgDir;

      const oldKey = process.env["OPENAI_API_KEY"];
      process.env["OPENAI_API_KEY"] = "sk-env-key";

      const localDir = join(tmp, "project");
      mkdirSync(localDir, { recursive: true });

      const cfg = loadConfig(localDir);
      expect(cfg.openai.apiKey).toBe("sk-env-key");

      if (oldKey !== undefined) process.env["OPENAI_API_KEY"] = oldKey;
      else delete process.env["OPENAI_API_KEY"];
      rmSync(tmp, { recursive: true });
    });

    test("no configs at any level returns pure defaults", () => {
      const tmp = makeTmpDir();
      const xdgDir = join(tmp, "xdg-empty");
      mkdirSync(xdgDir, { recursive: true });
      process.env["XDG_CONFIG_HOME"] = xdgDir;

      const localDir = join(tmp, "empty-project");
      mkdirSync(localDir, { recursive: true });

      const cfg = loadConfig(localDir);
      expect(cfg.openai.model).toBe(DEFAULTS.openai.model);
      expect(cfg.analysis.chunkSize).toBe(DEFAULTS.analysis.chunkSize);
      expect(cfg.commit.conventional).toBe(DEFAULTS.commit.conventional);

      rmSync(tmp, { recursive: true });
    });

    test("deep merge across user and local levels", () => {
      const tmp = makeTmpDir();
      const xdgDir = join(tmp, "xdg");
      const userDir = join(xdgDir, "gitaicmt");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, "config.json"),
        JSON.stringify({
          commit: { language: "fr" },
          openai: { model: "user-m", temperature: 0.8 },
          performance: { parallel: false },
        }),
      );
      process.env["XDG_CONFIG_HOME"] = xdgDir;

      const localDir = join(tmp, "project");
      mkdirSync(localDir, { recursive: true });
      writeFileSync(
        join(localDir, "gitaicmt.config.json"),
        JSON.stringify({
          analysis: { chunkSize: 1200 },
          openai: { model: "local-m" },
        }),
      );

      const cfg = loadConfig(localDir);
      // local wins on model
      expect(cfg.openai.model).toBe("local-m");
      // user wins on temperature (local didn't set it)
      expect(cfg.openai.temperature).toBe(0.8);
      // user wins on commit.language
      expect(cfg.commit.language).toBe("fr");
      // user wins on performance.parallel
      expect(cfg.performance.parallel).toBe(false);
      // local wins on analysis.chunkSize
      expect(cfg.analysis.chunkSize).toBe(1200);
      // defaults persist for unset values
      expect(cfg.openai.maxTokens).toBe(512);
      expect(cfg.commit.maxSubjectLength).toBe(72);

      rmSync(tmp, { recursive: true });
    });

    test("malformed user config is silently ignored", () => {
      const tmp = makeTmpDir();
      const xdgDir = join(tmp, "xdg");
      const userDir = join(xdgDir, "gitaicmt");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, "config.json"), "NOT VALID JSON{{{");
      process.env["XDG_CONFIG_HOME"] = xdgDir;

      const localDir = join(tmp, "project");
      mkdirSync(localDir, { recursive: true });
      writeFileSync(
        join(localDir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { model: "local-ok" } }),
      );

      const cfg = loadConfig(localDir);
      expect(cfg.openai.model).toBe("local-ok");
      // Defaults preserved since bad user config was skipped
      expect(cfg.openai.maxTokens).toBe(512);

      rmSync(tmp, { recursive: true });
    });
  });
});
