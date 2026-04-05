import * as terminalColumns from "../src/cli/terminal/columns.js";
import * as lineWrapping from "../src/cli/terminal/line-wrapping.js";
import * as diff from "../src/git/diff.js";
import * as operations from "../src/git/operations.js";

const { afterEach, describe, expect, mock, spyOn, test } =
  await import("bun:test");

type FileDiff = import("../src/git/diff.js").FileDiff;

afterEach(() => {
  mock.restore();
});

function makeFile(hunks: FileDiff["hunks"]): FileDiff {
  return {
    additions: hunks.length,
    deletions: 0,
    hunks,
    oldPath: null,
    path: "src/app.ts",
    status: "modified",
  };
}

describe("group staging coverage", () => {
  test("whole-file entries with no hunks fall back to stageFiles when the patch is empty", async () => {
    const { stageGroupFiles } = await import("../src/cli/commit/group-staging.js");
    const stageFilesCalls: string[][] = [];

    spyOn(diff, "buildPatch").mockReturnValue("");
    spyOn(operations, "stageFiles").mockImplementation((paths) => {
      stageFilesCalls.push(paths);
    });
    spyOn(operations, "stagePatch").mockImplementation(() => undefined);

    const file = makeFile([]);
    const fileMap = new Map([[file.path, file]]);
    stageGroupFiles([{ path: file.path }], fileMap, "/tmp/repo");

    expect(stageFilesCalls).toEqual([[file.path]]);
  });

  test("empty patches for hunked files emit a warning instead of staging", async () => {
    const { stageGroupFiles } = await import("../src/cli/commit/group-staging.js");
    const stderrWrites: string[] = [];

    spyOn(diff, "buildPatch").mockReturnValue("");
    spyOn(operations, "stageFiles").mockImplementation(() => undefined);
    spyOn(operations, "stagePatch").mockImplementation(() => undefined);
    spyOn(terminalColumns, "resolveTerminalColumns").mockReturnValue(80);
    spyOn(lineWrapping, "wrapTerminalTextBlock").mockImplementation((message) => [message]);
    spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as never);

    const file = makeFile([
      {
        countNew: 1,
        countOld: 0,
        header: "@@ -1,0 +1,1 @@",
        lines: ["+alpha"],
        startNew: 1,
        startOld: 1,
      },
    ]);
    const fileMap = new Map([[file.path, file]]);
    stageGroupFiles([{ hunks: [0], path: file.path }], fileMap);

    expect(stderrWrites.join("")).toContain("Warning: empty patch");
  });

  test("stagePatch failures are logged before the error is rethrown", async () => {
    const { stageGroupFiles } = await import("../src/cli/commit/group-staging.js");
    const stderrWrites: string[] = [];

    spyOn(diff, "buildPatch").mockReturnValue("patch");
    spyOn(terminalColumns, "resolveTerminalColumns").mockReturnValue(80);
    spyOn(lineWrapping, "wrapTerminalTextBlock").mockImplementation((message) => [message]);
    spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as never);
    spyOn(operations, "stagePatch").mockImplementation(() => {
      throw new Error("apply failed");
    });

    const file = makeFile([
      {
        countNew: 1,
        countOld: 0,
        header: "@@ -1,0 +1,1 @@",
        lines: ["+alpha"],
        startNew: 1,
        startOld: 1,
      },
    ]);
    const fileMap = new Map([[file.path, file]]);

    expect(() =>
      stageGroupFiles([{ hunks: [0], path: file.path }], fileMap),
    ).toThrow("apply failed");
    expect(stderrWrites.join("")).toContain("Error staging hunks [0] for src/app.ts");
  });
});