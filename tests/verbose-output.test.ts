import { formatVerboseAiOutputLines } from "../src/verbose-output.js";

const { describe, expect, test } = await import("bun:test");

describe("verbose-output", () => {
  test("formats planned commit arrays as semantic terminal summaries", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify([
          {
            files: [
              { hunks: [0, 1, 2, 3, 7], path: "tests/ai-coverage.test.ts" },
              { path: "tests/ai-tokens.test.ts" },
            ],
            message:
              "test(ai-cache): isolate cache state\n\n- Reset AI cache in shared hooks.\n- Verify cached plans are reused.\n- Track stage output for repeated planning runs.",
          },
        ]),
        stage: "group",
      },
      { maxWidth: 88, mode: "summary", sequence: 2 },
    );

    expect(lines[0]).toContain("Grouping batch #2");
    expect(lines[0]).toContain("1 candidate commit");
    expect(
      lines.some((line) =>
        line.includes("1. test(ai-cache): isolate cache state"),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes(
          "coverage: 2 file(s) · tests/ai-coverage.test.ts [5 hunks], tests/ai-tokens.test.ts",
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes("- Reset AI cache in shared hooks.")),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes("... 1 more detail line(s)")),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain('"path"');
    expect(lines[0]).toContain("\x1b[1m");
    expect(lines[0]).toContain("\x1b[36m");
    expect(lines.some((line) => line.startsWith("\x1b[36m│\x1b[0m"))).toBe(true);
  });

  test("formats plain commit messages without requiring JSON", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content:
          "feat(cli): improve verbose output\n\n- Render terminal-friendly blocks for AI stages.\n- Keep review output readable during long planning runs.",
        stage: "merge",
      },
      { maxWidth: 84, mode: "summary" },
    );

    expect(lines[0]).toContain("Message merge");
    expect(
      lines.some((line) => line.includes("feat(cli): improve verbose output")),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes("Render terminal-friendly blocks for AI stages."),
      ),
    ).toBe(true);
  });

  test("formats trace mode with raw intermediate payload text", () => {
    const raw =
      '[{"files":[{"path":"src/ai.ts","hunks":[0,1,2,3,4]}],"message":"feat: raw payload"}]';
    const lines = formatVerboseAiOutputLines(
      {
        content: raw,
        stage: "consolidate",
      },
      { maxWidth: 84, mode: "trace", sequence: 1 },
    );

    expect(lines[0]).toContain("Final consolidation #1 trace");
    expect(lines.some((line) => line.startsWith("\x1b[36m│\x1b[0m"))).toBe(true);
    expect(
      lines.some((line) => line.includes('"hunks": [0, 1, 2, 3, 4]')),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes('{ "path": "src/ai.ts", "hunks": [0, 1, 2, 3, 4] }'),
      ),
    ).toBe(true);
  });

  test("keeps trace file path and hunk lists on one line even when width is narrow", () => {
    const raw =
      '[{"files":[{"path":"src/cli.ts","hunks":[0,1,2,4,5,6,7,8,9,12,13]}],"message":"feat: raw payload"}]';
    const lines = formatVerboseAiOutputLines(
      {
        content: raw,
        stage: "group",
      },
      { maxWidth: 36, mode: "trace", sequence: 1 },
    );

    expect(
      lines.some((line) =>
        line.includes(
          '{ "path": "src/cli.ts", "hunks": [0, 1, 2, 4, 5, 6, 7, 8, 9, 12, 13] }',
        ),
      ),
    ).toBe(true);
  });

  test("formats compact JSON trace arrays on one line when they fit", () => {
    const raw = "[[0,6],[1,5,8],[3,4,7,9],[2]]";
    const lines = formatVerboseAiOutputLines(
      {
        content: raw,
        stage: "cluster",
      },
      { maxWidth: 84, mode: "trace", sequence: 1 },
    );

    expect(lines[0]).toContain("Merge review #1 trace");
    expect(
      lines.some((line) =>
        line.includes("[[0, 6], [1, 5, 8], [3, 4, 7, 9], [2]]"),
      ),
    ).toBe(true);
  });
});
