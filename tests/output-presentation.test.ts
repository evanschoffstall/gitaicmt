import { describe, expect, test } from "bun:test";

import {
  buildPlanCardLines,
  buildReadyPromptLines,
  buildStatusSectionLines,
} from "../src/cli/output-presentation.js";
import { stripAnsi } from "../src/cli/terminal-line-wrapping.js";

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
    expect(lines[1]).toContain("estimate");
    expect(lines[1]).toContain("~7216 across about 1 request");
    expect(lines[2]?.startsWith("            ")).toBe(true);
  });

  test("renders ready prompt copy with action guidance", () => {
    const lines = buildReadyPromptLines(2, 72).map((line) => stripAnsi(line));

    expect(lines[0]).toBe("Ready To Commit");
    expect(lines.some((line) => line.includes("2 planned commits ready"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("reply y to commit or n to abort"))).toBe(
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
});