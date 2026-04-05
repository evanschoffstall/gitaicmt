import { describe, expect, test } from "bun:test";

import { absorbIncidentalAdjacentGroups } from "../src/commit-planning/grouping/group/adjacent-absorption.js";
import { type FileDiff } from "../src/git/diff.js";

function makeFileDiff(path: string, hunkCount: number): FileDiff {
  return {
    additions: 0,
    deletions: 0,
    hunks: Array.from({ length: hunkCount }, (_, index) => ({
      countNew: 1,
      countOld: 1,
      header: `@@ -${String(index + 1)},1 +${String(index + 1)},1 @@`,
      lines: [],
      startNew: index + 1,
      startOld: index + 1,
    })),
    oldPath: path,
    path,
    status: "modified",
  };
}

describe("group-finalization", () => {
  test("absorbs a tiny same-surface follow-up into the previous broader commit", () => {
    const fileByPath = new Map([
      ["src/cli/command-line-interface.ts", makeFileDiff("src/cli/command-line-interface.ts", 2)],
      ["src/cli/output-presentation.ts", makeFileDiff("src/cli/output-presentation.ts", 0)],
    ]);

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [
            { path: "src/cli/output-presentation.ts" },
            { hunks: [0], path: "src/cli/command-line-interface.ts" },
          ],
          message: [
            "refactor(cli): centralize plan and status rendering primitives",
            "",
            "- Extract shared output helpers.",
            "- Replace inline render paths with presentation helpers.",
          ].join("\n"),
        },
        {
          files: [{ hunks: [1], path: "src/cli/command-line-interface.ts" }],
          message: [
            "fix(cli): normalize usage section title casing",
            "",
            "- Correct the usage summary title casing.",
          ].join("\n"),
        },
      ],
      fileByPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { path: "src/cli/output-presentation.ts" },
      { hunks: [0, 1], path: "src/cli/command-line-interface.ts" },
    ]);
    expect(result[0]?.message).toContain(
      "refactor(cli): centralize plan and status rendering primitives",
    );
    expect(result[0]?.message).toContain(
      "Correct the usage summary title casing.",
    );
  });

  test("keeps a tiny follow-up separate when it changes a different surface", () => {
    const fileByPath = new Map([
      ["src/cli/command-line-interface.ts", makeFileDiff("src/cli/command-line-interface.ts", 1)],
      ["src/commit-planning/response-validation.ts", makeFileDiff("src/commit-planning/response-validation.ts", 1)],
    ]);

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [{ hunks: [0], path: "src/cli/command-line-interface.ts" }],
          message: [
            "refactor(cli): centralize plan and status rendering primitives",
            "",
            "- Extract shared output helpers.",
            "- Replace inline render paths with presentation helpers.",
          ].join("\n"),
        },
        {
          files: [{ hunks: [0], path: "src/commit-planning/response-validation.ts" }],
          message: [
            "fix(response-validation): resolve safe extension drift in file paths",
            "",
            "- Accept unique extension drift safely.",
          ].join("\n"),
        },
      ],
      fileByPath,
    );

    expect(result).toHaveLength(2);
  });
});