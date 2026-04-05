import { describe, expect, test } from "bun:test";

import {
  buildExecutionCommitLines,
  buildExecutionResultLines,
  buildPlanCardLines,
  buildReadyPromptLines,
  buildStatusSectionLines,
} from "../src/cli/output-presentation.js";
import { stripAnsi } from "../src/cli/terminal/line-wrapping.js";

describe("output-presentation", () => {
  test("renders compact status sections with aligned wrapped values", () => {
    const lines = buildStatusSectionLines(
      "Token Estimate",
      [
        {
          label: "estimate",
          value:
            "~7216 across about 1 request with a longer explanation that still needs wrapping.",
        },
      ],
      48,
    ).map((line) => stripAnsi(line));

    expect(lines[0]).toBe("Token Estimate");
    expect(lines[1]).toContain("estimate:");
    expect(lines[1]).toContain("~7216 across about 1 request");
    expect(lines[2]?.startsWith("            ")).toBe(true);
  });

  test("renders list-valued status rows without awkward inline wrapping", () => {
    const lines = buildStatusSectionLines(
      "Usage Summary",
      [
        {
          label: "stages",
          value: [
            "grouping=10500 (1 req)",
            "final-consolidation=2764 (1 req)",
          ],
        },
      ],
      72,
    ).map((line) => stripAnsi(line));

    expect(lines[1]).toContain("stages:");
    expect(lines[1]).toContain("- grouping=10500 (1 req)");
    expect(lines[2]).toContain("- final-consolidation=2764 (1 req)");
  });

  test("renders a single staged usage line without an unnecessary bullet", () => {
    const lines = buildStatusSectionLines(
      "Usage Summary",
      [
        {
          label: "stages",
          value: ["grouping=8387 (1 req)"],
        },
      ],
      72,
    ).map((line) => stripAnsi(line));

    expect(lines[1]).toContain("stages:");
    expect(lines[1]).toContain("grouping=8387 (1 req)");
    expect(lines[1]).not.toContain("- grouping=8387 (1 req)");
  });

  test("renders ready prompt copy with action guidance", () => {
    const lines = buildReadyPromptLines(2, 72).map((line) => stripAnsi(line));

    expect(lines[0]).toBe("Ready To Commit");
    expect(lines.some((line) => line.includes("2 planned commits ready"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("y commits, n aborts"))).toBe(
      true,
    );
    expect(lines.at(-1)).toBe("Proceed?");
  });

  test("renders commit plans as structured cards with subject, impact, details, and files", () => {
    const lines = buildPlanCardLines({
      files: [
        { path: "src/application/constants.ts" },
        { hunks: [0, 1], path: "tests/ai-coverage.test.ts" },
      ],
      index: 1,
      maxWidth: 84,
      message: [
        "fix(commit-planning): prevent planner output truncation on finalize",
        "",
        "- Add stage-specific response token budgeting constants.",
        "- Raise consolidation budgets above the generic config cap.",
      ].join("\n"),
      total: 1,
    }).map((line) => stripAnsi(line));

    expect(lines[0]).toBe("╭─ Commit 1 of 1");
    expect(lines.some((line) => line.includes("Subject"))).toBe(true);
    expect(lines.some((line) => line.includes("Impact"))).toBe(true);
    expect(lines.some((line) => line.includes("2 files · 2 details"))).toBe(true);
    expect(lines.some((line) => line.includes("Details"))).toBe(true);
    expect(lines.some((line) => line.includes("Files"))).toBe(true);
    expect(
      lines.some((line) => line.includes("tests/ai-coverage.test.ts [hunks 0, 1]")),
    ).toBe(true);
    expect(lines.at(-1)).toBe("╰─");
  });

  test("renders execution steps with a vertical file list", () => {
    const lines = buildExecutionCommitLines({
      files: [
        { path: "src/cli/output-presentation.ts" },
        { hunks: [0, 1], path: "tests/cli.test.ts" },
      ],
      index: 2,
      maxWidth: 84,
      subject: "refactor(cli): centralize plan and status rendering primitives",
      total: 4,
    }).map((line) => stripAnsi(line));

    expect(lines[0]).toBe(
      "[2/4] refactor(cli): centralize plan and status rendering primitives",
    );
    expect(lines[1]).toBe("  Files");
    expect(lines[2]).toContain("- src/cli/output-presentation.ts");
    expect(lines[3]).toContain("- tests/cli.test.ts [hunks 0, 1]");
  });

  test("renders git commit output as a secondary execution block", () => {
    const lines = buildExecutionResultLines(
      [
        "[main fa71fcd] refactor(cli): centralize plan and status rendering primitives",
        "4 files changed, 311 insertions(+), 99 deletions(-)",
      ].join("\n"),
      84,
    ).map((line) => stripAnsi(line));

    expect(lines[0]).toBe("  Git");
    expect(lines.some((line) => line.includes("[main fa71fcd]"))).toBe(true);
    expect(lines.some((line) => line.includes("4 files changed"))).toBe(true);
  });
});