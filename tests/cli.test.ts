import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedCommit } from "../src/ai.js";
import { fileRefsOverlap, mergeCommitsByFile } from "../src/merge.js";

// ═══════════════════════════════════════════════════════════════
// CLI integration tests — spawns the actual CLI binary
// ═══════════════════════════════════════════════════════════════

const CLI = join(import.meta.dir, "..", "dist", "cli.js");

function run(
  args: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  try {
    // Use spawnSync to capture both stdout and stderr on success
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(
      "node",
      [CLI, ...args.split(/\s+/).filter(Boolean)],
      {
        cwd: opts?.cwd ?? process.cwd(),
        encoding: "utf-8" as const,
        env: { ...process.env, ...opts?.env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return {
      stdout: (result.stdout ?? "") as string,
      stderr: (result.stderr ?? "") as string,
      exitCode: (result.status ?? 1) as number,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

// ═══════════════════════════════════════════════════════════════

describe("CLI", () => {
  // ───── Help ─────

  describe("help command", () => {
    test("shows help with 'help'", () => {
      const { stderr } = run("help");
      expect(stderr).toContain("gitaicmt");
      expect(stderr).toContain("Commands:");
      expect(stderr).toContain("plan");
      expect(stderr).toContain("single");
      expect(stderr).toContain("gen");
      expect(stderr).toContain("init");
    });

    test("shows help with '--help'", () => {
      const { stderr } = run("--help");
      expect(stderr).toContain("gitaicmt");
      expect(stderr).toContain("Commands:");
    });

    test("shows help with '-h'", () => {
      const { stderr } = run("-h");
      expect(stderr).toContain("gitaicmt");
    });

    test("help includes usage info", () => {
      const { stderr } = run("help");
      expect(stderr).toContain("Usage:");
      expect(stderr).toContain("gitaicmt");
    });

    test("help mentions config", () => {
      const { stderr } = run("help");
      expect(stderr).toContain("Config:");
      expect(stderr).toContain("OPENAI_API_KEY");
    });
  });

  // ───── Init ─────

  describe("init command", () => {
    test("creates config file in target directory", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-init-"));
      const { stderr } = run("init", { cwd: dir });
      expect(stderr).toContain("Created config:");

      const { existsSync, readFileSync } = require("node:fs");
      const configPath = join(dir, "gitaicmt.config.json");
      expect(existsSync(configPath)).toBe(true);

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.openai.model).toBe("gpt-4o-mini");

      rmSync(dir, { recursive: true });
    });

    test("does not overwrite existing config", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-init-"));
      writeFileSync(
        join(dir, "gitaicmt.config.json"),
        JSON.stringify({ openai: { model: "custom" } }),
      );

      run("init", { cwd: dir });

      const { readFileSync } = require("node:fs");
      const cfg = JSON.parse(
        readFileSync(join(dir, "gitaicmt.config.json"), "utf-8"),
      );
      expect(cfg.openai.model).toBe("custom");

      rmSync(dir, { recursive: true });
    });
  });

  // ───── Unknown command ─────

  describe("unknown command", () => {
    test("exits with error for unknown commands", () => {
      const { stderr, exitCode } = run("foobar");
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Unknown command: foobar");
    });
  });

  // ───── No staged changes ─────

  describe("no changes at all", () => {
    test("'gen' fails without any changes", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-nostage-"));
      // Init a git repo with no changes at all
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });

      const { stderr, exitCode } = run("gen", { cwd: dir });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("No changes to commit");

      rmSync(dir, { recursive: true });
    });

    test("'plan' fails without any changes", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-nostage-"));
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });

      const { stderr, exitCode } = run("plan", { cwd: dir });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("No changes to commit");

      rmSync(dir, { recursive: true });
    });

    test("default command fails without any changes", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-nostage-"));
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });

      const { stderr, exitCode } = run("", { cwd: dir });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("No changes to commit");

      rmSync(dir, { recursive: true });
    });

    test("'single' fails without any changes", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-nostage-"));
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });

      const { stderr, exitCode } = run("single", { cwd: dir });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("No changes to commit");

      rmSync(dir, { recursive: true });
    });
  });

  // ───── Command aliases ─────

  describe("command aliases", () => {
    test("'c' is an alias for 'commit'", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-alias-"));
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });

      const { stderr, exitCode } = run("c", { cwd: dir });
      // Should fail with "No changes" not "Unknown command"
      expect(stderr).toContain("No changes to commit");

      rmSync(dir, { recursive: true });
    });

    test("'p' is an alias for 'plan'", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-alias-"));
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });

      const { stderr } = run("p", { cwd: dir });
      expect(stderr).toContain("No changes to commit");

      rmSync(dir, { recursive: true });
    });

    test("'s' is an alias for 'single'", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-alias-"));
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });

      const { stderr } = run("s", { cwd: dir });
      expect(stderr).toContain("No changes to commit");

      rmSync(dir, { recursive: true });
    });

    test("'g' is an alias for 'gen'", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-alias-"));
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });

      const { stderr } = run("g", { cwd: dir });
      expect(stderr).toContain("No changes to commit");

      rmSync(dir, { recursive: true });
    });
  });

  // ───── With staged changes (will fail at API call) ─────

  describe("with staged changes but no API key", () => {
    test("'gen' fails with API key error when changes are staged", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-nokey-"));
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });
      writeFileSync(join(dir, "test.txt"), "hello");
      execSync("git add test.txt", { cwd: dir, stdio: "pipe" });

      // Remove API key from env
      const { stderr, exitCode } = run("gen", {
        cwd: dir,
        env: {
          OPENAI_API_KEY: "",
          XDG_CONFIG_HOME: dir,
          PATH: process.env["PATH"] ?? "",
        },
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("No OpenAI API key");

      rmSync(dir, { recursive: true });
    });
  });

  // ───── Auto-staging ─────

  describe("auto-staging", () => {
    test("auto-stages unstaged changes and proceeds", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-autostage-"));
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });
      // Create a file but DON'T git add it
      writeFileSync(join(dir, "unstaged.txt"), "hello");

      // Run gen — should auto-stage then fail at API key
      const { stderr, exitCode } = run("gen", {
        cwd: dir,
        env: {
          OPENAI_API_KEY: "",
          XDG_CONFIG_HOME: dir,
          PATH: process.env["PATH"] ?? "",
        },
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("auto-staging");
      expect(stderr).toContain("No OpenAI API key");

      rmSync(dir, { recursive: true });
    });

    test("auto-staging works for default commit command", () => {
      const dir = mkdtempSync(join(tmpdir(), "gitaicmt-cli-autostage-"));
      execSync("git init && git commit --allow-empty -m 'init'", {
        cwd: dir,
        stdio: "pipe",
      });
      writeFileSync(join(dir, "file.txt"), "data");

      const { stderr, exitCode } = run("", {
        cwd: dir,
        env: {
          OPENAI_API_KEY: "",
          XDG_CONFIG_HOME: dir,
          PATH: process.env["PATH"] ?? "",
        },
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("auto-staging");

      rmSync(dir, { recursive: true });
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Unit tests for merge helpers (src/merge.ts)
// ═══════════════════════════════════════════════════════════════

describe("fileRefsOverlap", () => {
  test("whole-file vs whole-file → overlaps", () => {
    expect(fileRefsOverlap({ path: "a.ts" }, { path: "a.ts" })).toBe(true);
  });

  test("whole-file vs hunked → overlaps", () => {
    expect(
      fileRefsOverlap({ path: "a.ts" }, { path: "a.ts", hunks: [0] }),
    ).toBe(true);
  });

  test("hunked vs whole-file → overlaps", () => {
    expect(
      fileRefsOverlap({ path: "a.ts", hunks: [1] }, { path: "a.ts" }),
    ).toBe(true);
  });

  test("same hunk → overlaps", () => {
    expect(
      fileRefsOverlap(
        { path: "a.ts", hunks: [0, 1] },
        { path: "a.ts", hunks: [1] },
      ),
    ).toBe(true);
  });

  test("disjoint hunks → no overlap", () => {
    expect(
      fileRefsOverlap(
        { path: "a.ts", hunks: [0] },
        { path: "a.ts", hunks: [1] },
      ),
    ).toBe(false);
  });

  test("disjoint multi-hunk → no overlap", () => {
    expect(
      fileRefsOverlap(
        { path: "a.ts", hunks: [0, 2] },
        { path: "a.ts", hunks: [1, 3] },
      ),
    ).toBe(false);
  });
});

describe("mergeCommitsByFile", () => {
  function commit(
    msg: string,
    ...files: PlannedCommit["files"]
  ): PlannedCommit {
    return { message: msg, files };
  }

  test("independent files — no merge", () => {
    const groups = [
      commit("feat: A", { path: "a.ts" }),
      commit("feat: B", { path: "b.ts" }),
    ];
    const result = mergeCommitsByFile(groups);
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe("feat: A");
    expect(result[1].message).toBe("feat: B");
  });

  test("whole-file conflict → merged", () => {
    const groups = [
      commit("feat: A", { path: "a.ts" }),
      commit("fix: A2", { path: "a.ts" }),
    ];
    const result = mergeCommitsByFile(groups);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("feat: A");
    expect(result[0].message).toContain("fix: A2");
  });

  test("same hunk in two commits → merged", () => {
    const groups = [
      commit("feat: A", { path: "a.ts", hunks: [0] }),
      commit("feat: B", { path: "a.ts", hunks: [0] }),
    ];
    const result = mergeCommitsByFile(groups);
    expect(result).toHaveLength(1);
  });

  test("disjoint hunks on same file → NOT merged", () => {
    const groups = [
      commit("feat: hunk0", { path: "a.ts", hunks: [0] }),
      commit("feat: hunk1", { path: "a.ts", hunks: [1] }),
    ];
    const result = mergeCommitsByFile(groups);
    // Different hunks — they can be staged independently, keep separate
    expect(result).toHaveLength(2);
    // Hunk arrays preserved
    expect(result[0].files[0].hunks).toEqual([0]);
    expect(result[1].files[0].hunks).toEqual([1]);
  });

  test("cross-file hunk wiring preserved — two commits sharing a file at different hunks stay separate", () => {
    const groups = [
      // Commit 1: file A hunk 0 + file B whole (feature wiring)
      commit("feat: feature", { path: "a.ts", hunks: [0] }, { path: "b.ts" }),
      // Commit 2: file A hunk 1 (unrelated fix)
      commit("fix: cleanup", { path: "a.ts", hunks: [1] }),
    ];
    const result = mergeCommitsByFile(groups);
    expect(result).toHaveLength(2);
    // Commit 1 intact: a.ts[0] + b.ts whole
    expect(result[0].files.find((f) => f.path === "a.ts")?.hunks).toEqual([0]);
    expect(
      result[0].files.find((f) => f.path === "b.ts")?.hunks,
    ).toBeUndefined();
    // Commit 2 intact: a.ts[1]
    expect(result[1].files[0].hunks).toEqual([1]);
  });

  test("whole-file in one commit conflicts with hunked entry → promoted to whole-file on merge", () => {
    const groups = [
      commit("feat: all", { path: "a.ts" }), // whole file
      commit("fix: hunk", { path: "a.ts", hunks: [2] }), // specific hunk
    ];
    const result = mergeCommitsByFile(groups);
    expect(result).toHaveLength(1);
    // Conflicting file should be whole-file (safe superset)
    const aFile = result[0].files.find((f) => f.path === "a.ts");
    expect(aFile?.hunks).toBeUndefined();
  });

  test("messages combined with blank line separator on merge", () => {
    const groups = [
      commit("feat: A", { path: "shared.ts" }),
      commit("fix: B", { path: "shared.ts" }),
    ];
    const result = mergeCommitsByFile(groups);
    expect(result[0].message).toBe("feat: A\n\nfix: B");
  });

  test("three-way: first and third conflict but second is clean", () => {
    const groups = [
      commit("feat: A", { path: "a.ts", hunks: [0] }),
      commit("feat: B", { path: "b.ts" }),
      commit("fix: A2", { path: "a.ts", hunks: [0] }), // conflicts with first
    ];
    const result = mergeCommitsByFile(groups);
    expect(result).toHaveLength(2);
    // The a.ts conflict should be merged
    const aGroup = result.find((g) => g.files.some((f) => f.path === "a.ts"))!;
    expect(aGroup.message).toContain("feat: A");
    expect(aGroup.message).toContain("fix: A2");
    // b.ts commit untouched
    const bGroup = result.find((g) => g.files.some((f) => f.path === "b.ts"))!;
    expect(bGroup.message).toBe("feat: B");
  });
});
