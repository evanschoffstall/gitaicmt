import { formatVerboseAiOutputLines } from "../src/cli/verbose-output.js";

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
    expect(lines.some((line) => line.includes("stats: kind: model-output"))).toBe(true);
    expect(lines.some((line) => line.includes("time: 842ms"))).toBe(true);
    expect(lines.some((line) => line.includes("tok: 738"))).toBe(true);
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
        stage: "consolidate",
        totalTokens: 555,
        transport: "responses",
      },
      { maxWidth: 84, mode: "trace", sequence: 1 },
    );

    expect(lines[0]).toContain("Final consolidation #1 trace");
    expect(lines.some((line) => line.startsWith("\x1b[36m│\x1b[0m"))).toBe(true);
    expect(lines.some((line) => line.includes("transport: responses"))).toBe(true);
    expect(lines.some((line) => line.includes("time: 1.26s"))).toBe(true);
    expect(lines.some((line) => line.includes("in"))).toBe(true);
    expect(lines.some((line) => line.includes("444 · out: 111 · tok: 555"))).toBe(true);
    expect(
      lines.some((line) => line.includes('"hunks": [0, 1,')),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes('{ "path": "src/commit-planning/orchestration.ts", "hunks": [0, 1,'),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes('4] }],'))).toBe(true);
  });

  test("wraps long trace values with continuation aligned to the value column", () => {
    const raw = JSON.stringify([
      {
        files: [
          { hunks: [0, 1, 2, 4, 5, 8, 9, 10, 13, 14], path: "src/cli/command-line-interface.ts" },
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

    expect(
      lines.some((line) =>
        line.includes('       "message": "feat(cli): add structured verbose and trace AI output'),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes('                  modes\\n\\n- Introduce output modes (off/summary/trace) and'),
      ),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes('       "files": [')),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes('             { "path": "src/cli/command-line-interface.ts", "hunks": [0, 1,'),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes('             2, 4, 5, 8, 9, 10, 13, 14] },'),
      ),
    ).toBe(true);
  });

  test("wraps narrow trace file entries while keeping continuation aligned", () => {
    const raw =
      '[{"files":[{"path":"src/cli/command-line-interface.ts","hunks":[0,1,2,4,5,6,7,8,9,12,13]}],"message":"feat: raw payload"}]';
    const lines = formatVerboseAiOutputLines(
      {
        content: raw,
        stage: "group",
      },
      { maxWidth: 36, mode: "trace", sequence: 1 },
    );

    expect(
      lines.some((line) =>
        line.includes('             { "path": "src/cli/command-line-interface.ts",'),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes('             "hunks": [0, 1, 2, 4, 5, 6, 7, 8, 9, 12, 13] }'),
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

  test("formats planner decision events with internal timing stats", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify({
          decision: "dependency-ordering",
          dependencyEdgeCount: 4,
          groupCount: 3,
          reordered: true,
        }),
        durationMs: 37,
        kind: "planner-decision",
        stage: "consolidate",
        transport: "internal",
      },
      { maxWidth: 84, mode: "summary", sequence: 2 },
    );

    expect(lines[0]).toContain("Dependency ordering #2");
    expect(lines.some((line) => line.includes("kind: planner-decision"))).toBe(true);
    expect(lines.some((line) => line.includes("transport: internal"))).toBe(true);
    expect(lines.some((line) => line.includes("time: 37ms"))).toBe(true);
    expect(lines.some((line) => line.includes('"decision": "dependency-ordering"'))).toBe(true);
  });

  test("uses planner decision titles in trace mode for batch finalization", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify({
          batchCount: 3,
          decision: "batched-plan-finalization",
          finalCommitCount: 9,
        }),
        kind: "planner-decision",
        stage: "group",
        transport: "internal",
      },
      { maxWidth: 84, mode: "trace", sequence: 4 },
    );

    expect(lines[0]).toContain("Batched plan finalization #4 trace");
  });

  test("uses planner decision titles in trace mode for retries", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify({
          decision: "consolidation-retry-scheduled",
          failedAttemptCount: 1,
          maxAttemptCount: 2,
          nextAction: "retry",
          reason: "transient-call-failure",
        }),
        kind: "planner-decision",
        stage: "consolidate",
        transport: "internal",
      },
      { maxWidth: 84, mode: "trace", sequence: 1 },
    );

    expect(lines[0]).toContain("Consolidation retry scheduled #1 trace");
  });

  test("shows retry-exhausted details on consolidation failure traces", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify({
          attemptCount: 2,
          decision: "consolidation-failed",
          error: "OpenAI API call failed: Request was aborted.",
          inputGroupCount: 5,
          reason: "retry-exhausted-call-failed",
        }),
        kind: "planner-decision",
        stage: "consolidate",
        transport: "internal",
      },
      { maxWidth: 84, mode: "trace", sequence: 2 },
    );

    expect(lines[0]).toContain("Consolidation failed #2 trace");
    expect(lines[0]).toContain("\x1b[31m");
    expect(lines.some((line) => line.startsWith("\x1b[31m│\x1b[0m"))).toBe(true);
    expect(lines.some((line) => line.includes('"attemptCount": 2'))).toBe(true);
    expect(
      lines.some((line) => line.includes('"reason": "retry-exhausted-call-failed"')),
    ).toBe(true);
  });

  test("uses planner decision titles in trace mode for repartition after consolidation", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify({
          decision: "repartition-after-consolidation",
          outputGroupCount: 16,
          premergedGroupCount: 19,
        }),
        kind: "planner-decision",
        stage: "consolidate",
        transport: "internal",
      },
      { maxWidth: 84, mode: "trace", sequence: 3 },
    );

    expect(lines[0]).toContain("Repartition after consolidation #3 trace");
  });

  test("uses planner decision titles in trace mode for consolidation noop", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify({
          decision: "consolidation-noop",
          inputGroupCount: 7,
          outputGroupCount: 7,
          reason: "no-meaningful-reduction",
        }),
        kind: "planner-decision",
        stage: "consolidate",
        transport: "internal",
      },
      { maxWidth: 84, mode: "trace", sequence: 4 },
    );

    expect(lines[0]).toContain("Consolidation noop #4 trace");
  });

  test("renders retry warnings with yellow trace frames", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify({
          decision: "consolidation-retry-scheduled",
          failedAttemptCount: 1,
          maxAttemptCount: 2,
        }),
        kind: "planner-decision",
        stage: "consolidate",
        transport: "internal",
      },
      { maxWidth: 84, mode: "trace", sequence: 1 },
    );

    expect(lines[0]).toContain("\x1b[33m");
    expect(lines.some((line) => line.startsWith("\x1b[33m│\x1b[0m"))).toBe(true);
  });

  test("formats sub-millisecond event durations without rounding down to zero", () => {
    const lines = formatVerboseAiOutputLines(
      {
        content: JSON.stringify({
          decision: "plan-finalization",
          finalCommitCount: 1,
        }),
        durationMs: 0.24,
        kind: "planner-decision",
        stage: "consolidate",
        transport: "internal",
      },
      { maxWidth: 84, mode: "trace", sequence: 1 },
    );

    expect(lines.some((line) => line.includes("time: <1ms"))).toBe(true);
  });
});
