import { ConfigError, OpenAIError, OpenAITimeoutError } from "../src/application/errors.js";
import {
  buildCompletionRequest,
  isNonChatModelError,
  readChatContent,
  rethrowTimeoutError,
  supportsTemperature,
  toOpenAiCallError,
  validateModelName,
} from "../src/commit-planning/client-support.js";
import {
  buildPlaceholderPlanGroupsForEstimate,
  estimateLikelyConsolidationPassCount,
  estimateLikelyPlanGroupCount,
} from "../src/commit-planning/planner-heuristics.js";

const { describe, expect, test } = await import("bun:test");

type FileDiff = import("../src/git/diff.js").FileDiff;

function makeFile(path: string, hunkCount = 1): FileDiff {
  return {
    additions: hunkCount,
    deletions: 0,
    hunks: Array.from({ length: hunkCount }, (_, index) => ({
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

describe("planner helper coverage", () => {
  test("buildPlaceholderPlanGroupsForEstimate collapses to one summary group when the estimate is one", () => {
    const files = [makeFile("src/app.ts"), makeFile("tests/app.test.ts")];

    expect(buildPlaceholderPlanGroupsForEstimate(files, 1)).toEqual([
      {
        files: [{ path: "src/app.ts" }, { path: "tests/app.test.ts" }],
        message:
          "chore(plan): summarize staged changes\n\n- Cover the staged changes coherently.",
      },
    ]);
  });

  test("buildPlaceholderPlanGroupsForEstimate splits files into numbered batches", () => {
    const files = [
      makeFile("src/a.ts"),
      makeFile("src/b.ts"),
      makeFile("src/c.ts"),
      makeFile("src/d.ts"),
    ];

    expect(buildPlaceholderPlanGroupsForEstimate(files, 3)).toEqual([
      {
        files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        message: "feat(plan): change 1\n\n- Cover the staged files grouped into change 1.",
      },
      {
        files: [{ path: "src/c.ts" }, { path: "src/d.ts" }],
        message: "feat(plan): change 2\n\n- Cover the staged files grouped into change 2.",
      },
    ]);
  });

  test("estimateLikelyConsolidationPassCount buffers larger plans and caps the result", () => {
    expect(estimateLikelyConsolidationPassCount(2)).toBe(0);
    expect(estimateLikelyConsolidationPassCount(5)).toBe(3);
    expect(estimateLikelyConsolidationPassCount(100)).toBeLessThanOrEqual(6);
  });

  test("estimateLikelyPlanGroupCount uses hunk complexity and top-level area breadth", () => {
    expect(estimateLikelyPlanGroupCount([makeFile("src/app.ts")])).toBe(1);
    expect(
      estimateLikelyPlanGroupCount([
        makeFile("src/app.ts", 2),
        makeFile("tests/app.test.ts", 1),
        makeFile("scripts/build.ts", 3),
      ]),
    ).toBe(3);
  });
});

describe("client support coverage", () => {
  const cfg = {
    analysis: {
      chunkSize: 800,
      groupByFile: true,
      groupByHunk: true,
      maxDiffLines: 2000,
      promptOnTokenWarning: true,
      tokenWarningThreshold: 10000,
    },
    commit: {
      conventional: true,
      includeBody: true,
      includeScope: true,
      language: "en",
      maxBodyLineLength: 80,
      maxSubjectLength: 72,
    },
    openai: {
      apiKey: "",
      maxTokens: 512,
      model: "gpt-4o-mini",
      temperature: 0.3,
    },
    performance: {
      cacheEnabled: true,
      cacheTTLSeconds: 300,
      parallel: true,
      timeoutMs: 15000,
    },
  } as const;

  test("buildCompletionRequest respects overrides and zero timeout", () => {
    const request = buildCompletionRequest(cfg, {
      maxTokens: 200,
      stage: "group",
      temperature: 0.1,
      timeoutMs: 0,
    });

    expect(request).toEqual({
      maxTokens: 200,
      signal: undefined,
      stage: "group",
      temperature: 0.1,
      timeoutMs: 0,
    });
  });

  test("isNonChatModelError recognizes both supported message variants", () => {
    expect(isNonChatModelError(new Error("This is not a chat model"))).toBe(true);
    expect(
      isNonChatModelError("Model is not supported in the v1/chat/completions API"),
    ).toBe(true);
    expect(isNonChatModelError(new Error("different failure"))).toBe(false);
  });

  test("readChatContent trims valid responses and rejects empty content", () => {
    expect(
      readChatContent({ choices: [{ message: { content: "  hello world  " } }] }),
    ).toBe("hello world");
    expect(() => readChatContent({ choices: [{ message: { content: "   " } }] })).toThrow(
      OpenAIError,
    );
  });

  test("rethrowTimeoutError upgrades abort and timeout failures", () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";

    expect(() => rethrowTimeoutError(abortError, 2500)).toThrow(OpenAITimeoutError);
    expect(() => rethrowTimeoutError(new Error("socket timeout"), 2500)).toThrow(
      OpenAITimeoutError,
    );
    expect(() => rethrowTimeoutError(new Error("other failure"), 2500)).not.toThrow();
  });

  test("supportsTemperature and toOpenAiCallError cover model and error branches", () => {
    expect(supportsTemperature("gpt-4o-mini")).toBe(true);
    expect(supportsTemperature("gpt-5.4")).toBe(false);
    expect(toOpenAiCallError(new Error("boom"))).toBeInstanceOf(OpenAIError);
    expect(toOpenAiCallError("boom")).toBeInstanceOf(OpenAIError);
  });

  test("validateModelName rejects empty, long, and invalid values", () => {
    expect(() => validateModelName("  ")).toThrow(ConfigError);
    expect(() => validateModelName("x".repeat(101))).toThrow(ConfigError);
    expect(() => validateModelName("bad/model")).toThrow(ConfigError);
    expect(() => validateModelName("gpt-4o-mini")).not.toThrow();
  });
});