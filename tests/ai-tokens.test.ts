import type { DiffChunk, FileDiff } from "../src/diff.js";

const { describe, expect, test } = await import("bun:test");
const {
  estimateGenerateOperationTokens,
  estimatePlanOperationTokens,
  estimateTextTokens,
} = await import("../src/ai-tokens.js");
const { DEFAULTS } = await import("../src/config.js");

function makeFileDiff(path: string, hunkCount = 1): FileDiff {
  return {
    additions: hunkCount,
    deletions: 0,
    hunks: Array.from({ length: hunkCount }, (_, index) => ({
      countNew: 1,
      countOld: 0,
      header: `@@ -${String(index + 1)},0 +${String(index + 1)},1 @@`,
      lines: [`+line ${String(index + 1)}`],
      startNew: index + 1,
      startOld: index + 1,
    })),
    oldPath: null,
    path,
    status: "modified",
  };
}

describe("ai token estimation", () => {
  test("estimates text tokens from content length", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
  });

  test("estimates generate flow across chunk generation and merge", () => {
    const chunks: DiffChunk[] = [
      {
        content: "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new",
        files: ["a.ts"],
        id: 0,
        lineCount: 5,
      },
      {
        content: "--- b.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new",
        files: ["b.ts"],
        id: 1,
        lineCount: 5,
      },
    ];

    const estimate = estimateGenerateOperationTokens(
      chunks,
      { additions: 2, chunks: 2, deletions: 2, filesChanged: 2 },
      DEFAULTS,
    );

    expect(estimate.requestCount).toBe(3);
    expect(estimate.totalTokens).toBeGreaterThan(estimate.peakRequestTokens);
    expect(estimate.totalOutputTokens).toBe(3 * DEFAULTS.openai.maxTokens);
  });

  test("estimates multi-batch planning with a consolidation pass", () => {
    const files = Array.from({ length: 25 }, (_, index) =>
      makeFileDiff(`src/file-${String(index)}.ts`),
    );

    const estimate = estimatePlanOperationTokens(
      files,
      (file) =>
        [
          `--- ${file.path}`,
          `+++ ${file.path}`,
          ...file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines]),
        ].join("\n"),
      DEFAULTS,
    );

    expect(estimate.requestCount).toBeGreaterThan(1);
    expect(estimate.totalTokens).toBeGreaterThan(estimate.peakRequestTokens);
    expect(estimate.totalOutputTokens).toBeGreaterThanOrEqual(
      2 * DEFAULTS.openai.maxTokens,
    );
  });
});
