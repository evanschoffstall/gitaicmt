import * as readline from "node:readline";

import * as applicationConfig from "../src/application/config/index.js";
import * as groupStaging from "../src/cli/commit/group-staging.js";
import * as interactivePrompt from "../src/cli/interactive-prompt.js";
import * as outputPresentation from "../src/cli/output-presentation.js";
import * as sessionDisplayExports from "../src/cli/session-display.js";
import * as terminalColumns from "../src/cli/terminal/columns.js";
import * as lineWrapping from "../src/cli/terminal/line-wrapping.js";
import * as outputUi from "../src/cli/terminal/output-ui.js";
import * as verboseOutput from "../src/cli/verbose-output.js";
import * as viewport from "../src/cli/viewport.js";
import * as orchestration from "../src/commit-planning/orchestration.js";
import * as gitOperations from "../src/git/operations.js";

const { afterEach, describe, expect, mock, spyOn, test } = await import("bun:test");

type AppConfig = ReturnType<typeof applicationConfig.loadConfig>;
type TokenEstimateSummary = Parameters<
  typeof sessionDisplayExports.logTokenEstimate
>[0];
type TokenUsageSummary = Parameters<
  typeof sessionDisplayExports.logActualTokenUsage
>[0];
type VerboseEvent = Parameters<typeof sessionDisplayExports.logVerboseAiOutput>[0];

let restoreStdin: (() => void) | null = null;

function baseEstimate(
  overrides?: Partial<TokenEstimateSummary>,
): TokenEstimateSummary {
  return {
    minimumRequestCount: 1,
    minimumTotalTokens: 120,
    peakRequestTokens: 180,
    requestCount: 1,
    totalInputTokens: 90,
    totalOutputTokens: 90,
    totalTokens: 180,
    ...overrides,
  };
}

function createConfig(overrides?: {
  promptOnTokenWarning?: boolean;
  tokenWarningThreshold?: number;
}): AppConfig {
  return {
    analysis: {
      chunkSize: 800,
      groupByFile: true,
      groupByHunk: true,
      maxDiffLines: 2000,
      promptOnTokenWarning: overrides?.promptOnTokenWarning ?? true,
      tokenWarningThreshold: overrides?.tokenWarningThreshold ?? 150,
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
      model: "gpt-5.4",
      temperature: 0.3,
    },
    performance: {
      cacheEnabled: true,
      cacheTTLSeconds: 300,
      parallel: true,
      timeoutMs: 15000,
    },
  };
}

function createStdinTracker(): {
  offCalls: [event: string, listener: (...args: unknown[]) => void][];
  onceCalls: [event: string, listener: (...args: unknown[]) => void][];
  stdin: Pick<NodeJS.ReadStream, "off" | "once">;
} {
  const offCalls: [event: string, listener: (...args: unknown[]) => void][] = [];
  const onceCalls: [event: string, listener: (...args: unknown[]) => void][] = [];
  const stdin = {
    off(
      event: string,
      listener: (...args: unknown[]) => void,
    ): NodeJS.ReadStream {
      offCalls.push([event, listener]);
      return stdin as unknown as NodeJS.ReadStream;
    },
    once(
      event: string,
      listener: (...args: unknown[]) => void,
    ): NodeJS.ReadStream {
      onceCalls.push([event, listener]);
      return stdin as unknown as NodeJS.ReadStream;
    },
  };

  return {
    offCalls,
    onceCalls,
    stdin,
  };
}

function createTokenUsageSummary(
  totalTokens: number,
  requestCount: number,
): TokenUsageSummary {
  const inputTokens = Math.floor(totalTokens / 2);

  return {
    inputTokens,
    outputTokens: totalTokens - inputTokens,
    requestCount,
    totalTokens,
  };
}

function createVerboseEvent(stage: string): VerboseEvent {
  return {
    content: "payload",
    stage,
    timestamp: new Date().toISOString(),
  } as VerboseEvent;
}

