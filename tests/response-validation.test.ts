import { ValidationError } from "../src/application/errors.js";
import { validateAndNormalizeGrouping } from "../src/commit-planning/response-validation.js";

const { describe, expect, test } = await import("bun:test");

type FileDiff = import("../src/git/diff.js").FileDiff;

function commitMessage(subject: string, ...bullets: string[]): string {
  const body = bullets.length > 0 ? bullets : ["- Summarize the change."];
  return [subject, "", ...body].join("\n");
}

function makeFile(path: string, hunks = 2): FileDiff {
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

describe("validateAndNormalizeGrouping", () => {
  test("rejects a non-array AI payload", () => {
    expect(() =>
      validateAndNormalizeGrouping({ files: [] }, new Map()),
    ).toThrow(ValidationError);
  });

  test("rejects an empty AI group array", () => {
    expect(() => validateAndNormalizeGrouping([], new Map())).toThrow(
      ValidationError,
    );
  });

  test("rejects suspiciously many groups", () => {
    const file = makeFile("src/app.ts", 1);
    const fileByPath = new Map([[file.path, file]]);

    expect(() =>
      validateAndNormalizeGrouping(
        Array.from({ length: 101 }, (_, index) => ({
          files: [file.path],
          message: commitMessage(`chore(app): group ${String(index)}`),
        })),
        fileByPath,
      ),
    ).toThrow(ValidationError);
  });

  test("rejects non-integer hunk indices instead of treating them as valid", () => {
    const file = makeFile("src/app.ts", 2);
    const fileByPath = new Map([[file.path, file]]);

    expect(() =>
      validateAndNormalizeGrouping(
        [
          {
            files: [{ hunks: [0.5], path: file.path }],
            message: commitMessage("fix(app): reject fractional hunk refs"),
          },
        ],
        fileByPath,
      ),
    ).toThrow(ValidationError);
  });

  test("rejects partially invalid file lists instead of silently dropping entries", () => {
    const file = makeFile("src/app.ts", 2);
    const fileByPath = new Map([[file.path, file]]);

    expect(() =>
      validateAndNormalizeGrouping(
        [
          {
            files: [file.path, { hunks: [99], path: file.path }],
            message: commitMessage("fix(app): reject mixed invalid entries"),
          },
        ],
        fileByPath,
      ),
    ).toThrow(ValidationError);
  });

  test("rejects invalid group objects and invalid files payloads", () => {
    const file = makeFile("src/app.ts", 1);
    const fileByPath = new Map([[file.path, file]]);

    expect(() => validateAndNormalizeGrouping([null], fileByPath)).toThrow(
      ValidationError,
    );
    expect(() =>
      validateAndNormalizeGrouping(
        [
          {
            files: "src/app.ts",
            message: commitMessage("fix(app): invalid files payload"),
          },
        ],
        fileByPath,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      validateAndNormalizeGrouping(
        [
          {
            files: [],
            message: commitMessage("fix(app): empty files payload"),
          },
        ],
        fileByPath,
      ),
    ).toThrow(ValidationError);
  });

  test("rejects invalid group messages", () => {
    const file = makeFile("src/app.ts", 1);
    const fileByPath = new Map([[file.path, file]]);

    expect(() =>
      validateAndNormalizeGrouping(
        [{ files: [file.path], message: 42 }],
        fileByPath,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      validateAndNormalizeGrouping(
        [{ files: [file.path], message: "   " }],
        fileByPath,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      validateAndNormalizeGrouping(
        [{ files: [file.path], message: "x".repeat(1001) }],
        fileByPath,
      ),
    ).toThrow(ValidationError);
  });

  test("accepts large but valid commit groups above the old fixed threshold", () => {
    const files = Array.from({ length: 120 }, (_, index) =>
      makeFile(`src/file-${String(index)}.ts`, 1),
    );
    const fileByPath = new Map(files.map((file) => [file.path, file]));

    const groups = validateAndNormalizeGrouping(
      [
        {
          files: files.map((file) => file.path),
          message: commitMessage(
            "refactor(core): keep a large valid changeset together",
          ),
        },
      ],
      fileByPath,
    );

    expect(groups).toEqual([
      {
        files: files.map((file) => ({ path: file.path })),
        message: commitMessage(
          "refactor(core): keep a large valid changeset together",
        ),
      },
    ]);
  });

  test("accepts alias-prefixed file paths by resolving them back to repository paths", () => {
    const files = [makeFile("package.json", 1), makeFile("bun.lock", 1)];
    const fileByPath = new Map(files.map((file) => [file.path, file]));

    const groups = validateAndNormalizeGrouping(
      [
        {
          files: [{ path: "F2: bun.lock" }, { path: "F1: package.json" }],
          message: commitMessage("chore(deps): normalize alias-prefixed paths"),
        },
      ],
      fileByPath,
    );

    expect(groups).toEqual([
      {
        files: [{ path: "bun.lock" }, { path: "package.json" }],
        message: commitMessage("chore(deps): normalize alias-prefixed paths"),
      },
    ]);
  });

  test("accepts old rename paths by resolving them to the current repository path", () => {
    const renamedFile = makeFile("src/group-merge.ts", 2);
    renamedFile.oldPath = "src/commit-merge.ts";
    renamedFile.status = "renamed";
    const fileByPath = new Map([[renamedFile.path, renamedFile]]);

    const groups = validateAndNormalizeGrouping(
      [
        {
          files: [{ hunks: [0], path: "src/commit-merge.ts" }],
          message: commitMessage(
            "refactor(grouping): keep rename paths resolvable",
          ),
        },
      ],
      fileByPath,
    );

    expect(groups).toEqual([
      {
        files: [{ hunks: [0], path: "src/group-merge.ts" }],
        message: commitMessage(
          "refactor(grouping): keep rename paths resolvable",
        ),
      },
    ]);
  });

  test("accepts safe extension-variant paths when the repo stem is unique", () => {
    const file = makeFile(
      "src/app/dashboard/hooks/useDashboardToolbarState.ts",
      1,
    );
    const fileByPath = new Map([[file.path, file]]);

    const groups = validateAndNormalizeGrouping(
      [
        {
          files: [
            { path: "src/app/dashboard/hooks/useDashboardToolbarState.tsx" },
          ],
          message: commitMessage(
            "fix(dashboard): accept planner extension drift",
          ),
        },
      ],
      fileByPath,
    );

    expect(groups).toEqual([
      {
        files: [
          { path: "src/app/dashboard/hooks/useDashboardToolbarState.ts" },
        ],
        message: commitMessage(
          "fix(dashboard): accept planner extension drift",
        ),
      },
    ]);
  });

  test("accepts unique basename matches when the planner drops an intermediate directory", () => {
    const file = makeFile("src/commit-planning/prompts/rules/formatting.ts", 1);
    const fileByPath = new Map([[file.path, file]]);

    const groups = validateAndNormalizeGrouping(
      [
        {
          files: [
            {
              path: "src/commit-planning/prompts/formatting.ts",
            },
          ],
          message: commitMessage(
            "fix(prompts): accept unique dropped-directory planner paths",
          ),
        },
      ],
      fileByPath,
    );

    expect(groups).toEqual([
      {
        files: [
          {
            path: "src/commit-planning/prompts/rules/formatting.ts",
          },
        ],
        message: commitMessage(
          "fix(prompts): accept unique dropped-directory planner paths",
        ),
      },
    ]);
  });

  test("rejects extension-variant paths when multiple files share the same stem", () => {
    const tsFile = makeFile(
      "src/app/dashboard/hooks/useDashboardToolbarState.ts",
      1,
    );
    const tsxFile = makeFile(
      "src/app/dashboard/hooks/useDashboardToolbarState.tsx",
      1,
    );
    const fileByPath = new Map([
      [tsFile.path, tsFile],
      [tsxFile.path, tsxFile],
    ]);

    expect(() =>
      validateAndNormalizeGrouping(
        [
          {
            files: [
              { path: "src/app/dashboard/hooks/useDashboardToolbarState.jsx" },
            ],
            message: commitMessage(
              "fix(dashboard): reject ambiguous extension drift",
            ),
          },
        ],
        fileByPath,
      ),
    ).toThrow(ValidationError);
  });

  test("accepts hunks:'all' by normalizing it to whole-file ownership", () => {
    const file = makeFile("src/app.ts", 2);
    const fileByPath = new Map([[file.path, file]]);

    const groups = validateAndNormalizeGrouping(
      [
        {
          files: [{ hunks: "all", path: file.path }],
          message: commitMessage(
            "fix(app): normalize whole-file hunk selector",
          ),
        },
      ],
      fileByPath,
    );

    expect(groups).toEqual([
      {
        files: [{ path: file.path }],
        message: commitMessage("fix(app): normalize whole-file hunk selector"),
      },
    ]);
  });

  test("merges duplicate file entries by unioning hunks and preserving order", () => {
    const file = makeFile("src/app.ts", 3);
    const other = makeFile("src/other.ts", 1);
    const fileByPath = new Map([
      [file.path, file],
      [other.path, other],
    ]);

    const groups = validateAndNormalizeGrouping(
      [
        {
          files: [
            { hunks: [2, 0], path: file.path },
            { hunks: [1, 2], path: file.path },
            { path: other.path },
          ],
          message: commitMessage(
            "refactor(app): merge duplicate planner entries",
          ),
        },
      ],
      fileByPath,
    );

    expect(groups).toEqual([
      {
        files: [{ hunks: [0, 1, 2], path: file.path }, { path: other.path }],
        message: commitMessage(
          "refactor(app): merge duplicate planner entries",
        ),
      },
    ]);
  });

  test("duplicate whole-file entries dominate hunk-specific entries", () => {
    const file = makeFile("src/app.ts", 2);
    const fileByPath = new Map([[file.path, file]]);

    const groups = validateAndNormalizeGrouping(
      [
        {
          files: [{ hunks: [0], path: file.path }, { path: file.path }],
          message: commitMessage(
            "fix(app): keep whole-file ownership when planner duplicates entries",
          ),
        },
      ],
      fileByPath,
    );

    expect(groups).toEqual([
      {
        files: [{ path: file.path }],
        message: commitMessage(
          "fix(app): keep whole-file ownership when planner duplicates entries",
        ),
      },
    ]);
  });
});
