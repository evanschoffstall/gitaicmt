import { stripAnsi } from "../src/cli/terminal/line-wrapping.js";
import {
  formatVerboseAiOutputLines,
  getVerboseAiOutputSequenceKey,
} from "../src/cli/verbose-output.js";

const { describe, expect, test } = await import("bun:test");

describe("verbose-output", () => {
  function getPlainLines(lines: string[]): string[] {
    return lines.map((line) => stripAnsi(line));
  }

  test("normalizes leaked file aliases in semantic commit summaries", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify([
          {
            files: [{ path: "F2" }],
            message:
              "chore(tooling): refresh lint deps\n\n- Keep the lint stack current.",
          },
        ]),
        fileAliasMap: new Map([
          ["F1", "eslint.config.mjs"],
          ["F2", "package.json"],
        ]),
        kind: "model-output",
        stage: "group",
        transport: "responses",
      },
      { maxWidth: 88, mode: "summary", sequence: 1 },
    );

    expect(
      lines.some((line) => line.includes("impact: 1 file(s) · 1 detail")),
    ).toBe(true);
    expect(lines.some((line) => line.includes("files: package.json"))).toBe(
      true,
    );
    expect(lines.join("\n")).not.toContain("F2");
  });

  test("normalizes leaked file aliases in raw trace blocks", () => {
    const raw = JSON.stringify([
      {
        files: [{ hunks: [0], path: "F2" }],
        message: "chore(deps): bump runtime package",
      },
    ]);

    const lines = formatVerboseAiOutputLines(
      {
        content: raw,
        fileAliasMap: new Map([
          ["F1", "eslint.config.mjs"],
          ["F2", "package.json"],
        ]),
        kind: "model-output",
        stage: "group",
        transport: "responses",
      },
      { maxWidth: 84, mode: "trace", sequence: 2 },
    );

    const plainLines = getPlainLines(lines);

    expect(
      plainLines.some((line) =>
        line.includes(
          "1. chore(deps): bump runtime package · 1 file(s) · package.json [0]",
        ),
      ),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain("F2");
  });

  test("honors narrow trace widths instead of forcing a wider internal floor", () => {
    const raw = JSON.stringify([
      {
        files: [
          {
            hunks: [0, 1, 2, 3],
            path: "src/cli/main.ts",
          },
        ],
        message:
          "fix(verbose-output): isolate sequence counters by rendered event family",
      },
    ]);

    const lines = formatVerboseAiOutputLines(
      {
        content: raw,
        kind: "model-output",
        stage: "group",
        transport: "responses",
      },
      { maxWidth: 28, mode: "trace", sequence: 1 },
    );

    const plainLines = getPlainLines(lines);

    expect(
      plainLines.some((line) => line.includes("summary: 1 candidate")),
    ).toBe(true);
    expect(
      plainLines.some((line) => line.includes("commit(s) · 1 file(s)")),
    ).toBe(true);
    expect(
      plainLines.some((line) => line.includes("1. fix(verbose-output):")),
    ).toBe(true);
    expect(
      plainLines.some((line) => line.includes("src/cli/main.ts [4 hunks]")),
    ).toBe(true);
  });

  test("splits long trace path tokens before the terminal hard-wraps them", () => {
    const raw = JSON.stringify([
      {
        files: [
          {
            hunks: [0],
            path: "src/cli/verbose-rendering/block-render.ts",
          },
        ],
        message: "fix: trace path wrapping",
      },
    ]);

    const lines = formatVerboseAiOutputLines(
      {
        content: raw,
        kind: "model-output",
        stage: "group",
        transport: "responses",
      },
      { maxWidth: 28, mode: "trace", sequence: 1 },
    );

    const plainLines = getPlainLines(lines);

    expect(
      plainLines.some((line) => line.includes("src/cli/verbose-rendering/")),
    ).toBe(true);
    expect(
      plainLines.some((line) => line.includes("block-render.ts [0]")),
    ).toBe(true);
  });

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
        durationMs: 842,
        inputTokens: 610,
        kind: "model-output",
        outputTokens: 128,
        requestCountDelta: 1,
        stage: "group",
        totalTokens: 738,
        transport: "chat",
      },
      { maxWidth: 88, mode: "summary", sequence: 2 },
    );
    const plainLines = getPlainLines(lines);

    expect(lines[0]).toContain("Grouping batch #2");
    expect(lines[0]).toContain("1 candidate commit");
    expect(
      plainLines.some((line) =>
        line.includes("1. test(ai-cache): isolate cache state"),
      ),
    ).toBe(true);
    expect(
      plainLines.some((line) => line.includes("impact: 2 file(s) · 3 details")),
    ).toBe(true);
    expect(
      plainLines.some((line) =>
        line.includes(
          "files: tests/ai-coverage.test.ts [5 hunks], tests/ai-tokens.test.ts",
        ),
      ),
    ).toBe(true);
    expect(
      plainLines.some((line) =>
        line.includes("- Reset AI cache in shared hooks."),
      ),
    ).toBe(true);
    expect(
      plainLines.some((line) => line.includes("... 1 more detail line(s)")),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain('"path"');
    expect(lines[0]).toContain("\x1b[1m");
    expect(lines[0]).toContain("\x1b[36m");
    expect(lines.some((line) => line.startsWith("\x1b[36m│\x1b[0m"))).toBe(
      true,
    );
    expect(
      plainLines.some((line) =>
        line.includes("stats: model-output · chat · 842ms"),
      ),
    ).toBe(true);
    expect(
      plainLines.some((line) =>
        line.includes("usage: 1 req · 610 in · 128 out · 738 tok"),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes("\x1b[2m"))).toBe(true);
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
      '[{"files":[{"path":"src/commit-planning/orchestration.ts","hunks":[0,1,2,3,4]}],"message":"feat: raw payload"}]';
    const lines = formatVerboseAiOutputLines(
      {
        content: raw,
        durationMs: 1_256,
        inputTokens: 444,
        kind: "model-output",
        outputTokens: 111,
        requestCountDelta: 1,
        stage: "group",
        totalTokens: 555,
        transport: "responses",
      },
      { maxWidth: 84, mode: "trace", sequence: 1 },
    );
    const plainLines = getPlainLines(lines);

    expect(lines[0]).toContain("Grouping batch #1 trace");
    expect(lines.some((line) => line.startsWith("\x1b[36m│\x1b[0m"))).toBe(
      true,
    );
    expect(
      plainLines.some((line) =>
        line.includes("stats: model-output · responses · 1.26s"),
      ),
    ).toBe(true);
    expect(
      plainLines.some((line) =>
        line.includes("usage: 1 req · 444 in · 111 out · 555 tok"),
      ),
    ).toBe(true);
    expect(
      plainLines.some((line) =>
        line.includes("summary: 1 candidate commit(s) · 1 file(s)"),
      ),
    ).toBe(true);
    expect(
      plainLines.some((line) =>
        line.includes(
          "1. feat: raw payload · 1 file(s) · src/commit-planning/orchestration.ts [5 hunks]",
        ),
      ),
    ).toBe(true);
  });

  test("summarizes final consolidation traces instead of repeating the full plan payload", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify([
          {
            files: [{ path: "src/cli/output-presentation.ts" }],
            message:
              "feat(cli): improve execution rendering\n\n- Render execution files vertically.",
          },
          {
            files: [{ path: "src/git/operations.ts" }],
            message:
              "fix(git): return structured commit output\n\n- Capture stdout and stderr for CLI rendering.",
          },
        ]),
        durationMs: 1_048,
        inputTokens: 555,
        kind: "model-output",
        outputTokens: 222,
        requestCountDelta: 1,
        stage: "consolidate",
        totalTokens: 777,
        transport: "responses",
      },
      { maxWidth: 84, mode: "trace", sequence: 1 },
    );
    const plainLines = getPlainLines(lines);

    expect(lines[0]).toContain("Final consolidation #1 trace");
    expect(
      plainLines.some((line) =>
        line.includes(
          "summary: 2 candidate commits finalized; full plan cards render below",
        ),
      ),
    ).toBe(true);
    expect(
      plainLines.some((line) =>
        line.includes("1. feat(cli): improve execution rendering"),
      ),
    ).toBe(true);
    expect(
      plainLines.some((line) =>
        line.includes("2. fix(git): return structured commit output"),
      ),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain('"files":');
    expect(lines.join("\n")).not.toContain(
      '"path": "src/cli/output-presentation.ts"',
    );
  });

  test("summarizes grouped commit candidates without expanding raw json payloads", () => {
    const raw = JSON.stringify([
      {
        files: [
          {
            hunks: [0, 1, 2, 4, 5, 8, 9, 10, 13, 14],
            path: "src/cli/main.ts",
          },
          { path: "src/cli/verbose-output.ts" },
        ],
        message:
          "feat(cli): add structured verbose and trace AI output modes\n\n- Introduce output modes (off/summary/trace) and wire an AI output observer so model stage payloads can be rendered as readable terminal blocks.",
      },
    ]);
    const lines = formatVerboseAiOutputLines(
      {
        content: raw,
        stage: "group",
      },
      { maxWidth: 76, mode: "trace", sequence: 1 },
    );

    const plainLines = getPlainLines(lines);

    expect(
      plainLines.some((line) =>
        line.includes("summary: 1 candidate commit(s) · 2 file(s)"),
      ),
    ).toBe(true);
    expect(
      plainLines.some((line) =>
        line.includes(
          "1. feat(cli): add structured verbose and trace AI output modes",
        ),
      ),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain('"message"');
    expect(lines.join("\n")).not.toContain('"files"');
  });

  test("summarizes compact cluster arrays instead of printing raw bracket payloads", () => {
    const raw = "[[0,6],[1,5,8],[3,4,7,9],[2]]";
    const lines = formatVerboseAiOutputLines(
      {
        content: raw,
        stage: "cluster",
      },
      { maxWidth: 84, mode: "trace", sequence: 1 },
    );
    const plainLines = getPlainLines(lines);

    expect(
      plainLines.some((line) =>
        line.includes("summary: 4 cluster(s) · sizes 2, 3, 4, 1"),
      ),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain("[[0, 6]");
  });

  test("uses separate sequence buckets for different consolidate event families", () => {
    const modelOutputKey = getVerboseAiOutputSequenceKey({
      content: "[]",
      kind: "model-output",
      stage: "consolidate",
      transport: "responses",
    });
    const repartitionKey = getVerboseAiOutputSequenceKey({
      content: JSON.stringify({
        decision: "repartition-after-consolidation",
        outputGroupCount: 4,
        premergedGroupCount: 7,
      }),
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });
    const finalizeKey = getVerboseAiOutputSequenceKey({
      content: JSON.stringify({
        decision: "finalize-planned-groups",
        finalGroupCount: 4,
      }),
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });

    expect(modelOutputKey).toBe("stage:consolidate");
    expect(repartitionKey).toBe("planner:repartition-after-consolidation");
    expect(finalizeKey).toBe("planner:finalize-planned-groups");
  });
});