async function importFresh<T>(
  relativePath: string,
  tag: string,
): Promise<T> {
  return import(
    new URL(`${relativePath}?${tag}-${Math.random()}`, import.meta.url).href,
  ) as Promise<T>;
}

function replaceProcessStdin(
  stdin: Pick<NodeJS.ReadStream, "off" | "once">,
): void {
  const originalStdin = process.stdin;
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: stdin,
  });
  restoreStdin = () => {
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: originalStdin,
    });
    restoreStdin = null;
  };
}

afterEach(() => {
  mock.restore();
  restoreStdin?.();
});

describe("cli coverage", () => {
  test("counts helpers cover every label and threshold branch", async () => {
    const counts = await importFresh<typeof import("../src/cli/counts.js")>(
      "../src/cli/counts.js",
      "counts",
    );

    expect(counts.formatCount(42)).toBe("42");
    expect(counts.formatRequestCount(2)).toBe("2 request(s)");
    expect(counts.formatStageUsageLabel("cluster")).toBe("merge-review");
    expect(counts.formatStageUsageLabel("consolidate")).toBe(
      "final-consolidation",
    );
    expect(counts.formatStageUsageLabel("generate")).toBe("message-draft");
    expect(counts.formatStageUsageLabel("group")).toBe("grouping");
    expect(counts.formatStageUsageLabel("merge")).toBe("message-merge");
    expect(counts.formatStageUsageLabel("other")).toBe("other");
    expect(counts.formatTokenWarning(500)).toContain("500");
    expect(
      counts.isHighTokenEstimate(
        baseEstimate({ peakRequestTokens: 149, totalTokens: 149 }),
        150,
      ),
    ).toBe(false);
    expect(
      counts.isHighTokenEstimate(
        baseEstimate({ peakRequestTokens: 149, totalTokens: 150 }),
        150,
      ),
    ).toBe(true);
    expect(
      counts.isHighTokenEstimate(
        baseEstimate({ peakRequestTokens: 151, totalTokens: 120 }),
        150,
      ),
    ).toBe(true);
    expect(counts.isHighTokenEstimate(baseEstimate(), 0)).toBe(false);
  });

  test("viewport width helpers clamp against the shared terminal width", async () => {
    let callIndex = 0;
    spyOn(terminalColumns, "resolveTerminalColumns").mockImplementation(() => {
      const widths = [18, 40, 160];
      const width = widths[Math.min(callIndex, widths.length - 1)] ?? 100;
      callIndex += 1;
      return width;
    });

    const viewportModule = await importFresh<typeof import("../src/cli/viewport.js")>(
      "../src/cli/viewport.js",
      "viewport",
    );

    expect(viewportModule.resolveDisplayWidth()).toBe(24);
    expect(viewportModule.resolveLogWidth()).toBe(39);
    expect(viewportModule.resolveVerboseWidth()).toBe(146);
  });

  test("fatal reporter wraps the formatted error and exits non-zero", async () => {
    const writes: string[][] = [];

    spyOn(viewport, "resolveLogWidth").mockReturnValue(72);
    spyOn(lineWrapping, "wrapTerminalTextBlock").mockImplementation(
      (message, width) => [`wrapped:${width}:${message}`],
    );
    spyOn(outputUi, "writeTerminalLines").mockImplementation((lines) => {
      writes.push(lines);
    });
    spyOn(process, "exit").mockImplementation(
      ((code?: null | number | string | undefined) => {
        throw new Error(`exit:${code}`);
      }) as never,
    );

    const fatal = await importFresh<typeof import("../src/cli/fatal.js")>(
      "../src/cli/fatal.js",
      "fatal",
    );

    expect(() => fatal.die("boom")).toThrow("exit:1");
    expect(writes).toEqual([["wrapped:72:\u001b[31merror:\u001b[0m boom"]]);
  });

  test("response text extraction prefers output_text then filtered content blocks", async () => {
    const outputText = await importFresh<
      typeof import("../src/commit-planning/output-text.js")
    >("../src/commit-planning/output-text.js", "output-text");

    expect(outputText.extractResponseText({ output_text: "  final text  " })).toBe(
      "final text",
    );
    expect(
      outputText.extractResponseText({
        output: [
          {
            content: [
              { text: "ignored", type: "input_text" },
              { text: "alpha", type: "text" },
            ],
          },
          {
            content: [
              { text: "beta", type: "output_text" },
              { text: 12, type: "text" },
            ],
          },
        ],
      }),
    ).toBe("alpha\nbeta");
    expect(
      outputText.extractResponseText({
        output: [{ content: [{ type: "refusal" }] }],
      }),
    ).toBe("");
  });

  test("interactive prompt accepts yes, no, and eof flows while cleaning listeners", async () => {
    const writes: string[][] = [];
    const prompts: string[] = [];
    const tracker = createStdinTracker();
    const answers = ["maybe", " YES  "];

    replaceProcessStdin(tracker.stdin);
    spyOn(viewport, "resolveLogWidth").mockReturnValue(44);
    spyOn(lineWrapping, "wrapTerminalTextBlock").mockReturnValue([
      "wrapped question line 1",
      "wrapped question line 2",
    ]);
    spyOn(outputUi, "writeTerminalLines").mockImplementation((lines) => {
      writes.push(lines);
    });
    spyOn(readline, "createInterface").mockImplementation(
      () =>
        ({
          close() {
            return undefined;
          },
          question(prompt: string, callback: (answer: string) => void) {
            prompts.push(prompt);
            callback(answers.shift() ?? "");
          },
        }) as never,
    );

    const promptModule = await importFresh<
      typeof import("../src/cli/interactive-prompt.js")
    >("../src/cli/interactive-prompt.js", "prompt-yes");

    expect(await promptModule.promptYesNo("Proceed?")).toBe(true);
    expect(prompts).toEqual([
      "wrapped question line 2 \u001b[2m(y/n)\u001b[0m ",
      "wrapped question line 2 \u001b[2m(y/n)\u001b[0m ",
    ]);
    expect(writes).toEqual([
      ["wrapped question line 1"],
      ["wrapped question line 1"],
    ]);
    expect(tracker.offCalls).toHaveLength(2);

    mock.restore();
    restoreStdin?.();

    const noTracker = createStdinTracker();
    replaceProcessStdin(noTracker.stdin);
    spyOn(viewport, "resolveLogWidth").mockReturnValue(44);
    spyOn(lineWrapping, "wrapTerminalTextBlock").mockReturnValue(["single line"]);
    spyOn(outputUi, "writeTerminalLines").mockImplementation(() => undefined);
    spyOn(readline, "createInterface").mockImplementation(
      () =>
        ({
          close() {
            return undefined;
          },
          question(_prompt: string, callback: (answer: string) => void) {
            callback("n");
          },
        }) as never,
    );

    const noPromptModule = await importFresh<
      typeof import("../src/cli/interactive-prompt.js")
    >("../src/cli/interactive-prompt.js", "prompt-no");

    expect(await noPromptModule.promptYesNo("Stop?")).toBe(false);

    mock.restore();
    restoreStdin?.();

    const eofTracker = createStdinTracker();
    const eofWrites: string[][] = [];
    replaceProcessStdin(eofTracker.stdin);
    spyOn(viewport, "resolveLogWidth").mockReturnValue(44);
    spyOn(lineWrapping, "wrapTerminalTextBlock").mockReturnValue([
      "wrapped question line 1",
      "wrapped question line 2",
    ]);
    spyOn(outputUi, "writeTerminalLines").mockImplementation((lines) => {
      eofWrites.push(lines);
    });
    spyOn(readline, "createInterface").mockImplementation(
      () =>
        ({
          close() {
            return undefined;
          },
          question(_prompt: string, callback: (answer: string) => void) {
            eofTracker.onceCalls.at(-1)?.[1]();
            callback("ignored");
          },
        }) as never,
    );

    const eofPromptModule = await importFresh<
      typeof import("../src/cli/interactive-prompt.js")
    >("../src/cli/interactive-prompt.js", "prompt-eof");

    expect(await eofPromptModule.promptYesNo("EOF?")).toBe(true);
    expect(eofWrites.at(-1)).toEqual([""]);
  });

  test("session display logs status, token estimates, and verbose output branches", async () => {
    const renderedBlocks: { rows: unknown; title: string; width: number }[] = [];
    const terminalLines: string[][] = [];
    const verboseCalls: { event: unknown; options: unknown }[] = [];

    spyOn(viewport, "resolveLogWidth").mockReturnValue(60);
    spyOn(viewport, "resolveVerboseWidth").mockReturnValue(80);
    spyOn(lineWrapping, "wrapTerminalTextBlock").mockImplementation(
      (message, width) => [`wrapped:${width}:${message}`],
    );
    spyOn(outputUi, "writeTerminalLines").mockImplementation((lines) => {
      terminalLines.push(lines);
    });
    spyOn(outputPresentation, "buildStatusSectionLines").mockImplementation(
      (title, rows, width) => {
        renderedBlocks.push({ rows, title, width });
        return [`section:${title}:${width}`];
      },
    );
    spyOn(verboseOutput, "getVerboseAiOutputSequenceKey").mockImplementation(
      (event) => (event as { type?: string }).type ?? "unknown",
    );
    spyOn(verboseOutput, "formatVerboseAiOutputLines").mockImplementation(
      (event, options) => {
        verboseCalls.push({ event, options });
        return ["first line", "second line"];
      },
    );

    const sessionDisplay = await importFresh<
      typeof import("../src/cli/session-display.js")
    >("../src/cli/session-display.js", "session-display");

    sessionDisplay.configureOutputMode("off");
    expect(sessionDisplay.hasVisibleOutputMode()).toBe(false);
    expect(sessionDisplay.isVerboseModeEnabled()).toBe(false);

    sessionDisplay.log("plain message");
    expect(terminalLines.pop()).toEqual(["wrapped:60:plain message"]);

    sessionDisplay.logTokenEstimate(baseEstimate({ requestCount: 0 }), 150);
    expect(renderedBlocks).toHaveLength(0);

    sessionDisplay.logTokenEstimate(
      baseEstimate({
        minimumRequestCount: 1,
        minimumTotalTokens: 120,
        requestCount: 2,
        totalTokens: 260,
      }),
      150,
    );
    expect(renderedBlocks[0]?.title).toBe("Token Estimate");
    expect(JSON.stringify(renderedBlocks[0]?.rows)).toContain("baseline");
    expect(JSON.stringify(renderedBlocks[0]?.rows)).toContain("warning");

    sessionDisplay.logTokenEstimate(
      baseEstimate({ minimumTotalTokens: 180, totalTokens: 180 }),
      500,
      true,
    );
    expect(JSON.stringify(renderedBlocks[1]?.rows)).toContain("estimate");
    expect(JSON.stringify(renderedBlocks[1]?.rows)).not.toContain("warning");

    sessionDisplay.logGenerationContext(
      "gpt-5.4",
      { additions: 12, chunks: 3, deletions: 4, filesChanged: 2 },
      baseEstimate({ peakRequestTokens: 120, requestCount: 1, totalTokens: 140 }),
      150,
    );
    expect(
      renderedBlocks.some((block) => block.title === "Generating Message"),
    ).toBe(true);

    sessionDisplay.logActualTokenUsage(createTokenUsageSummary(480, 3), {
      cluster: createTokenUsageSummary(200, 1),
      ignored: createTokenUsageSummary(25, 0),
    });
    expect(JSON.stringify(renderedBlocks.at(-1)?.rows)).not.toContain(
      "merge-review",
    );

    sessionDisplay.configureOutputMode("summary");
    sessionDisplay.logActualTokenUsage(createTokenUsageSummary(220, 2), {
      cluster: createTokenUsageSummary(120, 1),
      merge: createTokenUsageSummary(100, 1),
    });
    expect(JSON.stringify(renderedBlocks.at(-1)?.rows)).toContain(
      "merge-review=120",
    );
    expect(JSON.stringify(renderedBlocks.at(-1)?.rows)).toContain(
      "message-merge=100",
    );

    sessionDisplay.verbose("summary message");
    expect(terminalLines.at(-1)?.[0]).toContain("[verbose] summary message");

    sessionDisplay.logCommitPlanAnalysis({
      elapsed: "1.5",
      groups: [{ files: [{ path: "src/a.ts" }], message: "feat: one" }],
      plannerFallbackNotice: "fallback used",
    });
    expect(terminalLines.at(-2)?.[0]).toContain(
      "wrapped:60:\u001b[33mfallback used\u001b[0m",
    );

    sessionDisplay.logVerboseAiOutput(createVerboseEvent("planner"));
    expect(verboseCalls[0]?.options).toEqual({
      maxWidth: 80,
      mode: "summary",
      sequence: 1,
    });
    expect(terminalLines.at(-1)).toEqual([
      "\u001b[2m[verbose]\u001b[0m first line",
      "\u001b[2m[verbose]\u001b[0m second line",
    ]);

    sessionDisplay.configureOutputMode("trace");
    sessionDisplay.verbose("trace message");
    expect(terminalLines.at(-1)?.[0]).toContain("[trace] trace message");

    sessionDisplay.logVerboseAiOutput(createVerboseEvent("planner"));
    expect(verboseCalls.at(-1)?.options).toEqual({
      maxWidth: 80,
      mode: "trace",
      sequence: 1,
    });

    sessionDisplay.configureOutputMode("off");
    sessionDisplay.verbose("hidden");
    expect(terminalLines.at(-1)?.[0]).not.toContain("hidden");
  });

  test("token confirmation covers auto-confirm, prompts, warnings, and validation", async () => {
    const actualUsageCalls: { usage: unknown; usageByStage: unknown }[] = [];
    const generationCalls: unknown[] = [];
    const logs: string[] = [];
    const promptQuestions: string[] = [];
    const promptAnswers = [false, true, true, false];
    let validated = 0;

    spyOn(orchestration, "getTokenUsageByStage").mockReturnValue({
      group: { requestCount: 1, totalTokens: 45 },
    } as never);
    spyOn(orchestration, "getTokenUsageSummary").mockReturnValue({
      requestCount: 2,
      totalTokens: 99,
    } as never);
    spyOn(orchestration, "validateOpenAIConfiguration").mockImplementation(() => {
      validated += 1;
    });
    spyOn(interactivePrompt, "promptYesNo").mockImplementation(async (question) => {
      promptQuestions.push(question);
      return promptAnswers.shift() ?? true;
    });
    spyOn(outputPresentation, "buildReadyPromptLines").mockImplementation(
      (plannedCommitCount, width) => [`ready:${plannedCommitCount}:${width}`],
    );
    spyOn(sessionDisplayExports, "log").mockImplementation((message) => {
      logs.push(message);
    });
    spyOn(sessionDisplayExports, "logActualTokenUsage").mockImplementation(
      (usage, usageByStage) => {
        actualUsageCalls.push({ usage, usageByStage });
      },
    );
    spyOn(sessionDisplayExports, "logGenerationContext").mockImplementation(
      (...args) => {
        generationCalls.push(args);
      },
    );
    spyOn(viewport, "resolveLogWidth").mockReturnValue(58);

    const tokenConfirmation = await importFresh<
      typeof import("../src/cli/token/confirmation.js")
    >("../src/cli/token/confirmation.js", "token-confirmation");

    expect(await tokenConfirmation.confirmCommitPlan(true, 2)).toBe(true);
    expect(actualUsageCalls).toHaveLength(0);

    expect(await tokenConfirmation.confirmCommitPlan(false, 3)).toBe(false);
    expect(actualUsageCalls).toHaveLength(1);
    expect(promptQuestions[0]).toBe("ready:3:58");
    expect(logs.at(-1)).toContain("Aborted.");

    expect(
      tokenConfirmation.shouldPromptForHighTokenUsage(
        baseEstimate(),
        createConfig(),
        { skipPrompt: false },
      ),
    ).toBe(true);
    expect(
      tokenConfirmation.shouldPromptForHighTokenUsage(
        baseEstimate(),
        createConfig({ promptOnTokenWarning: false }),
        { skipPrompt: false },
      ),
    ).toBe(false);
    expect(
      tokenConfirmation.shouldPromptForHighTokenUsage(
        baseEstimate(),
        createConfig(),
        { skipPrompt: true },
      ),
    ).toBe(false);

    expect(
      await tokenConfirmation.confirmTokenUsage(
        baseEstimate({ peakRequestTokens: 120, totalTokens: 120 }),
        createConfig(),
        { skipPrompt: false },
      ),
    ).toBe(true);
    expect(
      await tokenConfirmation.confirmTokenUsage(
        baseEstimate(),
        createConfig(),
        { skipPrompt: false },
      ),
    ).toBe(true);

    expect(
      await tokenConfirmation.confirmTokenCheckedGeneration(
        createConfig(),
        { additions: 3, chunks: 1, deletions: 1, filesChanged: 1 },
        baseEstimate(),
        false,
      ),
    ).toBe(true);
    expect(generationCalls).toHaveLength(1);
    expect(validated).toBe(1);

    expect(
      await tokenConfirmation.confirmTokenCheckedGeneration(
        createConfig(),
        { additions: 3, chunks: 1, deletions: 1, filesChanged: 1 },
        baseEstimate(),
        true,
      ),
    ).toBe(true);
    expect(generationCalls).toHaveLength(2);
    expect(validated).toBe(2);

    expect(
      await tokenConfirmation.confirmTokenCheckedGeneration(
        createConfig({ tokenWarningThreshold: 150 }),
        { additions: 3, chunks: 1, deletions: 1, filesChanged: 1 },
        baseEstimate({ peakRequestTokens: 200, totalTokens: 200 }),
        false,
      ),
    ).toBe(false);
    expect(logs.at(-1)).toContain("Aborted.");
  });

  test("commit execution covers success, skipped groups, and single commit rendering", async () => {
    const hasStagedChangesQueue = [true, false];
    const logMessages: string[] = [];
    const restoreCalls: string[] = [];
    const stagedGroups: unknown[] = [];
    const terminalLines: string[][] = [];

    spyOn(gitOperations, "commitWithMessage").mockImplementation((message) => ({
      stderr: message.includes("stderr") ? "stderr text" : "",
      stdout: `committed:${message}`,
    }));
    spyOn(gitOperations, "getStagedPatch").mockReturnValue("saved patch");
    spyOn(gitOperations, "hasStagedChanges").mockImplementation(
      () => hasStagedChangesQueue.shift() ?? true,
    );
    spyOn(gitOperations, "resetStaging").mockImplementation(() => undefined);
    spyOn(gitOperations, "restoreStagedPatch").mockImplementation((patch) => {
      restoreCalls.push(patch);
    });
    spyOn(outputPresentation, "buildExecutionCommitLines").mockImplementation(
      (payload) => [`header:${JSON.stringify(payload)}`],
    );
    spyOn(outputPresentation, "buildExecutionResultLines").mockImplementation(
      (text, width) => (text.length === 0 ? [] : [`result:${width}:${text}`]),
    );
    spyOn(sessionDisplayExports, "log").mockImplementation((message) => {
      logMessages.push(message);
    });
    spyOn(outputUi, "writeTerminalLines").mockImplementation((lines) => {
      terminalLines.push(lines);
    });
    spyOn(viewport, "resolveDisplayWidth").mockReturnValue(76);
    spyOn(groupStaging, "stageGroupFiles").mockImplementation((files, fileMap) => {
      stagedGroups.push({ fileMap, files });
    });
    spyOn(performance, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2800);

    const execution = await importFresh<
      typeof import("../src/cli/commit/execution.js")
    >("../src/cli/commit/execution.js", "execution-success");

    execution.executePlannedCommits(
      [
        { files: [{ path: "src/one.ts" }], message: "feat: one" },
        { files: [{ path: "src/two.ts" }], message: "feat: two" },
      ],
      new Map([
        ["src/one.ts", { hunks: [], path: "src/one.ts" }],
        ["src/two.ts", { hunks: [], path: "src/two.ts" }],
      ]) as never,
    );

    expect(stagedGroups).toHaveLength(2);
    expect(terminalLines[0]?.[0]).toContain("header:");
    expect(terminalLines[1]?.[0]).toContain("result:76:committed:feat: one");
    expect(
      logMessages.some((message) =>
        message.includes("skipped - no stageable changes remain"),
      ),
    ).toBe(true);
    expect(logMessages.at(-1)).toContain("Done:");

    execution.executeSingleCommitMessage("stderr commit");
    expect(terminalLines.at(-1)?.[0]).toContain("stderr text");
    expect(restoreCalls).toEqual([]);
  });

  test("commit execution restores staging on failure when recovery is available", async () => {
    const logMessages: string[] = [];
    const restoreCalls: string[] = [];

    spyOn(gitOperations, "commitWithMessage").mockImplementation(() => {
      throw new Error("commit failed");
    });
    spyOn(gitOperations, "getStagedPatch").mockReturnValue("saved patch");
    spyOn(gitOperations, "hasStagedChanges").mockReturnValue(true);
    spyOn(gitOperations, "resetStaging").mockImplementation(() => undefined);
    spyOn(gitOperations, "restoreStagedPatch").mockImplementation((patch) => {
      restoreCalls.push(patch);
    });
    spyOn(outputPresentation, "buildExecutionCommitLines").mockReturnValue([
      "header",
    ]);
    spyOn(outputPresentation, "buildExecutionResultLines").mockReturnValue([
      "result",
    ]);
    spyOn(sessionDisplayExports, "log").mockImplementation((message) => {
      logMessages.push(message);
    });
    spyOn(outputUi, "writeTerminalLines").mockImplementation(() => undefined);
    spyOn(viewport, "resolveDisplayWidth").mockReturnValue(76);
    spyOn(groupStaging, "stageGroupFiles").mockImplementation(() => undefined);

    const execution = await importFresh<
      typeof import("../src/cli/commit/execution.js")
    >("../src/cli/commit/execution.js", "execution-failure");

    expect(() =>
      execution.executePlannedCommits(
        [{ files: [{ path: "src/one.ts" }], message: "feat: broken" }],
        new Map([["src/one.ts", { hunks: [], path: "src/one.ts" }]]) as never,
      ),
    ).toThrow("commit failed");
    expect(restoreCalls).toEqual(["saved patch"]);
    expect(
      logMessages.some((message) =>
        message.includes("Attempting to restore initial staging state"),
      ),
    ).toBe(true);
    expect(
      logMessages.some((message) =>
        message.includes("Initial staging state restored successfully"),
      ),
    ).toBe(true);
  });

  test("commit execution reports manual recovery when patch capture fails", async () => {
    const logMessages: string[] = [];

    spyOn(gitOperations, "commitWithMessage").mockImplementation(() => {
      throw new Error("commit failed");
    });
    spyOn(gitOperations, "getStagedPatch").mockImplementation(() => {
      throw new Error("cannot snapshot");
    });
    spyOn(gitOperations, "hasStagedChanges").mockReturnValue(true);
    spyOn(gitOperations, "resetStaging").mockImplementation(() => undefined);
    spyOn(gitOperations, "restoreStagedPatch").mockImplementation(() => undefined);
    spyOn(outputPresentation, "buildExecutionCommitLines").mockReturnValue([
      "header",
    ]);
    spyOn(outputPresentation, "buildExecutionResultLines").mockReturnValue([
      "result",
    ]);
    spyOn(sessionDisplayExports, "log").mockImplementation((message) => {
      logMessages.push(message);
    });
    spyOn(outputUi, "writeTerminalLines").mockImplementation(() => undefined);
    spyOn(viewport, "resolveDisplayWidth").mockReturnValue(76);
    spyOn(groupStaging, "stageGroupFiles").mockImplementation(() => undefined);

    const execution = await importFresh<
      typeof import("../src/cli/commit/execution.js")
    >("../src/cli/commit/execution.js", "execution-manual");

    expect(() =>
      execution.executePlannedCommits(
        [{ files: [{ path: "src/one.ts" }], message: "feat: broken" }],
        new Map([["src/one.ts", { hunks: [], path: "src/one.ts" }]]) as never,
      ),
    ).toThrow("commit failed");
    expect(
      logMessages.some((message) =>
        message.includes("Could not save initial staging state"),
      ),
    ).toBe(true);
    expect(
      logMessages.some((message) =>
        message.includes("Manual recovery required"),
      ),
    ).toBe(true);
  });

  test("git chunking covers across-file, grouped-by-file, and hunk grouping branches", async () => {
    const files = [
      {
        additions: 1,
        deletions: 0,
        hunks: [{ header: "@@ -1 +1 @@", lines: ["+alpha"] }],
        path: "src/one.ts",
      },
      {
        additions: 2,
        deletions: 1,
        hunks: [
          { header: "@@ -1 +1 @@", lines: ["+beta"] },
          { header: "@@ -4 +4 @@", lines: ["-gamma", "+delta"] },
        ],
        path: "src/two.ts",
      },
    ];

    spyOn(applicationConfig, "loadConfig").mockReturnValue({
      analysis: { chunkSize: 6, groupByFile: false, groupByHunk: false },
    } as never);
    const across = await importFresh<typeof import("../src/git/chunks.js")>(
      "../src/git/chunks.js",
      "chunks-across",
    );
    const acrossChunks = across.chunkDiffs(files as never);
    expect(acrossChunks).toHaveLength(2);
    expect(acrossChunks[0]?.files).toEqual(["src/one.ts"]);
    expect(acrossChunks[1]?.id).toBe(1);

    mock.restore();

    spyOn(applicationConfig, "loadConfig").mockReturnValue({
      analysis: { chunkSize: 100, groupByFile: true, groupByHunk: false },
    } as never);
    const byFile = await importFresh<typeof import("../src/git/chunks.js")>(
      "../src/git/chunks.js",
      "chunks-by-file",
    );
    const byFileChunks = byFile.chunkDiffs(files as never);
    expect(byFileChunks).toHaveLength(2);
    expect(byFileChunks[0]?.files).toEqual(["src/one.ts"]);
    expect(byFileChunks[1]?.files).toEqual(["src/two.ts"]);

    mock.restore();

    spyOn(applicationConfig, "loadConfig").mockReturnValue({
      analysis: { chunkSize: 4, groupByFile: true, groupByHunk: true },
    } as never);
    const byHunk = await importFresh<typeof import("../src/git/chunks.js")>(
      "../src/git/chunks.js",
      "chunks-by-hunk",
    );
    const byHunkChunks = byHunk.chunkDiffs(files as never);
    expect(byHunkChunks).toHaveLength(3);
    expect(byHunkChunks[1]?.files).toEqual(["src/two.ts"]);
    expect(byHunkChunks[2]?.content).toContain("@@ -4 +4 @@");
  });
});
