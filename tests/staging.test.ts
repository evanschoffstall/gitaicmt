/**
 * Tests for stageGroupFiles (src/staging.ts) and the full commit pipeline.
 *
 * These are the tests that would have caught the two bugs that shipped:
 *   Bug 1: stageGroupFiles ignored hunks and staged whole files
 *   Bug 2: mergeCommitsByFile stripped hunk arrays ("// Ignore hunks for simplicity")
 *
 * All tests that touch the filesystem create isolated temp git repos and clean
 * up after themselves.  XDG_CONFIG_HOME is set to prevent the user's real
 * ~/.config/gitaicmt/config.json from leaking into test assertions.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../src/config.js";
import { parseDiff } from "../src/diff.js";
import {
  commitWithMessage,
  getStagedDiff,
  hasStagedChanges,
  resetStaging,
} from "../src/git.js";
import { mergeCommitsByFile } from "../src/merge.js";
import { stageGroupFiles } from "../src/staging.js";

const { afterEach, beforeEach, describe, expect, test } =
  await import("bun:test");

type PlannedCommit = import("../src/ai.js").PlannedCommit;

function commitMessage(subject: string, ...bullets: string[]): string {
  const body = bullets.length > 0 ? bullets : ["- Summarize the change."];
  return [subject, "", ...body].join("\n");
}

// ─── helpers ─────────────────────────────────────────────────────────────────

let originalXdgConfigHome: string | undefined;

beforeEach(() => {
  resetConfigCache();
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  // Point at an empty temp dir so the user's real config cannot leak in
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "gitaicmt-cfg-"));
});

afterEach(() => {
  // Restore XDG_CONFIG_HOME
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
});

function cleanupDir(dir: string) {
  rmSync(dir, { recursive: true });
}

function getDiff(dir: string, filename: string): string {
  return execSync(`git diff "${filename}"`, {
    cwd: dir,
    encoding: "utf-8",
  }) as string;
}

function makeGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitaicmt-stage-"));
  execSync(
    'git init && git config user.email "test@test.com" && git config user.name "Test"',
    { cwd: dir, stdio: "pipe" },
  );
  execSync("git commit --allow-empty -m 'root'", { cwd: dir, stdio: "pipe" });
  return dir;
}

/**
 * Write `content` to `filename` inside `dir`, commit it, then apply `patch`
 * as a working-tree change (no staging).  Returns the parsed FileDiff.
 */
function setupFileWithTwoHunks(
  dir: string,
  filename: string,
): {
  hunk0Marker: string;
  hunk1Marker: string;
} {
  // 30-line base file — two independent regions that will become separate hunks
  const baseLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(dir, filename), baseLines.join("\n") + "\n");
  execSync(`git add "${filename}" && git commit -m 'add ${filename}'`, {
    cwd: dir,
    stdio: "pipe",
  });

  // Modify two regions far apart so git produces two separate hunks
  const modified = [...baseLines];
  const hunk0Marker = "HUNK_ZERO_CHANGE";
  const hunk1Marker = "HUNK_ONE_CHANGE";
  modified[1] = `line 2 ${hunk0Marker}`; // near top
  modified[27] = `line 28 ${hunk1Marker}`; // near bottom
  writeFileSync(join(dir, filename), modified.join("\n") + "\n");

  return { hunk0Marker, hunk1Marker };
}

// ═══════════════════════════════════════════════════════════════════════════════
// stageGroupFiles — validation (no real git needed)
// ═══════════════════════════════════════════════════════════════════════════════

