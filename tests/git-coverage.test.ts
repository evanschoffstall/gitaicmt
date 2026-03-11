import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitCommandError, InvalidPathError } from "../src/errors.js";
import {
  commitWithMessage,
  getStagedDiff,
  getStagedFiles,
  isGitRepository,
  stageAll,
  stageFiles,
  stagePatch,
} from "../src/git.js";

declare const describe: typeof import("bun:test").describe;
declare const expect: typeof import("bun:test").expect;
declare const test: typeof import("bun:test").test;

function cleanupDir(dir: string) {
  rmSync(dir, { force: true, recursive: true });
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
        commitWithMessage("feat(core): nothing staged", dir),
      ).toThrow(GitCommandError);
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

  test("stageFiles rejects shell metacharacters in paths", () => {
    const dir = makeGitDir();

    try {
      expect(() => stageFiles(["bad;name.txt"], dir)).toThrow(InvalidPathError);
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
});
