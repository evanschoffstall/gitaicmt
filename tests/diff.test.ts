import { beforeEach, describe, expect, test } from "bun:test";
import { resetConfigCache } from "../src/config.js";
import type { FileDiff } from "../src/diff.js";
import {
  buildPatch,
  chunkDiffs,
  formatFileDiff,
  getStats,
  parseDiff,
} from "../src/diff.js";

// ═══════════════════════════════════════════════════════════════
// Test fixtures — realistic git diff outputs
// ═══════════════════════════════════════════════════════════════

const SIMPLE_MODIFY_DIFF = `diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,6 @@
 import { foo } from "./foo";
+import { bar } from "./bar";
 
 export function main() {
-  foo();
+  foo();
+  bar();
 }`;

const NEW_FILE_DIFF = `diff --git a/src/utils.ts b/src/utils.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/utils.ts
@@ -0,0 +1,5 @@
+export function helper() {
+  return 42;
+}
+
+export const VERSION = "1.0.0";`;

const DELETED_FILE_DIFF = `diff --git a/old-file.js b/old-file.js
deleted file mode 100644
index abc1234..0000000
--- a/old-file.js
+++ /dev/null
@@ -1,3 +0,0 @@
-const x = 1;
-const y = 2;
-module.exports = { x, y };`;

const RENAMED_FILE_DIFF = `diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
index abc1234..def5678 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
-export const name = "old";
+export const name = "new";
 export const value = 42;
 export default name;`;

const MULTI_FILE_DIFF = `diff --git a/package.json b/package.json
index abc1234..def5678 100644
--- a/package.json
+++ b/package.json
@@ -3,6 +3,7 @@
   "version": "1.0.0",
   "dependencies": {
     "express": "^4.18.0",
+    "cors": "^2.8.5",
     "lodash": "^4.17.21"
   }
 }
diff --git a/src/server.ts b/src/server.ts
index abc1234..def5678 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,6 +1,8 @@
 import express from "express";
+import cors from "cors";
 
 const app = express();
+app.use(cors());
 
 app.get("/", (req, res) => {
   res.json({ ok: true });
diff --git a/README.md b/README.md
index abc1234..def5678 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # My App
 
-A simple server.
+A simple server with CORS support.
+
+Run with \`npm start\`.`;

const MULTI_HUNK_DIFF = `diff --git a/src/big-file.ts b/src/big-file.ts
index abc1234..def5678 100644
--- a/src/big-file.ts
+++ b/src/big-file.ts
@@ -1,5 +1,6 @@
 // Header section
+// Added a comment at the top
 import { something } from "somewhere";
 
 export function first() {
@@ -50,7 +51,8 @@
 }
 
 export function second() {
-  return "old";
+  return "new";
+  // refactored
 }
@@ -100,4 +102,5 @@
 
 export function third() {
   return 3;
-}
+}
+// EOF`;

const NO_NEWLINE_DIFF = `diff --git a/public/readme.html b/public/readme.html
index abc1234..def5678 100644
--- a/public/readme.html
+++ b/public/readme.html
@@ -42,7 +42,7 @@
 <body>
 <h1>Title</h1>
 <p>Old paragraph.</p>
-<p>Footer old</p>
+<p>Footer new</p>
 </body>
 </html>
-<last line without newline>
\\ No newline at end of file
+<last line without newline updated>
\\ No newline at end of file`;

// ═══════════════════════════════════════════════════════════════

beforeEach(() => {
  resetConfigCache();
});

