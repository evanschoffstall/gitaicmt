import { describe, expect, test } from "bun:test";

import {
  formatPlanBodyLine,
  formatPlanBodyLines,
  wrapDisplayFileLines,
  wrapDisplayText,
} from "../src/cli/commit-plan-display.js";

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

  test("merges hard-wrapped bullet continuations back into one displayed bullet", () => {
    expect(
      formatPlanBodyLines(
        [
          "- Extract file legend aliases from the user prompt and carry them on",
          "model-output observer events for downstream rendering.",
        ].join("\n"),
        70,
      ),
    ).toEqual([
      "- Extract file legend aliases from the user prompt and carry them on",
      "  model-output observer events for downstream rendering.",
    ]);
  });

  test("wraps file lists at file boundaries with hanging indent", () => {
    expect(
      wrapDisplayFileLines(
        [
          "src/cli/terminal-output-ui.ts",
          "src/cli/verbose-output.ts",
          "src/cli/command-line-interface.ts [hunks 0, 1, 2, 4, 5, 6, 7, 8, 9, 12, 13 / 14]",
        ],
        72,
      ),
    ).toEqual([
      "- src/cli/terminal-output-ui.ts",
      "- src/cli/verbose-output.ts",
      "- src/cli/command-line-interface.ts [hunks 0, 1, 2, 4, 5, 6, 7, 8, 9,",
      "  12, 13 / 14]",
    ]);
  });

  test("splits long file entries with stable hanging indent on narrow widths", () => {
    expect(
      wrapDisplayFileLines(
        [
          "src/cli/command-line-interface.ts [hunks 0, 1, 2, 3 / 4]",
          "src/cli/verbose-output.ts [hunks 0, 1 / 2]",
        ],
        32,
      ),
    ).toEqual([
      "- src/cli/command-line-",
      "  interface.ts [hunks 0, 1, 2, 3",
      "  / 4]",
      "- src/cli/verbose-output.ts",
      "  [hunks 0, 1 / 2]",
    ]);
  });

  test("splits long unbroken display tokens when needed", () => {
    expect(wrapDisplayText("src/cli/command-line-interface.ts", 12)).toEqual([
      "src/cli/",
      "command-",
      "line-",
      "interface.ts",
    ]);
  });
});