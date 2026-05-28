import {
  ConfigError,
  OpenAIError,
  OpenAITimeoutError,
} from "../src/application/errors.js";
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
        message:
          "feat(plan): change 1\n\n- Cover the staged files grouped into change 1.",
      },
      {
        files: [{ path: "src/c.ts" }, { path: "src/d.ts" }],
        message:
          "feat(plan): change 2\n\n- Cover the staged files grouped into change 2.",
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

  test("hasImplementationMergeSignal rejects mixed direct-file and subtree work within one feature root", () => {
    const groupingGroup = {
      files: [
        {
          path: "src/commit-planning/grouping/repartition.ts",
        },
        {
          path: "src/commit-planning/grouping/support-attachment/test-ownership.ts",
        },
      ],
      message:
        "fix(grouping): prevent weak-owner support attachment and improve premerge matching",
    };
    const pathResolverGroup = {
      files: [{ path: "src/commit-planning/path/resolver.ts" }],
      message:
        "fix(paths): resolve unique basenames with directory compatibility",
    };
    const files = [
      makeFile("src/commit-planning/grouping/repartition.ts"),
      makeFile(
        "src/commit-planning/grouping/support-attachment/test-ownership.ts",
      ),
      makeFile("src/commit-planning/path/resolver.ts"),
    ];
    const fileSignals = buildFileChangeSignals(files);
    const implementationGroups = [groupingGroup, pathResolverGroup];

    expect(
      hasImplementationMergeSignal(
        groupingGroup,
        pathResolverGroup,
        fileSignals,
        getCommonActionWords(implementationGroups),
        getCommonIntentWords(implementationGroups, fileSignals),
      ),
    ).toBe(false);
  });

  test("chooseSupportAttachment prefers the implementation whose details match a focused validation regression", () => {
    const supportGroup = {
      files: [{ path: "tests/response-validation.test.ts" }],
      message:
        "test(validation): cover dropped-directory path normalization\n\n- Verify basename fallback resolves canonical planner paths with directory checks.",
    };
    const pathResolverGroup = {
      files: [{ path: "src/commit-planning/path/resolver.ts" }],
      message:
        "fix(commit-planning): resolve paths by compatible basename fallback\n\n- Add canonical basename fallback with directory compatibility checks.",
    };
    const groupingGroup = {
      files: [
        {
          path: "src/commit-planning/grouping/repartition.ts",
        },
      ],
      message:
        "fix(grouping): split broad test support by owning implementation\n\n- Tighten weak support attachment decisions for broad test buckets.",
    };
    const files = [
      makeFile("tests/response-validation.test.ts"),
      makeFile("src/commit-planning/path/resolver.ts"),
      makeFile("src/commit-planning/grouping/repartition.ts"),
    ];
    const fileSignals = buildFileChangeSignals(files);

    expect(
      chooseSupportAttachment(
        supportGroup,
        [pathResolverGroup, groupingGroup],
        [[0], [1]],
        fileSignals,
      ),
    ).toBe(0);
  });

  test("chooseSupportAttachment ignores generic test-root ownership overlap", () => {
    const supportGroup = {
      files: [{ path: "tests/cli.test.ts" }],
      message:
        "test(cli): cover single-commit breaking mode passthrough\n\n- Keep CLI help and single-commit wiring aligned with release-impact mode selection.",
    };
    const breakingMessagesGroup = {
      files: [
        { path: "src/commit-messages/breaking-change-footers.ts" },
        { path: "src/commit-messages/subject-parser.ts" },
        { path: "tests/commit-messages.test.ts" },
      ],
      message:
        "feat(messages): enforce and manage breaking-change metadata\n\n- Add footer parsing and stricter breaking-subject handling.",
    };
    const files = [
      makeFile("tests/cli.test.ts"),
      makeFile("src/commit-messages/breaking-change-footers.ts"),
      makeFile("src/commit-messages/subject-parser.ts"),
      makeFile("tests/commit-messages.test.ts"),
    ];
    const fileSignals = buildFileChangeSignals(files);

    expect(
      chooseSupportAttachment(
        supportGroup,
        [breakingMessagesGroup],
        [[0]],
        fileSignals,
      ),
    ).toBe(-1);
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
      model: "gpt-5.3-codex",
      temperature: 0.3,
    },
    performance: {
      cacheEnabled: true,
      maxSavedPlanBundles: 50,
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
    expect(isNonChatModelError(new Error("This is not a chat model"))).toBe(
      true,
    );
    expect(
      isNonChatModelError(
        "Model is not supported in the v1/chat/completions API",
      ),
    ).toBe(true);
    expect(isNonChatModelError(new Error("different failure"))).toBe(false);
  });

  test("readChatContent trims valid responses and rejects empty content", () => {
    expect(
      readChatContent({
        choices: [{ message: { content: "  hello world  " } }],
      }),
    ).toBe("hello world");
    expect(() =>
      readChatContent({ choices: [{ message: { content: "   " } }] }),
    ).toThrow(OpenAIError);
  });

  test("rethrowTimeoutError upgrades abort and timeout failures", () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";

    expect(() => rethrowTimeoutError(abortError, 2500)).toThrow(
      OpenAITimeoutError,
    );
    expect(() =>
      rethrowTimeoutError(new Error("socket timeout"), 2500),
    ).toThrow(OpenAITimeoutError);
    expect(() =>
      rethrowTimeoutError(new Error("other failure"), 2500),
    ).not.toThrow();
  });

  test("supportsTemperature and toOpenAiCallError cover model and error branches", () => {
    expect(supportsTemperature("gpt-5.3-codex")).toBe(true);
    expect(supportsTemperature("gpt-5.4")).toBe(false);
    expect(toOpenAiCallError(new Error("boom"))).toBeInstanceOf(OpenAIError);
    expect(toOpenAiCallError("boom")).toBeInstanceOf(OpenAIError);
  });

  test("validateModelName rejects empty, long, and invalid values", () => {
    expect(() => validateModelName("  ")).toThrow(ConfigError);
    expect(() => validateModelName("x".repeat(101))).toThrow(ConfigError);
    expect(() => validateModelName("bad/model")).toThrow(ConfigError);
    expect(() => validateModelName("gpt-5.3-codex")).not.toThrow();
  });
});
