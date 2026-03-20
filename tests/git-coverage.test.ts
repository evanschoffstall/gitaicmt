import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitCommandError, InvalidPathError } from "../src/application/errors.js";
import {
  commitWithMessage,
  getStagedDiff,
  getStagedFiles,
  hasCommitHistory,
  isGitRepository,
  resetStaging,
  stageAll,
  stageFiles,
  stagePatch,
} from "../src/git/operations.js";

const { describe, expect, test } = await import("bun:test");

function cleanupDir(dir: string) {
  rmSync(dir, { force: true, recursive: true });
}

function commitMessage(subject: string, ...bullets: string[]): string {
  const body = bullets.length > 0 ? bullets : ["- Summarize the change."];
  return [subject, "", ...body].join("\n");
}

function makeGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitaicmt-git-"));
  execSync(
    'git init && git config user.email "test@test.com" && git config user.name "Test User"',
    { cwd: dir, stdio: "pipe" },
  );
  execSync("git commit --allow-empty -m 'root'", { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("git coverage", () => {
  test("isGitRepository distinguishes repos from plain directories", () => {
    const repoDir = makeGitDir();
    const plainDir = mkdtempSync(join(tmpdir(), "gitaicmt-plain-"));

    try {
      expect(isGitRepository(repoDir)).toBe(true);
      expect(isGitRepository(plainDir)).toBe(false);
    } finally {
      cleanupDir(repoDir);
      cleanupDir(plainDir);
    }
  });

  test("hasCommitHistory distinguishes initialized repositories from committed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitaicmt-no-head-"));

    try {
      execSync(
        'git init && git config user.email "test@test.com" && git config user.name "Test User"',
        { cwd: dir, stdio: "pipe" },
      );

      expect(hasCommitHistory(dir)).toBe(false);

      execSync("git commit --allow-empty -m 'root'", { cwd: dir, stdio: "pipe" });

      expect(hasCommitHistory(dir)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });

  test("getStagedFiles returns an empty array when nothing is staged", () => {
    const dir = makeGitDir();

    try {
      expect(getStagedFiles(dir)).toEqual([]);
    } finally {
      cleanupDir(dir);
    }
  });

  test("stageAll stages untracked nested files", () => {
    const dir = makeGitDir();

    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "new.ts"), "export const value = 1;\n");

      stageAll(dir);

      expect(getStagedFiles(dir)).toContain("src/new.ts");
    } finally {
      cleanupDir(dir);
    }
  });

  test("commitWithMessage rejects empty messages", () => {
    const dir = makeGitDir();

    try {
      expect(() => commitWithMessage("   ", dir)).toThrow(GitCommandError);
    } finally {
      cleanupDir(dir);
    }
  });

  test("commitWithMessage surfaces git failures when nothing is staged", () => {
    const dir = makeGitDir();

    try {
      expect(() =>
        commitWithMessage(commitMessage("feat(core): nothing staged"), dir),
      ).toThrow(GitCommandError);
    } finally {
      cleanupDir(dir);
    }
  });

  test("commitWithMessage includes hook stderr when git rejects the commit", () => {
    const dir = makeGitDir();

    try {
      writeFileSync(
        join(dir, ".git", "hooks", "commit-msg"),
        "#!/bin/sh\necho 'commit-msg hook rejected this commit' >&2\nexit 1\n",
        { mode: 0o755 },
      );
      writeFileSync(join(dir, "file.txt"), "hello\n");
      execSync("git add file.txt", { cwd: dir, stdio: "pipe" });

      expect(() =>
        commitWithMessage(commitMessage("feat(core): trigger hook failure"), dir),
      ).toThrow(/commit-msg hook rejected this commit/u);
    } finally {
      cleanupDir(dir);
    }
  });

  test("commitWithMessage rejects subject-only messages", () => {
    const dir = makeGitDir();

    try {
      expect(() => commitWithMessage("feat(core): missing body", dir)).toThrow(
        GitCommandError,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  test("getStagedDiff throws a git command error outside a repository", () => {
    const plainDir = mkdtempSync(join(tmpdir(), "gitaicmt-plain-"));

    try {
      expect(() => getStagedDiff(plainDir)).toThrow(GitCommandError);
    } finally {
      cleanupDir(plainDir);
    }
  });

  test("stagePatch rejects empty patches", () => {
    const dir = makeGitDir();

    try {
      expect(() => stagePatch("   ", dir)).toThrow(GitCommandError);
    } finally {
      cleanupDir(dir);
    }
  });

  test("stageFiles is a no-op for an empty path list", () => {
    const dir = makeGitDir();

    try {
      expect(() => stageFiles([], dir)).not.toThrow();
      expect(getStagedFiles(dir)).toEqual([]);
    } finally {
      cleanupDir(dir);
    }
  });

  test("stageFiles normalizes safe relative paths before staging", () => {
    const dir = makeGitDir();

    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "app.ts"), "export const app = true;\n");

      stageFiles(["./src//app.ts"], dir);

      expect(getStagedFiles(dir)).toContain("src/app.ts");
    } finally {
      cleanupDir(dir);
    }
  });

  test("stageFiles rejects control characters in paths", () => {
    const dir = makeGitDir();

    try {
      expect(() => stageFiles(["bad\u0000name.txt"], dir)).toThrow(
        InvalidPathError,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  test("stageFiles stages valid paths that contain shell punctuation safely", () => {
    const dir = makeGitDir();

    try {
      const punctuatedPath = "src/feat;name!(v2)#draft$.ts";
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, punctuatedPath), "export const value = 1;\n");

      expect(() => stageFiles([punctuatedPath], dir)).not.toThrow();
      expect(getStagedFiles(dir)).toContain(punctuatedPath);
    } finally {
      cleanupDir(dir);
    }
  });

  test("stageFiles rejects whitespace-only paths", () => {
    const dir = makeGitDir();

    try {
      expect(() => stageFiles(["   "], dir)).toThrow(InvalidPathError);
    } finally {
      cleanupDir(dir);
    }
  });

  test("stageFiles rejects absolute paths", () => {
    const dir = makeGitDir();

    try {
      expect(() => stageFiles(["/tmp/file.txt"], dir)).toThrow(
        InvalidPathError,
      );
      expect(() => stageFiles(["C:/tmp/file.txt"], dir)).toThrow(
        InvalidPathError,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  test("stageFiles rejects leading dashes", () => {
    const dir = makeGitDir();

    try {
      expect(() => stageFiles(["-pwned.txt"], dir)).toThrow(InvalidPathError);
    } finally {
      cleanupDir(dir);
    }
  });

  test("stageFiles rejects paths longer than the maximum length", () => {
    const dir = makeGitDir();

    try {
      expect(() => stageFiles(["a".repeat(4_097)], dir)).toThrow(
        InvalidPathError,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  test("stageFiles rejects traversal above repository root", () => {
    const dir = makeGitDir();

    try {
      expect(() => stageFiles(["src/../../evil.txt"], dir)).toThrow(
        InvalidPathError,
      );
      expect(() => stageFiles(["../evil.txt"], dir)).toThrow(InvalidPathError);
    } finally {
      cleanupDir(dir);
    }
  });

  test("resetStaging unstages files in a repository without commits", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitaicmt-reset-no-head-"));

    try {
      execSync(
        'git init && git config user.email "test@test.com" && git config user.name "Test User"',
        { cwd: dir, stdio: "pipe" },
      );
      writeFileSync(join(dir, "draft.txt"), "hello\n");
      execSync("git add draft.txt", { cwd: dir, stdio: "pipe" });

      expect(getStagedFiles(dir)).toEqual(["draft.txt"]);

      resetStaging(dir);

      expect(getStagedFiles(dir)).toEqual([]);
    } finally {
      cleanupDir(dir);
    }
  });
});
