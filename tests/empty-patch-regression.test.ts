/**
 * Regression test for issue where gitaicmt plans commits but then skips them
 * during execution with "no stageable changes remain".
 *
 * Root cause: When buildPatch() returns a non-empty string that becomes empty
 * after trim(), or when file.hunks exists but selectedHunks resolves to empty,
 * the staging logic may skip files that should have been staged.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FileDiff = import("../src/git/diff.js").FileDiff;
type PlannedCommitFile =
  import("../src/commit-planning/orchestration.js").PlannedCommitFile;

describe("empty patch regression", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "gitaicmt-test-"));
  });

  afterEach(() => {
    mock.restore();
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("files with empty hunks array should stage via stageFiles fallback", async () => {
    const { stageGroupFiles } =
      await import("../src/cli/commit/group-staging.js");
    const diff = await import("../src/git/diff.js");
    const operations = await import("../src/git/operations.js");

    const stageFilesCalls: string[][] = [];
    const stagePatchCalls: string[] = [];

    // Mock buildPatch to return empty for files with zero hunks
    spyOn(diff, "buildPatch").mockReturnValue("");
    spyOn(operations, "stageFiles").mockImplementation((paths) => {
      stageFilesCalls.push(paths);
    });
    spyOn(operations, "stagePatch").mockImplementation((patch) => {
      stagePatchCalls.push(patch);
    });

    // Create a file with zero hunks (metadata-only change, like mode change)
    const file: FileDiff = {
      additions: 0,
      deletions: 0,
      hunks: [],
      metadataLines: ["old mode 100644", "new mode 100755"],
      oldPath: null,
      path: "script.sh",
      status: "modified",
    };

    const fileMap = new Map([[file.path, file]]);
    const plannedFiles: PlannedCommitFile[] = [{ path: file.path }];

    stageGroupFiles(plannedFiles, fileMap, tempDir);

    // Should fall back to stageFiles since hunks is empty
    expect(stageFilesCalls).toEqual([[file.path]]);
    expect(stagePatchCalls).toEqual([]);
  });

  test("files with hunks but empty patch content should fall back to git add", async () => {
    const { stageGroupFiles } =
      await import("../src/cli/commit/group-staging.js");
    const diff = await import("../src/git/diff.js");
    const operations = await import("../src/git/operations.js");
    const terminalColumns = await import("../src/cli/terminal/columns.js");
    const lineWrapping = await import("../src/cli/terminal/line-wrapping.js");

    const stageFilesCalls: string[][] = [];
    const stagePatchCalls: string[] = [];
    const stderrWrites: string[] = [];

    // Mock buildPatch to return empty even though file has hunks
    spyOn(diff, "buildPatch").mockReturnValue("");
    spyOn(operations, "stageFiles").mockImplementation((paths) => {
      stageFilesCalls.push(paths);
    });
    spyOn(operations, "stagePatch").mockImplementation((patch) => {
      stagePatchCalls.push(patch);
    });
    spyOn(terminalColumns, "resolveTerminalColumns").mockReturnValue(80);
    spyOn(lineWrapping, "wrapTerminalTextBlock").mockImplementation(
      (message) => [message],
    );
    spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as never);

    // Create a file with hunks but buildPatch returns empty
    const file: FileDiff = {
      additions: 1,
      deletions: 0,
      hunks: [
        {
          countNew: 1,
          countOld: 0,
          header: "@@ -1,0 +1,1 @@",
          lines: ["+new line"],
          startNew: 1,
          startOld: 1,
        },
      ],
      oldPath: null,
      path: "file.txt",
      status: "modified",
    };

    const fileMap = new Map([[file.path, file]]);
    const plannedFiles: PlannedCommitFile[] = [{ path: file.path }];

    stageGroupFiles(plannedFiles, fileMap, tempDir);

    // Should fall back to stageFiles even though hunks exist
    expect(stageFilesCalls).toEqual([[file.path]]);
    expect(stagePatchCalls).toEqual([]);
    expect(stderrWrites.join("")).toContain("Warning: empty patch");
    expect(stderrWrites.join("")).toContain("falling back to git add");
  });

  test("planned commit execution skips groups when no changes stage successfully", async () => {
    const { executePlannedCommits } =
      await import("../src/cli/commit/execution.js");
    const groupStaging = await import("../src/cli/commit/group-staging.js");
    const operations = await import("../src/git/operations.js");
    const outputUi = await import("../src/cli/terminal/output-ui.js");

    let resetStagingCalls = 0;
    const stageGroupFilesCalls: {
      files: PlannedCommitFile[];
      path: string;
    }[] = [];
    const terminalLines: string[][] = [];

    spyOn(operations, "resetStaging").mockImplementation(() => {
      resetStagingCalls++;
    });
    spyOn(operations, "hasStagedChanges").mockReturnValue(false); // No changes staged
    spyOn(groupStaging, "stageGroupFiles").mockImplementation(
      (files, _, cwd) => {
        stageGroupFilesCalls.push({ files, path: files[0]?.path ?? "" });
      },
    );
    spyOn(outputUi, "writeTerminalLines").mockImplementation((lines) => {
      terminalLines.push(lines);
    });
    spyOn(operations, "commitWithMessage").mockReturnValue({
      stderr: "",
      stdout: "commit created",
    });

    const file: FileDiff = {
      additions: 1,
      deletions: 0,
      hunks: [
        {
          countNew: 1,
          countOld: 0,
          header: "@@ -1,0 +1,1 @@",
          lines: ["+line"],
          startNew: 1,
          startOld: 1,
        },
      ],
      oldPath: null,
      path: "test.txt",
      status: "modified",
    };

    const fileMap = new Map([[file.path, file]]);
    const groups = [
      {
        files: [{ path: file.path }],
        message: "test: add test file",
      },
    ];

    executePlannedCommits(groups, fileMap);

    // Should attempt to stage the group
    expect(stageGroupFilesCalls.length).toBe(1);

    // Should log skipped message
    const allOutput = terminalLines.flat().join("\n");
    expect(allOutput).toContain("skipped - no stageable changes remain");
  });
});