describe("parseDiff", () => {
  // ───── Single file cases ─────

  describe("modified file", () => {
    test("parses file path correctly", () => {
      const files = parseDiff(SIMPLE_MODIFY_DIFF);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/index.ts");
      expect(files[0].oldPath).toBeNull();
    });

    test("detects modified status", () => {
      const files = parseDiff(SIMPLE_MODIFY_DIFF);
      expect(files[0].status).toBe("modified");
    });

    test("counts additions and deletions", () => {
      const files = parseDiff(SIMPLE_MODIFY_DIFF);
      expect(files[0].additions).toBe(3); // +import, +foo(), +bar()
      expect(files[0].deletions).toBe(1); // -foo()
    });

    test("parses hunk header correctly", () => {
      const files = parseDiff(SIMPLE_MODIFY_DIFF);
      expect(files[0].hunks).toHaveLength(1);
      const hunk = files[0].hunks[0];
      expect(hunk.startOld).toBe(1);
      expect(hunk.countOld).toBe(5);
      expect(hunk.startNew).toBe(1);
      expect(hunk.countNew).toBe(6);
    });

    test("collects hunk lines", () => {
      const files = parseDiff(SIMPLE_MODIFY_DIFF);
      const lines = files[0].hunks[0].lines;
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((l) => l.startsWith("+"))).toBe(true);
      expect(lines.some((l) => l.startsWith("-"))).toBe(true);
      expect(lines.some((l) => l.startsWith(" "))).toBe(true);
    });
  });

  describe("new file", () => {
    test("detects added status", () => {
      const files = parseDiff(NEW_FILE_DIFF);
      expect(files).toHaveLength(1);
      expect(files[0].status).toBe("added");
      expect(files[0].path).toBe("src/utils.ts");
    });

    test("counts only additions", () => {
      const files = parseDiff(NEW_FILE_DIFF);
      expect(files[0].additions).toBe(5);
      expect(files[0].deletions).toBe(0);
    });

    test("has single hunk starting at line 0/1", () => {
      const files = parseDiff(NEW_FILE_DIFF);
      expect(files[0].hunks).toHaveLength(1);
      expect(files[0].hunks[0].startOld).toBe(0);
      expect(files[0].hunks[0].startNew).toBe(1);
    });
  });

  describe("deleted file", () => {
    test("detects deleted status", () => {
      const files = parseDiff(DELETED_FILE_DIFF);
      expect(files).toHaveLength(1);
      expect(files[0].status).toBe("deleted");
    });

    test("counts only deletions", () => {
      const files = parseDiff(DELETED_FILE_DIFF);
      expect(files[0].additions).toBe(0);
      expect(files[0].deletions).toBe(3);
    });
  });

  describe("renamed file", () => {
    test("detects renamed status", () => {
      const files = parseDiff(RENAMED_FILE_DIFF);
      expect(files).toHaveLength(1);
      expect(files[0].status).toBe("renamed");
    });

    test("captures old and new paths", () => {
      const files = parseDiff(RENAMED_FILE_DIFF);
      expect(files[0].path).toBe("new-name.ts");
      expect(files[0].oldPath).toBe("old-name.ts");
    });

    test("counts changes in renamed file", () => {
      const files = parseDiff(RENAMED_FILE_DIFF);
      expect(files[0].additions).toBe(1);
      expect(files[0].deletions).toBe(1);
    });
  });

  // ───── Multi-file ─────

  describe("multi-file diff", () => {
    test("parses all files", () => {
      const files = parseDiff(MULTI_FILE_DIFF);
      expect(files).toHaveLength(3);
    });

    test("extracts correct paths", () => {
      const files = parseDiff(MULTI_FILE_DIFF);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("package.json");
      expect(paths).toContain("src/server.ts");
      expect(paths).toContain("README.md");
    });

    test("counts additions/deletions per file independently", () => {
      const files = parseDiff(MULTI_FILE_DIFF);
      const pkg = files.find((f) => f.path === "package.json")!;
      expect(pkg.additions).toBe(1);
      expect(pkg.deletions).toBe(0);

      const server = files.find((f) => f.path === "src/server.ts")!;
      expect(server.additions).toBe(2);
      expect(server.deletions).toBe(0);

      const readme = files.find((f) => f.path === "README.md")!;
      expect(readme.additions).toBe(3);
      expect(readme.deletions).toBe(1);
    });
  });

  // ───── Multi-hunk ─────

  describe("multi-hunk file", () => {
    test("parses all hunks", () => {
      const files = parseDiff(MULTI_HUNK_DIFF);
      expect(files).toHaveLength(1);
      expect(files[0].hunks).toHaveLength(3);
    });

    test("each hunk has correct start positions", () => {
      const hunks = parseDiff(MULTI_HUNK_DIFF)[0].hunks;
      expect(hunks[0].startOld).toBe(1);
      expect(hunks[1].startOld).toBe(50);
      expect(hunks[2].startOld).toBe(100);
    });

    test("total additions/deletions across hunks", () => {
      const file = parseDiff(MULTI_HUNK_DIFF)[0];
      expect(file.additions).toBe(5);
      expect(file.deletions).toBe(2);
    });
  });

  // ───── Edge cases ─────

  describe("edge cases", () => {
    test("empty input returns no files", () => {
      expect(parseDiff("")).toHaveLength(0);
    });

    test("whitespace-only input returns no files", () => {
      expect(parseDiff("  \n  \n")).toHaveLength(0);
    });

    test("handles diff with no hunks", () => {
      const bare = `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29`;
      const files = parseDiff(bare);
      expect(files).toHaveLength(1);
      expect(files[0].hunks).toHaveLength(0);
      expect(files[0].additions).toBe(0);
      expect(files[0].deletions).toBe(0);
    });

    test("handles hunk with single line change", () => {
      const single = `diff --git a/one.txt b/one.txt
index abc..def 100644
--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-old
+new`;
      const files = parseDiff(single);
      expect(files[0].hunks).toHaveLength(1);
      expect(files[0].hunks[0].countOld).toBe(1);
      expect(files[0].hunks[0].countNew).toBe(1);
    });

    test("skips binary file markers", () => {
      const binaryDiff = `diff --git a/image.png b/image.png
new file mode 100644
Binary files /dev/null and b/image.png differ`;
      const files = parseDiff(binaryDiff);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("image.png");
      expect(files[0].status).toBe("added");
      expect(files[0].hunks).toHaveLength(0);
      expect(files[0].additions).toBe(0);
      expect(files[0].deletions).toBe(0);
    });

    test("handles binary file mixed with text files", () => {
      const mixed = `diff --git a/readme.md b/readme.md
index abc1234..def5678 100644
--- a/readme.md
+++ b/readme.md
@@ -1,2 +1,3 @@
 # Hello
+World
 foo
diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ`;
      const files = parseDiff(mixed);
      expect(files).toHaveLength(2);
      expect(files[0].path).toBe("readme.md");
      expect(files[0].additions).toBe(1);
      expect(files[1].path).toBe("logo.png");
      expect(files[1].hunks).toHaveLength(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════

describe("chunkDiffs", () => {
  function makeFile(path: string, lineCount: number): FileDiff {
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push(`+line ${i}`);
    }
    return {
      path,
      oldPath: null,
      status: "modified",
      hunks: [
        {
          header: `@@ -1,${lineCount} +1,${lineCount} @@`,
          startOld: 1,
          countOld: lineCount,
          startNew: 1,
          countNew: lineCount,
          lines,
        },
      ],
      additions: lineCount,
      deletions: 0,
    };
  }

  describe("groupByFile mode (default)", () => {
    test("one chunk per file when small enough", () => {
      const files = [makeFile("a.ts", 10), makeFile("b.ts", 10)];
      const chunks = chunkDiffs(files);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].files).toEqual(["a.ts"]);
      expect(chunks[1].files).toEqual(["b.ts"]);
    });

    test("sequential IDs", () => {
      const files = [
        makeFile("a.ts", 5),
        makeFile("b.ts", 5),
        makeFile("c.ts", 5),
      ];
      const chunks = chunkDiffs(files);
      expect(chunks.map((c) => c.id)).toEqual([0, 1, 2]);
    });

    test("chunk content contains diff text", () => {
      const files = parseDiff(SIMPLE_MODIFY_DIFF);
      const chunks = chunkDiffs(files);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toContain("+++");
      expect(chunks[0].content).toContain("---");
      expect(chunks[0].content).toContain("@@");
    });
  });

  describe("with real parsed diffs", () => {
    test("multi-file diff produces multiple chunks", () => {
      const files = parseDiff(MULTI_FILE_DIFF);
      const chunks = chunkDiffs(files);
      // Default groupByFile — each file gets 1 chunk
      expect(chunks).toHaveLength(3);
      expect(chunks[0].files[0]).toBe("package.json");
      expect(chunks[1].files[0]).toBe("src/server.ts");
      expect(chunks[2].files[0]).toBe("README.md");
    });

    test("lineCount is positive for each chunk", () => {
      const files = parseDiff(MULTI_FILE_DIFF);
      const chunks = chunkDiffs(files);
      for (const c of chunks) {
        expect(c.lineCount).toBeGreaterThan(0);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════

describe("getStats", () => {
  test("computes correct stats from parsed diff", () => {
    const files = parseDiff(MULTI_FILE_DIFF);
    const chunks = chunkDiffs(files);
    const stats = getStats(files, chunks);

    expect(stats.filesChanged).toBe(3);
    expect(stats.additions).toBe(6); // 1+2+3
    expect(stats.deletions).toBe(1); // 0+0+1
    expect(stats.chunks).toBe(3);
  });

  test("handles empty arrays", () => {
    const stats = getStats([], []);
    expect(stats.filesChanged).toBe(0);
    expect(stats.additions).toBe(0);
    expect(stats.deletions).toBe(0);
    expect(stats.chunks).toBe(0);
  });

  test("handles single file with multiple hunks", () => {
    const files = parseDiff(MULTI_HUNK_DIFF);
    const chunks = chunkDiffs(files);
    const stats = getStats(files, chunks);

    expect(stats.filesChanged).toBe(1);
    expect(stats.additions).toBe(5);
    expect(stats.deletions).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("formatFileDiff", () => {
  test("includes --- and +++ headers", () => {
    const files = parseDiff(SIMPLE_MODIFY_DIFF);
    const text = formatFileDiff(files[0]);
    expect(text).toContain("--- src/index.ts");
    expect(text).toContain("+++ src/index.ts");
  });

  test("includes hunk headers", () => {
    const files = parseDiff(MULTI_HUNK_DIFF);
    const text = formatFileDiff(files[0]);
    // Each hunk header has @@ ... @@ so count the opening pattern
    const hunkCount = (text.match(/@@ -/g) || []).length;
    expect(hunkCount).toBe(3); // 3 hunks
  });

  test("includes all diff lines", () => {
    const files = parseDiff(NEW_FILE_DIFF);
    const text = formatFileDiff(files[0]);
    expect(text).toContain("+export function helper()");
    expect(text).toContain('+export const VERSION = "1.0.0"');
  });

  test("uses oldPath for renamed files", () => {
    const files = parseDiff(RENAMED_FILE_DIFF);
    const text = formatFileDiff(files[0]);
    expect(text).toContain("--- old-name.ts");
    expect(text).toContain("+++ new-name.ts");
  });
});

// ═══════════════════════════════════════════════════════════════

describe("buildPatch", () => {
  test("generates patch for added file", () => {
    const files = parseDiff(NEW_FILE_DIFF);
    const patch = buildPatch(files[0]);

    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/src/utils.ts");
    expect(patch).toContain("@@");
  });

  test("generates patch for deleted file", () => {
    const files = parseDiff(DELETED_FILE_DIFF);
    const patch = buildPatch(files[0]);

    expect(patch).toContain("deleted file mode 100644");
    expect(patch).toContain("--- a/old-file.js");
    expect(patch).toContain("+++ /dev/null");
  });

  test("generates patch for modified file", () => {
    const files = parseDiff(SIMPLE_MODIFY_DIFF);
    const patch = buildPatch(files[0]);

    expect(patch).toContain("--- a/src/index.ts");
    expect(patch).toContain("+++ b/src/index.ts");
    expect(patch).toContain("@@");
  });

  test("generates patch for renamed file", () => {
    const files = parseDiff(RENAMED_FILE_DIFF);
    const patch = buildPatch(files[0]);

    expect(patch).toContain("--- a/old-name.ts");
    expect(patch).toContain("+++ b/new-name.ts");
  });

  test("allows selecting specific hunks", () => {
    const files = parseDiff(MULTI_HUNK_DIFF);
    const file = files[0];
    // Only include the second hunk
    const patch = buildPatch(file, [file.hunks[1]]);

    expect(patch).toContain("@@");
    expect(patch).toContain('+  return "new"');
    // Should NOT contain lines from other hunks
    expect(patch).not.toContain("Added a comment at the top");
    expect(patch).not.toContain("// EOF");
  });

  test("patch ends with newline", () => {
    const files = parseDiff(SIMPLE_MODIFY_DIFF);
    const patch = buildPatch(files[0]);
    expect(patch.endsWith("\n")).toBe(true);
  });

  test("preserves \\ No newline at end of file markers", () => {
    const files = parseDiff(NO_NEWLINE_DIFF);
    expect(files).toHaveLength(1);
    const patch = buildPatch(files[0]);
    expect(patch).toContain("\\ No newline at end of file");
    // The marker must appear after the relevant diff line, not be dropped
    const markerCount = (patch.match(/\\ No newline at end of file/g) ?? [])
      .length;
    expect(markerCount).toBe(2); // one for old side, one for new side
  });
});

// ═══════════════════════════════════════════════════════════════

describe("combined parsing scenarios", () => {
  test("parse → chunk → stats pipeline works end to end", () => {
    const raw = [SIMPLE_MODIFY_DIFF, NEW_FILE_DIFF, DELETED_FILE_DIFF].join(
      "\n",
    );
    const files = parseDiff(raw);
    expect(files.length).toBe(3);

    const chunks = chunkDiffs(files);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const stats = getStats(files, chunks);
    expect(stats.filesChanged).toBe(3);
    expect(stats.additions).toBeGreaterThan(0);
    expect(stats.deletions).toBeGreaterThan(0);
  });

  test("parse → formatFileDiff round-trips key content", () => {
    const files = parseDiff(MULTI_FILE_DIFF);
    for (const file of files) {
      const text = formatFileDiff(file);
      // Should contain all addition lines from the original
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("+") || line.startsWith("-")) {
            expect(text).toContain(line);
          }
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════

describe("git staging helpers", () => {
  // These tests require a real git repo

  function makeGitDir(): string {
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const { execSync } = require("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "gitaicmt-diff-"));
    execSync(
      'git init && git config user.email "test@test.com" && git config user.name "Test"',
      {
        cwd: dir,
        stdio: "pipe",
      },
    );
    execSync("git commit --allow-empty -m 'init'", {
      cwd: dir,
      stdio: "pipe",
    });
    return dir;
  }

  function cleanupDir(dir: string) {
    const { rmSync } = require("node:fs");
    rmSync(dir, { recursive: true });
  }

  test("stageAll stages untracked files", () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { stageAll, getStagedFiles } = require("../src/git.js");
    const dir = makeGitDir();
    writeFileSync(join(dir, "new.txt"), "hello");
    stageAll(dir);
    const staged = getStagedFiles(dir);
    expect(staged).toContain("new.txt");
    cleanupDir(dir);
  });

  test("resetStaging unstages files", () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { execSync } = require("node:child_process");
    const { resetStaging, hasStagedChanges } = require("../src/git.js");
    const dir = makeGitDir();
    writeFileSync(join(dir, "file.txt"), "hi");
    execSync("git add file.txt", { cwd: dir, stdio: "pipe" });
    expect(hasStagedChanges(dir)).toBe(true);
    resetStaging(dir);
    expect(hasStagedChanges(dir)).toBe(false);
    cleanupDir(dir);
  });

  test("commitWithMessage creates a commit", () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { execSync } = require("node:child_process");
    const { commitWithMessage } = require("../src/git.js");
    const dir = makeGitDir();
    writeFileSync(join(dir, "file.txt"), "data");
    execSync("git add file.txt", { cwd: dir, stdio: "pipe" });
    commitWithMessage("test: a commit message", dir);
    const log = execSync("git log --oneline -1", {
      cwd: dir,
      encoding: "utf-8",
    });
    expect(log).toContain("test: a commit message");
    cleanupDir(dir);
  });

  test("getStagedFiles returns staged file paths", () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { execSync } = require("node:child_process");
    const { getStagedFiles } = require("../src/git.js");
    const dir = makeGitDir();
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    execSync("git add a.txt b.txt", { cwd: dir, stdio: "pipe" });
    const staged = getStagedFiles(dir);
    expect(staged).toContain("a.txt");
    expect(staged).toContain("b.txt");
    cleanupDir(dir);
  });

  test("stageFiles stages specific files only", () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { stageFiles, getStagedFiles } = require("../src/git.js");
    const dir = makeGitDir();
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    stageFiles(["a.txt"], dir);
    const staged = getStagedFiles(dir);
    expect(staged).toContain("a.txt");
    expect(staged).not.toContain("b.txt");
    cleanupDir(dir);
  });
});

// ═══════════════════════════════════════════════════════════════
// Hunk-level staging via buildPatch + stagePatch
// ═══════════════════════════════════════════════════════════════

describe("hunk-level staging (buildPatch + stagePatch)", () => {
  const { execSync } = require("node:child_process");
  const { writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");

  function makeGitDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "gitaicmt-hunk-"));
    execSync(
      'git init && git config user.email "test@test.com" && git config user.name "Test"',
      { cwd: dir, stdio: "pipe" },
    );
    return dir;
  }

  function cleanupDir(dir: string) {
    rmSync(dir, { recursive: true });
  }

  test("stagePatch stages only the patched lines, not the whole file", () => {
    const {
      stagePatch,
      getStagedDiff,
      hasStagedChanges,
    } = require("../src/git.js");
    const dir = makeGitDir();

    // Commit base file with 30 lines across two regions
    const baseLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(dir, "multi.ts"), baseLines.join("\n") + "\n");
    execSync("git add multi.ts && git commit -m 'init'", {
      cwd: dir,
      stdio: "pipe",
    });

    // Modify two separate regions (simulates two independent hunks)
    const modifiedLines = [...baseLines];
    modifiedLines[0] = "line 1 CHANGED"; // Region A — line 1
    modifiedLines[25] = "line 26 CHANGED"; // Region B — line 26 (far away, separate hunk)
    writeFileSync(join(dir, "multi.ts"), modifiedLines.join("\n") + "\n");

    // Parse the working diff to get the FileDiff with two hunks
    const rawDiff = execSync("git diff multi.ts", {
      cwd: dir,
      encoding: "utf-8",
    }) as string;
    const { parseDiff: pd } = require("../src/diff.js");
    const files = pd(rawDiff);
    expect(files).toHaveLength(1);
    const fileDiff = files[0];
    expect(fileDiff.hunks.length).toBeGreaterThanOrEqual(2);

    // Stage only the first hunk using buildPatch + stagePatch
    const patch = buildPatch(fileDiff, [fileDiff.hunks[0]]);
    expect(patch.trim()).not.toBe("");
    stagePatch(patch, dir);

    // Index should have staged changes
    expect(hasStagedChanges(dir)).toBe(true);

    // Staged diff should contain the first hunk's change but NOT the second hunk's change
    const stagedDiff = getStagedDiff(dir);
    expect(stagedDiff).toContain("line 1 CHANGED");
    expect(stagedDiff).not.toContain("line 26 CHANGED");

    cleanupDir(dir);
  });

  test("staging hunk 1 only includes that region", () => {
    const { stagePatch, getStagedDiff } = require("../src/git.js");
    const dir = makeGitDir();

    const baseLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(dir, "split.ts"), baseLines.join("\n") + "\n");
    execSync("git add split.ts && git commit -m 'init'", {
      cwd: dir,
      stdio: "pipe",
    });

    const modifiedLines = [...baseLines];
    modifiedLines[0] = "line 1 FEAT_A"; // Hunk 0 — feature A
    modifiedLines[25] = "line 26 FEAT_B"; // Hunk 1 — feature B
    writeFileSync(join(dir, "split.ts"), modifiedLines.join("\n") + "\n");

    const rawDiff = execSync("git diff split.ts", {
      cwd: dir,
      encoding: "utf-8",
    }) as string;
    const { parseDiff: pd } = require("../src/diff.js");
    const files = pd(rawDiff);
    const fileDiff = files[0];
    expect(fileDiff.hunks.length).toBeGreaterThanOrEqual(2);

    // Stage only hunk 1 (feature B)
    const patch = buildPatch(fileDiff, [fileDiff.hunks[1]]);
    stagePatch(patch, dir);

    const stagedDiff = getStagedDiff(dir);
    expect(stagedDiff).not.toContain("line 1 FEAT_A");
    expect(stagedDiff).toContain("line 26 FEAT_B");

    cleanupDir(dir);
  });

  test("staging both hunks separately then committing produces two commits with correct content", () => {
    const {
      stagePatch,
      getStagedDiff,
      hasStagedChanges,
      resetStaging,
      commitWithMessage,
    } = require("../src/git.js");
    const dir = makeGitDir();

    // Commit an initial file
    execSync("git commit --allow-empty -m 'root'", { cwd: dir, stdio: "pipe" });
    const baseLines = Array.from({ length: 30 }, (_, i) => `fn${i + 1}() {}`);
    writeFileSync(join(dir, "app.ts"), baseLines.join("\n") + "\n");
    execSync("git add app.ts && git commit -m 'add app.ts'", {
      cwd: dir,
      stdio: "pipe",
    });

    // Make two unrelated changes
    const modifiedLines = [...baseLines];
    modifiedLines[0] = "fn1() { /* feat A */ }";
    modifiedLines[27] = "fn28() { /* feat B */ }";
    writeFileSync(join(dir, "app.ts"), modifiedLines.join("\n") + "\n");

    const rawDiff = execSync("git diff app.ts", {
      cwd: dir,
      encoding: "utf-8",
    }) as string;
    const { parseDiff: pd } = require("../src/diff.js");
    const files = pd(rawDiff);
    const fileDiff = files[0];
    expect(fileDiff.hunks.length).toBeGreaterThanOrEqual(2);

    // ── Commit 1: stage only hunk 0 ──
    stagePatch(buildPatch(fileDiff, [fileDiff.hunks[0]]), dir);
    expect(hasStagedChanges(dir)).toBe(true);
    const staged1 = getStagedDiff(dir);
    expect(staged1).toContain("feat A");
    expect(staged1).not.toContain("feat B");
    commitWithMessage("feat(app): add feat A", dir);

    // ── Commit 2: stage only hunk 1 ──
    resetStaging(dir);
    stagePatch(buildPatch(fileDiff, [fileDiff.hunks[1]]), dir);
    expect(hasStagedChanges(dir)).toBe(true);
    const staged2 = getStagedDiff(dir);
    expect(staged2).not.toContain("feat A");
    expect(staged2).toContain("feat B");
    commitWithMessage("feat(app): add feat B", dir);

    // Verify two separate commits were created
    const log = execSync("git log --oneline -2", {
      cwd: dir,
      encoding: "utf-8",
    }) as string;
    expect(log).toContain("feat A");
    expect(log).toContain("feat B");

    cleanupDir(dir);
  });

  test("cross-file hunk wiring: stage hunk 0 from file A + whole file B together", () => {
    const {
      stagePatch,
      stageFiles,
      getStagedDiff,
      getStagedFiles,
    } = require("../src/git.js");
    const dir = makeGitDir();

    execSync("git commit --allow-empty -m 'root'", { cwd: dir, stdio: "pipe" });

    // File A: two unrelated changes (feature + unrelated fix)
    const fileABase = Array.from({ length: 30 }, (_, i) => `a${i + 1}`);
    writeFileSync(join(dir, "a.ts"), fileABase.join("\n") + "\n");
    // File B: one change (related to feature in file A's hunk 0)
    writeFileSync(join(dir, "b.ts"), "import nothing\n");
    execSync("git add a.ts b.ts && git commit -m 'init files'", {
      cwd: dir,
      stdio: "pipe",
    });

    // Modify file A in two regions
    const fileAMod = [...fileABase];
    fileAMod[0] = "a1_feature"; // hunk 0 — linked to file B
    fileAMod[25] = "a26_unrelated"; // hunk 1 — unrelated
    writeFileSync(join(dir, "a.ts"), fileAMod.join("\n") + "\n");
    // Modify file B (whole file, linked to file A hunk 0)
    writeFileSync(join(dir, "b.ts"), "import { a1_feature } from './a'\n");

    // Parse file A's diff to get hunks
    const rawDiffA = execSync("git diff a.ts", {
      cwd: dir,
      encoding: "utf-8",
    }) as string;
    const { parseDiff: pd } = require("../src/diff.js");
    const filesA = pd(rawDiffA);
    const fileDiffA = filesA[0];
    expect(fileDiffA.hunks.length).toBeGreaterThanOrEqual(2);

    // Cross-file commit: file A hunk 0 + file B (whole)
    stagePatch(buildPatch(fileDiffA, [fileDiffA.hunks[0]]), dir);
    stageFiles(["b.ts"], dir);

    const staged = getStagedDiff(dir);
    const stagedFiles = getStagedFiles(dir);

    // Both files staged
    expect(stagedFiles).toContain("a.ts");
    expect(stagedFiles).toContain("b.ts");
    // Correct content in index
    expect(staged).toContain("a1_feature");
    expect(staged).toContain("a1_feature"); // from b.ts import
    // File A's unrelated hunk should NOT be staged
    expect(staged).not.toContain("a26_unrelated");

    cleanupDir(dir);
  });
});
