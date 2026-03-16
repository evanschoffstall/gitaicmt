import { describe, expect, test } from "bun:test";

import { formatPlanBodyLine, wrapDisplayFileLines } from "../src/plan-display.js";

describe("plan display formatting", () => {
  test("keeps bullet continuation lines aligned under the bullet text", () => {
    expect(
      formatPlanBodyLine(
        "- Guard observer callbacks so logging/telemetry hooks cannot interrupt commit generation flow on handler failures.",
        72,
      ),
    ).toEqual([
      "- Guard observer callbacks so logging/telemetry hooks cannot interrupt",
      "  commit generation flow on handler failures.",
    ]);
  });

  test("keeps later words attached on wrapped bullet continuation lines", () => {
    expect(
      formatPlanBodyLine(
        "- Add subject word sanitization helpers for downstream matching and scoring workflows that need consistent tokenized input.",
        72,
      ),
    ).toEqual([
      "- Add subject word sanitization helpers for downstream matching and",
      "  scoring workflows that need consistent tokenized input.",
    ]);
  });

  test("wraps file lists at file boundaries with hanging indent", () => {
    expect(
      wrapDisplayFileLines(
        [
          "src/terminal-ui.ts",
          "src/verbose-output.ts",
          "src/cli.ts [hunks 0, 1, 2, 4, 5, 6, 7, 8, 9, 12, 13 / 14]",
        ],
        72,
      ),
    ).toEqual([
      "Files: src/terminal-ui.ts, src/verbose-output.ts,",
      "       src/cli.ts [hunks 0, 1, 2, 4, 5, 6, 7, 8, 9, 12, 13 / 14]",
    ]);
  });
});