describe("stageGroupFiles — validation errors", () => {
  test("throws when path is not in originalFiles map", () => {
    const emptyMap = new Map();
    expect(() =>
      stageGroupFiles([{ path: "nonexistent.ts" }], emptyMap),
    ).toThrow("AI returned invalid file path not in original diff");
  });

  test("error message includes the offending path", () => {
    const emptyMap = new Map();
    expect(() =>
      stageGroupFiles([{ path: "missing/file.ts" }], emptyMap),
    ).toThrow("missing/file.ts");
  });

  test("throws when hunk index is out of bounds (too high)", () => {
    const dir = makeGitDir();
    try {
      const { hunk0Marker } = setupFileWithTwoHunks(dir, "app.ts");
      const rawDiff = getDiff(dir, "app.ts");
      const files = parseDiff(rawDiff);
      expect(files).toHaveLength(1);
      const fileMap = new Map([[files[0].path, files[0]]]);

      // Files[0] has 2 hunks (indices 0 and 1); index 99 is out of bounds
      expect(() =>
        stageGroupFiles([{ hunks: [99], path: "app.ts" }], fileMap),
      ).toThrow("out-of-bounds hunk index 99");

      // Suppress unused variable warning
      void hunk0Marker;
    } finally {
      cleanupDir(dir);
    }
  });

  test("throws when hunk index is negative", () => {
    const dir = makeGitDir();
    try {
      setupFileWithTwoHunks(dir, "app.ts");
      const rawDiff = getDiff(dir, "app.ts");
      const files = parseDiff(rawDiff);
      const fileMap = new Map([[files[0].path, files[0]]]);

      expect(() =>
        stageGroupFiles([{ hunks: [-1], path: "app.ts" }], fileMap),
      ).toThrow("out-of-bounds hunk index -1");
    } finally {
      cleanupDir(dir);
    }
  });

  test("empty group stages nothing (no error)", () => {
    const emptyMap = new Map();
    // Should not throw
    expect(() => stageGroupFiles([], emptyMap)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// stageGroupFiles — hunk-level staging (THE TESTS THAT WOULD HAVE CAUGHT BUG 1)
// ═══════════════════════════════════════════════════════════════════════════════

describe("stageGroupFiles — hunk-level staging", () => {
  test("staging hunks:[0] only stages hunk 0, not hunk 1", () => {
    const dir = makeGitDir();
    try {
      const { hunk0Marker, hunk1Marker } = setupFileWithTwoHunks(dir, "app.ts");
      const rawDiff = getDiff(dir, "app.ts");
      const files = parseDiff(rawDiff);
      expect(files).toHaveLength(1);
      expect(files[0].hunks.length).toBeGreaterThanOrEqual(2);

      const fileMap = new Map([[files[0].path, files[0]]]);

      // Stage only hunk 0
      stageGroupFiles([{ hunks: [0], path: "app.ts" }], fileMap, dir);

      expect(hasStagedChanges(dir)).toBe(true);
      const staged = getStagedDiff(dir);
      expect(staged).toContain(hunk0Marker);
      expect(staged).not.toContain(hunk1Marker);
    } finally {
      cleanupDir(dir);
    }
  });

  test("staging hunks:[1] only stages hunk 1, not hunk 0", () => {
    const dir = makeGitDir();
    try {
      const { hunk0Marker, hunk1Marker } = setupFileWithTwoHunks(dir, "app.ts");
      const rawDiff = getDiff(dir, "app.ts");
      const files = parseDiff(rawDiff);
      const fileMap = new Map([[files[0].path, files[0]]]);

      stageGroupFiles([{ hunks: [1], path: "app.ts" }], fileMap, dir);

      const staged = getStagedDiff(dir);
      expect(staged).not.toContain(hunk0Marker);
      expect(staged).toContain(hunk1Marker);
    } finally {
      cleanupDir(dir);
    }
  });

  test("staging without hunks (whole-file) stages both hunks", () => {
    const dir = makeGitDir();
    try {
      const { hunk0Marker, hunk1Marker } = setupFileWithTwoHunks(dir, "app.ts");
      const rawDiff = getDiff(dir, "app.ts");
      const files = parseDiff(rawDiff);
      const fileMap = new Map([[files[0].path, files[0]]]);

      // No hunks array = whole file
      stageGroupFiles([{ path: "app.ts" }], fileMap, dir);

      const staged = getStagedDiff(dir);
      expect(staged).toContain(hunk0Marker);
      expect(staged).toContain(hunk1Marker);
    } finally {
      cleanupDir(dir);
    }
  });

  // Regression: whole-file staging must NOT pick up unstaged working-tree changes.
  // Previously stageGroupFiles used `git add` for whole-file entries, which
  // staged everything in the working tree — including changes the user never
  // staged themselves.
  test("whole-file staging does not include unstaged working-tree changes", () => {
    const dir = makeGitDir();
    try {
      // Base file — 30 lines
      const baseLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      writeFileSync(join(dir, "app.ts"), baseLines.join("\n") + "\n");
      execSync("git add app.ts && git commit -m 'base'", {
        cwd: dir,
        stdio: "pipe",
      });

      // Stage only hunk 0 (top of file)
      const STAGED_MARKER = "STAGED_CHANGE";
      const UNSTAGED_MARKER = "UNSTAGED_CHANGE";
      const staged = [...baseLines];
      staged[1] = `line 2 ${STAGED_MARKER}`;
      writeFileSync(join(dir, "app.ts"), staged.join("\n") + "\n");
      execSync("git add app.ts", { cwd: dir, stdio: "pipe" });

      // Now make an additional change to the working tree (not staged)
      const withUnstaged = [...staged];
      withUnstaged[27] = `line 28 ${UNSTAGED_MARKER}`;
      writeFileSync(join(dir, "app.ts"), withUnstaged.join("\n") + "\n");

      // Build fileMap from the STAGED diff only (as cmdCommit does)
      const stagedDiff = getStagedDiff(dir);
      const files = parseDiff(stagedDiff);
      expect(files).toHaveLength(1);
      const fileMap = new Map([[files[0].path, files[0]]]);

      // Simulate what cmdCommit does: unstage everything, then re-stage via stageGroupFiles
      resetStaging(dir);
      stageGroupFiles([{ path: "app.ts" }], fileMap, dir);

      const result = getStagedDiff(dir);
      expect(result).toContain(STAGED_MARKER); // originally staged change — must be present
      expect(result).not.toContain(UNSTAGED_MARKER); // unstaged change — must NOT appear
    } finally {
      cleanupDir(dir);
    }
  });

  test("whole-file staging re-stages zero-hunk mode changes", () => {
    const dir = makeGitDir();
    try {
      writeFileSync(join(dir, "script.sh"), "#!/bin/sh\necho ok\n");
      execSync("git add script.sh && git commit -m 'add script'", {
        cwd: dir,
        stdio: "pipe",
      });

      execSync("chmod +x script.sh && git add script.sh", {
        cwd: dir,
        stdio: "pipe",
      });

      const stagedDiff = getStagedDiff(dir);
      const files = parseDiff(stagedDiff);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("script.sh");
      expect(files[0].hunks).toHaveLength(0);

      const fileMap = new Map([[files[0].path, files[0]]]);

      resetStaging(dir);
      stageGroupFiles([{ path: "script.sh" }], fileMap, dir);

      expect(hasStagedChanges(dir)).toBe(true);
      const restagedDiff = getStagedDiff(dir);
      expect(restagedDiff).toContain("old mode 100644");
      expect(restagedDiff).toContain("new mode 100755");
    } finally {
      cleanupDir(dir);
    }
  });

  test("staging hunks:[0,1] stages both hunks", () => {
    const dir = makeGitDir();
    try {
      const { hunk0Marker, hunk1Marker } = setupFileWithTwoHunks(dir, "app.ts");
      const rawDiff = getDiff(dir, "app.ts");
      const files = parseDiff(rawDiff);
      expect(files[0].hunks.length).toBeGreaterThanOrEqual(2);
      const fileMap = new Map([[files[0].path, files[0]]]);

      stageGroupFiles([{ hunks: [0, 1], path: "app.ts" }], fileMap, dir);

      const staged = getStagedDiff(dir);
      expect(staged).toContain(hunk0Marker);
      expect(staged).toContain(hunk1Marker);
    } finally {
      cleanupDir(dir);
    }
  });

  test("cross-file: stages hunk 0 from fileA and whole fileB", () => {
    const dir = makeGitDir();
    try {
      const { hunk0Marker: a0, hunk1Marker: a1 } = setupFileWithTwoHunks(
        dir,
        "a.ts",
      );
      // fileB: single-change file
      writeFileSync(join(dir, "b.ts"), "const x = 1;\n");
      execSync("git add b.ts && git commit -m 'add b.ts'", {
        cwd: dir,
        stdio: "pipe",
      });
      writeFileSync(join(dir, "b.ts"), "const x = 2; // B_CHANGE\n");

      const rawA = getDiff(dir, "a.ts");
      const rawB = getDiff(dir, "b.ts");
      const filesA = parseDiff(rawA);
      const filesB = parseDiff(rawB);
      expect(filesA).toHaveLength(1);
      expect(filesB).toHaveLength(1);

      const fileMap = new Map([
        [filesA[0].path, filesA[0]],
        [filesB[0].path, filesB[0]],
      ]);

      stageGroupFiles(
        [
          { hunks: [0], path: "a.ts" }, // only hunk 0 from a.ts
          { path: "b.ts" }, // all of b.ts
        ],
        fileMap,
        dir,
      );

      const staged = getStagedDiff(dir);
      expect(staged).toContain(a0); // hunk 0 of a.ts staged
      expect(staged).not.toContain(a1); // hunk 1 of a.ts NOT staged
      expect(staged).toContain("B_CHANGE"); // all of b.ts staged
    } finally {
      cleanupDir(dir);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// End-to-end pipeline: mergeCommitsByFile → stageGroupFiles → commitWithMessage
// (THE TESTS THAT WOULD HAVE CAUGHT BOTH BUGS TOGETHER)
// ═══════════════════════════════════════════════════════════════════════════════

describe("end-to-end commit pipeline", () => {
  test("two disjoint-hunk commits stay separate and produce two git commits", () => {
    const dir = makeGitDir();
    try {
      const { hunk0Marker, hunk1Marker } = setupFileWithTwoHunks(dir, "app.ts");
      const rawDiff = getDiff(dir, "app.ts");
      const files = parseDiff(rawDiff);
      expect(files).toHaveLength(1);
      expect(files[0].hunks.length).toBeGreaterThanOrEqual(2);

      const fileMap = new Map([[files[0].path, files[0]]]);

      // Simulate the AI returning two separate commits for the two hunks
      const aiGroups: PlannedCommit[] = [
        {
          files: [{ hunks: [0], path: "app.ts" }],
          message: commitMessage("feat: implement hunk zero feature"),
        },
        {
          files: [{ hunks: [1], path: "app.ts" }],
          message: commitMessage("feat: implement hunk one feature"),
        },
      ];

      // Bug 2 regression: mergeCommitsByFile must NOT merge these
      const merged = mergeCommitsByFile(aiGroups);
      expect(merged).toHaveLength(2); // should stay separate
      expect(merged[0].files[0].hunks).toEqual([0]);
      expect(merged[1].files[0].hunks).toEqual([1]);

      // Commit group 0
      stageGroupFiles(merged[0].files, fileMap, dir);
      expect(hasStagedChanges(dir)).toBe(true);
      const staged0 = getStagedDiff(dir);
      expect(staged0).toContain(hunk0Marker); // Bug 1 regression
      expect(staged0).not.toContain(hunk1Marker);
      commitWithMessage(merged[0].message, dir);

      // Commit group 1
      resetStaging(dir);
      stageGroupFiles(merged[1].files, fileMap, dir);
      expect(hasStagedChanges(dir)).toBe(true);
      const staged1 = getStagedDiff(dir);
      expect(staged1).not.toContain(hunk0Marker);
      expect(staged1).toContain(hunk1Marker); // Bug 1 regression
      commitWithMessage(merged[1].message, dir);

      // Both commits must appear in git log
      const log = execSync("git log --oneline -2", {
        cwd: dir,
        encoding: "utf-8",
      }) as string;
      expect(log).toContain("hunk zero feature");
      expect(log).toContain("hunk one feature");

      // Each commit must contain ONLY its respective change
      const show0 = execSync("git show HEAD~1", {
        cwd: dir,
        encoding: "utf-8",
      }) as string;
      expect(show0).toContain(hunk0Marker);
      expect(show0).not.toContain(hunk1Marker);

      const show1 = execSync("git show HEAD", {
        cwd: dir,
        encoding: "utf-8",
      }) as string;
      expect(show1).not.toContain(hunk0Marker);
      expect(show1).toContain(hunk1Marker);
    } finally {
      cleanupDir(dir);
    }
  });

  test("whole-file commit produces a single commit containing all changes", () => {
    const dir = makeGitDir();
    try {
      const { hunk0Marker, hunk1Marker } = setupFileWithTwoHunks(dir, "app.ts");
      const rawDiff = getDiff(dir, "app.ts");
      const files = parseDiff(rawDiff);
      const fileMap = new Map([[files[0].path, files[0]]]);

      const aiGroups: PlannedCommit[] = [
        {
          files: [{ path: "app.ts" }], // no hunks = whole file
          message: commitMessage("refactor: overhaul app.ts"),
        },
      ];

      const merged = mergeCommitsByFile(aiGroups);
      expect(merged).toHaveLength(1);

      stageGroupFiles(merged[0].files, fileMap, dir);
      const staged = getStagedDiff(dir);
      expect(staged).toContain(hunk0Marker);
      expect(staged).toContain(hunk1Marker);
      commitWithMessage(merged[0].message, dir);

      const show = execSync("git show HEAD", {
        cwd: dir,
        encoding: "utf-8",
      }) as string;
      expect(show).toContain(hunk0Marker);
      expect(show).toContain(hunk1Marker);
    } finally {
      cleanupDir(dir);
    }
  });

  test("cross-file pipeline: AI pairs hunk from fileA with whole fileB as one commit", () => {
    const dir = makeGitDir();
    try {
      const { hunk0Marker: a0, hunk1Marker: a1 } = setupFileWithTwoHunks(
        dir,
        "a.ts",
      );
      writeFileSync(join(dir, "b.ts"), "export const B = 0;\n");
      execSync("git add b.ts && git commit -m 'add b.ts'", {
        cwd: dir,
        stdio: "pipe",
      });
      writeFileSync(join(dir, "b.ts"), "export const B = 42; // B_UPDATED\n");

      const filesA = parseDiff(getDiff(dir, "a.ts"));
      const filesB = parseDiff(getDiff(dir, "b.ts"));
      const fileMap = new Map([
        [filesA[0].path, filesA[0]],
        [filesB[0].path, filesB[0]],
      ]);

      // AI decides: hunk 0 of a.ts + all of b.ts go together (cross-file wiring)
      //             hunk 1 of a.ts is a separate commit
      const aiGroups: PlannedCommit[] = [
        {
          files: [{ hunks: [0], path: "a.ts" }, { path: "b.ts" }],
          message: commitMessage("feat: feature A (with b.ts support)"),
        },
        {
          files: [{ hunks: [1], path: "a.ts" }],
          message: commitMessage("refactor: cleanup a.ts line 28"),
        },
      ];

      const merged = mergeCommitsByFile(aiGroups);
      // These commits don't conflict: group 0 uses hunk 0 of a.ts, group 1 uses hunk 1
      expect(merged).toHaveLength(2);

      // Commit 1: hunk 0 of a.ts + all of b.ts
      stageGroupFiles(merged[0].files, fileMap, dir);
      const staged0 = getStagedDiff(dir);
      expect(staged0).toContain(a0);
      expect(staged0).not.toContain(a1);
      expect(staged0).toContain("B_UPDATED");
      commitWithMessage(merged[0].message, dir);

      // Commit 2: hunk 1 of a.ts only
      resetStaging(dir);
      stageGroupFiles(merged[1].files, fileMap, dir);
      const staged1 = getStagedDiff(dir);
      expect(staged1).not.toContain(a0);
      expect(staged1).toContain(a1);
      expect(staged1).not.toContain("B_UPDATED");
      commitWithMessage(merged[1].message, dir);

      const log = execSync("git log --oneline -2", {
        cwd: dir,
        encoding: "utf-8",
      }) as string;
      expect(log).toContain("feature A");
      expect(log).toContain("cleanup a.ts");
    } finally {
      cleanupDir(dir);
    }
  });
});
