import { describe, expect, test } from "bun:test";

import {
  getCoverageMismatchDiagnostics,
  hasMatchingCoverage,
} from "../src/commit-planning/grouping/commit-coverage.js";

type FileDiff = import("../src/git/diff.js").FileDiff;
type PlannedCommit = import("../src/commit-planning/orchestration.js").PlannedCommit;

function makeFile(path: string, hunks = 1): FileDiff {
  return {
    additions: hunks,
    deletions: 0,
    hunks: Array.from({ length: hunks }, (_, index) => ({
      countNew: 1,
      countOld: 0,
      header: `@@ -${index + 1},0 +${index + 1},1 @@`,
      lines: [`+change ${index}`],
      startNew: index + 1,
      startOld: index + 1,
    })),
    oldPath: null,
    path,
    status: "modified",
  };
}

describe("commit coverage", () => {
  test("reports missing and extra hunk coverage samples for mismatched regrouping", () => {
    const file = makeFile("src/app.ts", 3);
    const fileByPath = new Map([[file.path, file]]);
    const before: PlannedCommit[] = [
      {
        files: [{ hunks: [0, 1, 2], path: file.path }],
        message: "feat(app): baseline coverage",
      },
    ];
    const after: PlannedCommit[] = [
      {
        files: [{ hunks: [0, 2], path: file.path }],
        message: "feat(app): dropped one hunk",
      },
      {
        files: [{ hunks: [0], path: file.path }],
        message: "test(app): duplicated another hunk",
      },
    ];

    expect(hasMatchingCoverage(before, after, fileByPath)).toBe(false);
    expect(getCoverageMismatchDiagnostics(before, after, fileByPath)).toEqual({
      afterCoverageCount: 2,
      beforeCoverageCount: 3,
      extraCoverageCount: 0,
      extraCoverageSample: [],
      missingCoverageCount: 1,
      missingCoverageSample: ["src/app.ts#1"],
    });
  });

  test("treats whole-file references as expanded hunk coverage for mismatch diagnostics", () => {
    const file = makeFile("src/server.ts", 2);
    const fileByPath = new Map([[file.path, file]]);
    const before: PlannedCommit[] = [
      {
        files: [{ path: file.path }],
        message: "feat(server): full-file ownership",
      },
    ];
    const after: PlannedCommit[] = [
      {
        files: [{ hunks: [0], path: file.path }],
        message: "feat(server): partial ownership only",
      },
    ];

    expect(getCoverageMismatchDiagnostics(before, after, fileByPath)).toEqual({
      afterCoverageCount: 1,
      beforeCoverageCount: 2,
      extraCoverageCount: 0,
      extraCoverageSample: [],
      missingCoverageCount: 1,
      missingCoverageSample: ["src/server.ts#1"],
    });
  });
});