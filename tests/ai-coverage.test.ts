import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULTS, resetConfigCache } from "../src/application/config/index.js";
import {
  OpenAIError,
  OpenAITimeoutError,
  ValidationError,
} from "../src/application/errors.js";
import { resetAiCache } from "../src/commit-planning/result-cache.js";

type DiffChunk = import("../src/git/diff.js").DiffChunk;
type DiffStats = import("../src/git/diff.js").DiffStats;
type FileDiff = import("../src/git/diff.js").FileDiff;
type MockHandler = (
  payload: unknown,
  mockOptions: unknown,
) => Promise<unknown> | unknown;

type PlannedCommit = import("../src/commit-planning/types.js").PlannedCommit;

const { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } =
  await import("bun:test");

type MockResult = Error | MockHandler | unknown;

const originalCwd = process.cwd();
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

let sandboxDir = "";
let xdgConfigHome = "";

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS)) as typeof DEFAULTS;
}

function commitMessage(subject: string, ...bullets: string[]): string {
  const body = bullets.length > 0 ? bullets : ["- Summarize the change."];
  return [subject, "", ...body].join("\n");
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (
      current &&
      value &&
      typeof current === "object" &&
      typeof value === "object" &&
      !Array.isArray(current) &&
      !Array.isArray(value)
    ) {
      merged[key] = deepMerge(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function formatFileDiff(file: FileDiff): string {
  const lines = [`--- ${file.oldPath ?? file.path}`, `+++ ${file.path}`];
  for (const hunk of file.hunks) {
    lines.push(hunk.header, ...hunk.lines);
  }
  return lines.join("\n");
}

async function importFinalizeModule(tag: string) {
  return import(
    new URL(
      `../src/commit-planning/grouping/index.js?${tag}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

async function importFreshAi(tag: string) {
  return import(
    new URL(
      `../src/commit-planning/orchestration.js?${tag}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

async function importFreshAiClient(tag: string) {
  return import(
    new URL(
      `../src/commit-planning/openai-client.js?${tag}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

async function importGroupingFileSignalsModule(tag: string) {
  return import(
    new URL(
      `../src/commit-planning/grouping/file/index.js?${tag}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

async function importGroupingMessageHarmonizationModule(tag: string) {
  return import(
    new URL(
      `../src/commit-planning/grouping/group/message-harmonization.js?${tag}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

async function importRepartitionModule(tag: string) {
  return import(
    new URL(
      `../src/commit-planning/grouping/repartition.js?${tag}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

function installOpenAiMock(options: {
  chatQueue?: MockResult[];
  responseQueue?: MockResult[];
}) {
  const calls = {
    chat: [] as { options: unknown; payload: unknown }[],
    responses: [] as { options: unknown; payload: unknown }[],
  };
  const chatQueue = [...(options.chatQueue ?? [])];
  const responseQueue = [...(options.responseQueue ?? [])];

  const shiftResult = (
    queue: MockResult[],
    label: string,
    payload: unknown,
    mockOptions: unknown,
  ) => {
    if (queue.length === 0) {
      throw new Error(`No mocked ${label} result left`);
    }
    const next = queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (typeof next === "function") {
      return next(payload, mockOptions);
    }
    return next;
  };

  mock.module("openai", () => ({
    default: class FakeOpenAI {
      chat = {
        completions: {
          create: async (payload: unknown, mockOptions: unknown) => {
            calls.chat.push({ options: mockOptions, payload });
            return shiftResult(
              chatQueue,
              "chat completion",
              payload,
              mockOptions,
            );
          },
        },
      };

      responses = {
        create: async (payload: unknown, mockOptions: unknown) => {
          calls.responses.push({ options: mockOptions, payload });
          return shiftResult(
            responseQueue,
            "responses completion",
            payload,
            mockOptions,
          );
        },
      };
    },
  }));

  return calls;
}

function makeChunk(id: number, files: string[], content: string): DiffChunk {
  return { content, files, id, lineCount: content.split("\n").length };
}

function makeFile(path: string, hunks = 1): FileDiff {
  return {
    additions: hunks,
    deletions: 0,
    hunks: Array.from({ length: hunks }, (_, index) => ({
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

function makeGroupingFileMap(paths: string[]): Map<string, FileDiff> {
  return new Map(paths.map((path) => [path, makeFile(path)]));
}

function makeStats(
  filesChanged = 2,
  additions = 3,
  deletions = 1,
  chunks = 2,
): DiffStats {
  return { additions, chunks, deletions, filesChanged };
}

function makeZeroHunkFile(path: string): FileDiff {
  return {
    additions: 0,
    deletions: 0,
    hunks: [],
    metadataLines: ["old mode 100644", "new mode 100755"],
    oldPath: null,
    path,
    status: "modified",
  };
}

function validApiKey(tag: string): string {
  return `sk-${tag}-key-for-testing-1234567890`;
}

function writeLocalConfig(override: Record<string, unknown> = {}) {
  const config = deepMerge(
    cloneDefaults() as unknown as Record<string, unknown>,
    override,
  );
  writeFileSync(
    join(sandboxDir, "gitaicmt.config.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
}

beforeEach(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), "gitaicmt-ai-"));
  xdgConfigHome = mkdtempSync(join(tmpdir(), "gitaicmt-ai-xdg-"));
  process.chdir(sandboxDir);
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  delete process.env.OPENAI_API_KEY;
  resetAiCache();
  resetConfigCache();
  mock.restore();
  setSystemTime();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  resetConfigCache();
  resetAiCache();
  mock.restore();
  setSystemTime();
  if (sandboxDir) {
    rmSync(sandboxDir, { force: true, recursive: true });
  }
  if (xdgConfigHome) {
    rmSync(xdgConfigHome, { force: true, recursive: true });
  }
});

describe("ai coverage", () => {
  test("complete tracks token usage from chat completions", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("usage-chat"), model: "gpt-5.3-codex" },
    });
    installOpenAiMock({
      chatQueue: [
        {
          choices: [
            { message: { content: commitMessage("feat(core): track usage") } },
          ],
          usage: {
            completion_tokens: 7,
            prompt_tokens: 13,
            total_tokens: 20,
          },
        },
      ],
    });

    const aiClient = await importFreshAiClient("usage-chat");
    aiClient.resetTokenUsageSummary();

    await aiClient.complete("system", "user");

    expect(aiClient.getTokenUsageSummary()).toEqual({
      inputTokens: 13,
      outputTokens: 7,
      requestCount: 1,
      totalTokens: 20,
    });
  });

  test("complete tracks token usage from responses fallback", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("usage-responses"), model: "gpt-5" },
    });
    installOpenAiMock({
      chatQueue: [new Error("This is not a chat model")],
      responseQueue: [
        {
          output_text: commitMessage("feat(core): responses usage"),
          usage: {
            input_tokens: 21,
            output_tokens: 9,
            total_tokens: 30,
          },
        },
      ],
    });

    const aiClient = await importFreshAiClient("usage-responses");
    aiClient.resetTokenUsageSummary();

    await aiClient.complete("system", "user");

    expect(aiClient.getTokenUsageSummary()).toEqual({
      inputTokens: 21,
      outputTokens: 9,
      requestCount: 1,
      totalTokens: 30,
    });
  });

  test("complete tracks token usage by stage", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("usage-stage"), model: "gpt-5.3-codex" },
    });
    installOpenAiMock({
      chatQueue: [
        {
          choices: [
            { message: { content: commitMessage("feat(core): stage usage") } },
          ],
          usage: {
            completion_tokens: 5,
            prompt_tokens: 11,
            total_tokens: 16,
          },
        },
      ],
    });

    const aiClient = await importFreshAiClient("usage-stage");
    aiClient.resetTokenUsageSummary();

    await aiClient.complete("system", "user", { stage: "group" });

    expect(aiClient.getTokenUsageByStage().group).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      requestCount: 1,
      totalTokens: 16,
    });
    expect(aiClient.getTokenUsageByStage().generate).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      totalTokens: 0,
    });
  });

  test("complete emits successful AI output to the observer with its stage", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("observer-stage"), model: "gpt-5.3-codex" },
    });
    installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: commitMessage("feat(core): surface stage output"),
              },
            },
          ],
        },
      ],
    });

    const aiClient = await importFreshAiClient("observer-stage");
    const events: {
      content: string;
      durationMs?: number;
      kind?: string;
      requestCountDelta?: number;
      stage: string;
      transport?: string;
    }[] = [];
    aiClient.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    await aiClient.complete("system", "user", { stage: "group" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      content: commitMessage("feat(core): surface stage output"),
      kind: "model-output",
      requestCountDelta: 1,
      stage: "group",
      transport: "chat",
    });
    expect(events[0]?.durationMs).toBeTypeOf("number");
  });

  test("complete ignores observer failures and still returns content", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("observer-failure"),
        model: "gpt-5.3-codex",
      },
    });
    installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: commitMessage("feat(core): keep observer optional"),
              },
            },
          ],
        },
      ],
    });

    const aiClient = await importFreshAiClient("observer-failure");
    aiClient.setAiOutputObserver(() => {
      throw new Error("observer failure");
    });

    await expect(aiClient.complete("system", "user")).resolves.toBe(
      commitMessage("feat(core): keep observer optional"),
    );
  });

  test("generateForChunk reuses cached responses across time changes", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("cache"), model: "gpt-5.3-codex" },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: { content: commitMessage("feat(core): add cache") },
            },
          ],
        },
        {
          choices: [
            {
              message: { content: commitMessage("feat(core): refresh cache") },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("cache");
    const chunk = makeChunk(1, ["src/cache.ts"], "+cache hit");

    setSystemTime(0);
    expect(await ai.generateForChunk(chunk)).toBe(
      commitMessage("feat(core): add cache"),
    );
    expect(await ai.generateForChunk(chunk)).toBe(
      commitMessage("feat(core): add cache"),
    );

    setSystemTime(2_000);
    expect(await ai.generateForChunk(chunk)).toBe(
      commitMessage("feat(core): add cache"),
    );
    expect(calls.chat).toHaveLength(1);
  });

  test("generateForChunks uses sequential chunk processing when parallel is disabled", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("sequential"), model: "gpt-5.3-codex" },
      performance: { parallel: false },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            { message: { content: commitMessage("feat(core): part one") } },
          ],
        },
        {
          choices: [
            { message: { content: commitMessage("feat(core): part two") } },
          ],
        },
        {
          choices: [
            { message: { content: commitMessage("feat(core): merged") } },
          ],
        },
      ],
    });
    const ai = await importFreshAi("sequential");

    const result = await ai.generateForChunks(
      [makeChunk(1, ["src/a.ts"], "+a"), makeChunk(2, ["src/b.ts"], "+b")],
      makeStats(),
    );

    expect(result).toBe(commitMessage("feat(core): merged"));
    expect(calls.chat).toHaveLength(3);
  });

  test("generateForChunk falls back to responses API for non-chat models and omits temperature", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("responses"), model: "gpt-5" },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        new Error("Model is not supported in the v1/chat/completions API"),
      ],
      responseQueue: [
        { output_text: commitMessage("fix(ai): use responses fallback") },
      ],
    });
    const ai = await importFreshAi("responses-fallback");

    const result = await ai.generateForChunk(
      makeChunk(1, ["src/commit-planning/orchestration.ts"], "+fallback"),
    );

    expect(result).toBe(commitMessage("fix(ai): use responses fallback"));
    expect(calls.chat.length).toBeLessThanOrEqual(1);
    expect(calls.responses).toHaveLength(1);
    const chatPayload = calls.chat[0]?.payload as Record<string, unknown>;
    const responsesPayload = calls.responses[0]?.payload as Record<
      string,
      unknown
    >;
    expect("temperature" in chatPayload).toBe(false);
    expect("temperature" in responsesPayload).toBe(false);
  });

  test("generateForChunk maps abort errors to OpenAITimeoutError", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("timeout"), model: "gpt-5.3-codex" },
      performance: { timeoutMs: 25 },
    });
    const abortError = new Error("operation timeout");
    abortError.name = "AbortError";
    installOpenAiMock({ chatQueue: [abortError] });
    const ai = await importFreshAi("timeout");

    await expect(
      ai.generateForChunk(
        makeChunk(1, ["src/commit-planning/orchestration.ts"], "+timeout"),
      ),
    ).rejects.toBeInstanceOf(OpenAITimeoutError);
  });

  test("generateForChunk rejects empty chat responses", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("empty-chat"), model: "gpt-5.3-codex" },
    });
    installOpenAiMock({
      chatQueue: [{ choices: [{ message: { content: "   " } }] }],
    });
    const ai = await importFreshAi("empty-chat");

    await expect(
      ai.generateForChunk(
        makeChunk(1, ["src/commit-planning/orchestration.ts"], "+empty"),
      ),
    ).rejects.toBeInstanceOf(OpenAIError);
  });

  test("generateForChunk rejects subject-only commit messages", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("subject-only"), model: "gpt-5.3-codex" },
    });
    installOpenAiMock({
      chatQueue: [
        { choices: [{ message: { content: "feat(ai): missing body" } }] },
      ],
    });
    const ai = await importFreshAi("subject-only");

    await expect(
      ai.generateForChunk(
        makeChunk(
          1,
          ["src/commit-planning/orchestration.ts"],
          "+body required",
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("client validation rejects missing API keys", async () => {
    writeLocalConfig();
    const ai = await importFreshAi("missing-key");

    await expect(
      ai.generateForChunk(
        makeChunk(1, ["src/commit-planning/orchestration.ts"], "+missing-key"),
      ),
    ).rejects.toThrow("No OpenAI API key");
  });

  test("client validation rejects invalid API key formats", async () => {
    writeLocalConfig({
      openai: { apiKey: "invalid-key", model: "gpt-5.3-codex" },
    });
    const ai = await importFreshAi("bad-key");

    await expect(
      ai.generateForChunk(
        makeChunk(1, ["src/commit-planning/orchestration.ts"], "+bad-key"),
      ),
    ).rejects.toThrow("Invalid OpenAI API key format");
  });

  test("client validation rejects invalid model names", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("bad-model"), model: "bad model" },
    });
    const ai = await importFreshAi("bad-model");

    await expect(
      ai.generateForChunk(
        makeChunk(1, ["src/commit-planning/orchestration.ts"], "+bad-model"),
      ),
    ).rejects.toThrow("Invalid characters in OpenAI model name");
  });

  test("buildGroupingSystemPrompt keeps body requirement even when config disables it", async () => {
    writeLocalConfig({
      commit: {
        conventional: false,
        includeBody: false,
        includeScope: false,
      },
      openai: { apiKey: validApiKey("prompt-config"), model: "gpt-5.3-codex" },
    });
    const ai = await importFreshAi("prompt-config");

    const prompt = ai.buildGroupingSystemPrompt();

    expect(prompt).not.toContain("Use the Conventional Commits format");
    expect(prompt).toContain("body using bullet points");
    expect(prompt).toContain("A subject-only commit message is invalid.");
    expect(prompt).not.toContain("Produce only the subject line, no body.");
    expect(prompt).not.toContain("Include a scope in parentheses");
  });

  test("buildGroupingSystemPrompt asks for professional handwritten-style commits", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("prompt-tone"), model: "gpt-5.3-codex" },
    });
    const ai = await importFreshAi("prompt-tone");

    const prompt = ai.buildGroupingSystemPrompt();

    expect(prompt).toContain("thoughtful senior engineer");
    expect(prompt).toContain("Prefer 2-4 bullets");
    expect(prompt).toContain("avoid filler, hype, and repetition");
    expect(prompt).toContain(
      "Center the message on why the change is being made",
    );
    expect(prompt).toContain(
      "Lead with the reason, outcome, or defended behavior",
    );
    expect(prompt).toContain(
      "Heavily infer from the content to surface the intent",
    );
    expect(prompt).toContain(
      "Use the body to justify the subject with impact, constraints, guarantees, or verification details",
    );
    expect(prompt).toContain(
      "Infer the actual subsystem, workflow, or product surface",
    );
    expect(prompt).toContain(
      "the subject should name the umbrella outcome or area",
    );
    expect(prompt).toContain(
      "When one concrete guardrail, heuristic, validation, retry path, cache behavior, or signaling rule dominates the diff, name that dominant mechanism directly in the subject",
    );
    expect(prompt).toContain(
      "When the diff mostly changes prompt, instruction, or guidance text, name the concrete rule introduced, banned, or clarified in the subject",
    );
    expect(prompt).toContain(
      "Treat source files that define prompts, heuristics, validators, planner logic, or other runtime behavior as code, not documentation",
    );
    expect(prompt).toContain(
      "avoid meta verbs if the concrete rule being changed can be named directly",
    );
    expect(prompt).toContain(
      "Choose the commit type from the externally observable reason",
    );
    expect(prompt).toContain(
      "Use fix for any change that corrects wrong behavior",
    );
    expect(prompt).toContain(
      "Use feat only when the commit primarily adds a new user-facing capability",
    );
    expect(prompt).toContain("Use refactor only when runtime behavior");
    expect(prompt).toContain("When in doubt between fix and refactor");
    expect(prompt).toContain(
      "Avoid generic umbrella nouns like flow, pipeline, logic, handling, support, or behavior",
    );
    expect(prompt).toContain(
      "Avoid comma-separated or and-linked subject lists",
    );
    expect(prompt).toContain("Badly generic subjects like feat: update tests");
  });

  test("buildGroupingSystemPrompt keeps cohesive tooling rollouts together", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("tooling-prompt"), model: "gpt-5.3-codex" },
    });
    const ai = await importFreshAi("tooling-prompt");

    const prompt = ai.buildGroupingSystemPrompt();

    expect(prompt).toContain(
      "Keep source, tests, docs, config, package changes, and helper scripts together",
    );
    expect(prompt).toContain("EXAMPLE 4");
    expect(prompt).toContain("scripts/check.ts");
  });

  test("buildGroupingSystemPrompt keeps incidental cleanup with the owning feature", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("cleanup-prompt"), model: "gpt-5.3-codex" },
    });
    const ai = await importFreshAi("cleanup-prompt");

    const prompt = ai.buildGroupingSystemPrompt();

    expect(prompt).toContain(
      "do NOT split out incidental formatting, import-order, rename-only, wiring, docs, test, or config hunks",
    );
    expect(prompt).toContain(
      "Standalone style/import-order/formatting commits should be RARE",
    );
    expect(prompt).toContain("RULE 3");
  });

  test("buildMergePrompt keeps the combined message centered on intent", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("merge-tone"), model: "gpt-5.3-codex" },
    });
    await importFreshAi("merge-tone");
    const { buildMergePrompt } =
      await import("../src/commit-planning/prompts/index.js");

    const prompt = buildMergePrompt(
      [
        commitMessage(
          "fix(auth): enforce legal consent version",
          "- Reject signup payloads that omit acceptedLegalVersion.",
        ),
        commitMessage(
          "test(auth): cover legal consent validation",
          "- Add signup assertions for missing legal version.",
        ),
      ],
      makeStats(2, 8, 1, 2),
    );

    expect(prompt).toContain(
      "Preserve or reconstruct the strongest why-oriented rationale",
    );
    expect(prompt).toContain(
      "infer it from the concrete behavior, safeguard, workflow, or product outcome",
    );
    expect(prompt).toContain(
      "Prefer a subject that names the motivation or outcome the commit delivers",
    );
    expect(prompt).toContain(
      "name that mechanism directly instead of broad umbrella nouns like flow or pipeline",
    );
    expect(prompt).toContain(
      "When the partials mostly change prompt or instruction wording, name the concrete guidance being added or clarified instead of meta wording.",
    );
    expect(prompt).toContain(
      "Treat source modules that define prompts, heuristics, validators, planner logic, or other runtime behavior as code changes, not docs changes",
    );
    expect(prompt).toContain(
      "avoid meta verbs if the specific rule can be named directly",
    );
    expect(prompt).toContain(
      "preserve that corrective framing and prefer fix over feat",
    );
    expect(prompt).toContain("Conventional Commit type-selection rules");
    expect(prompt).toContain("Use refactor only when runtime behavior");
    expect(prompt).toContain("When in doubt between fix and refactor");
  });

  test("buildMergePrompt reinforces breaking sensitivity footer quality", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("merge-breaking"), model: "gpt-5.3-codex" },
    });
    await importFreshAi("merge-breaking");
    const { buildMergePrompt } =
      await import("../src/commit-planning/prompts/index.js");

    const prompt = buildMergePrompt(
      [
        commitMessage(
          "feat(cli)!: require breaking metadata",
          "- Thread --breaking through generation.",
          "",
          "BREAKING CHANGE: Generated breaking commits must include migration footers before release.",
        ),
      ],
      makeStats(1, 4, 1, 1),
      { breakingMode: "sensitive" },
    );

    expect(prompt).toContain("Breaking sensitivity mode is enabled");
    expect(prompt).toContain("explicitly passed --breaking");
    expect(prompt).toContain("supported public contract");
    expect(prompt).toContain("old behavior was documented");
    expect(prompt).toContain(
      "Do not mark the merged commit breaking merely because the run raises breaking sensitivity",
    );
    expect(prompt).toContain("2-4 sentence migration paragraph");
    expect(prompt).toContain("downstream obligation across all partials");
  });

  test("buildGroupingSystemPrompt includes breaking sensitivity mode rules", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("group-breaking"), model: "gpt-5.3-codex" },
    });
    const ai = await importFreshAi("group-breaking");

    const prompt = ai.buildGroupingSystemPrompt({ breakingMode: "sensitive" });

    expect(prompt).toContain("BREAKING SENSITIVITY MODE");
    expect(prompt).toContain("documented or reasonably relied-on CLI flag");
    expect(prompt).toContain("inspect public contracts more aggressively");
    expect(prompt).toContain("release-note-quality migration paragraph");
    expect(prompt).toContain("actual consumer migration obligation");
    expect(prompt).toContain("forced-major mode");
  });

  test("buildConsolidationPrompts preserve breaking sensitivity footers", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("consolidate-breaking"),
        model: "gpt-5.3-codex",
      },
    });
    await importFreshAi("consolidate-breaking");
    const { buildConsolidationSystemPrompt, buildConsolidationUserPrompt } =
      await import("../src/commit-planning/prompts/index.js");

    const defaultSystemPrompt = buildConsolidationSystemPrompt();
    const defaultUserPrompt = buildConsolidationUserPrompt(
      [makeFile("src/cli/execution-flow.ts")],
      [
        {
          files: [{ path: "src/cli/execution-flow.ts" }],
          message: commitMessage(
            "feat(cli): allow breaking mode",
            "- Thread allowed mode through planning.",
          ),
        },
      ],
    );

    expect(defaultSystemPrompt).toContain(
      "Conventional Commit type-selection rules",
    );
    expect(defaultSystemPrompt).toContain(
      "Use refactor only when runtime behavior",
    );
    expect(defaultSystemPrompt).toContain("stop forcing output");
    expect(defaultSystemPrompt).toContain("BREAKING CHANGE");
    expect(defaultSystemPrompt).toContain(
      "release-note-quality migration paragraph",
    );
    expect(defaultSystemPrompt).toContain(
      "NEVER return a ! subject with no footer",
    );
    expect(defaultSystemPrompt).not.toContain("BREAKING SENSITIVITY MODE");
    expect(defaultSystemPrompt).not.toContain("--breaking");
    expect(defaultUserPrompt).toContain("BREAKING CHANGE");
    expect(defaultUserPrompt).toContain(
      "Breaking-change consolidation guidance",
    );
    expect(defaultUserPrompt).not.toContain(
      "Breaking sensitivity consolidation",
    );
    expect(defaultUserPrompt).not.toContain("--breaking");

    const options = { breakingMode: "sensitive" as const };
    const systemPrompt = buildConsolidationSystemPrompt(options);
    const userPrompt = buildConsolidationUserPrompt(
      [makeFile("src/cli/execution-flow.ts")],
      [
        {
          files: [{ path: "src/cli/execution-flow.ts" }],
          message: commitMessage(
            "feat(cli)!: add breaking mode",
            "- Thread --breaking through planning.",
          ),
        },
      ],
      options,
    );

    expect(systemPrompt).toContain("BREAKING SENSITIVITY MODE is enabled");
    expect(systemPrompt).toContain(
      "preserve real breaking metadata, but do not introduce new ! markers unless the merged selected files change a supported public compatibility contract",
    );
    expect(systemPrompt).toContain("requires downstream migration");
    expect(systemPrompt).toContain("include a BREAKING CHANGE: footer");
    expect(systemPrompt).toContain("NEVER return a ! subject with no footer");
    expect(userPrompt).toContain(
      "Breaking sensitivity consolidation is enabled",
    );
    expect(userPrompt).toContain("prompt-only");
    expect(userPrompt).toContain("Do not rely on downstream post-processing");
  });

  test("buildPrompts suppress breaking language in no-breaking mode", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("no-breaking-prompts"),
        model: "gpt-5.3-codex",
      },
    });
    await importFreshAi("no-breaking-prompts");
    const {
      buildConsolidationSystemPrompt,
      buildConsolidationUserPrompt,
      buildGroupingSystemPrompt,
      buildGroupingUserPrompt,
      buildMergePrompt,
    } = await import("../src/commit-planning/prompts/index.js");
    const options = { breakingMode: "disabled" as const };

    const prompts = [
      buildGroupingSystemPrompt(options),
      buildGroupingUserPrompt(
        [makeFile("src/api.ts")],
        (file) => file.path,
        options,
      ),
      buildMergePrompt(
        [
          commitMessage(
            "feat(api): update public config",
            "- Change config handling.",
          ),
        ],
        makeStats(1, 4, 1, 1),
        options,
      ),
      buildConsolidationSystemPrompt(options),
      buildConsolidationUserPrompt(
        [makeFile("src/api.ts")],
        [
          {
            files: [{ path: "src/api.ts" }],
            message: commitMessage(
              "feat(api): update public config",
              "- Change config handling.",
            ),
          },
        ],
        options,
      ),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain("Release-impact metadata is disabled");
      expect(prompt).not.toContain("BREAKING SENSITIVITY MODE");
      expect(prompt).not.toContain("BREAKING CHANGE:");
      expect(prompt).not.toContain("append ! after the type/scope prefix");
      expect(prompt).not.toContain("major-version");
      expect(prompt).not.toContain("migration");
    }
  });

  test("planCommits skips grouping for a single file with one hunk", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("single-file"), model: "gpt-5.3-codex" },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            { message: { content: commitMessage("feat(app): update app") } },
          ],
        },
      ],
    });
    const ai = await importFreshAi("single-file");
    const file = makeFile("src/app.ts");

    const result = await ai.planCommits([file], formatFileDiff);

    expect(result).toEqual([
      {
        files: [{ path: "src/app.ts" }],
        message: commitMessage("feat(app): update app"),
      },
    ]);
    expect(calls.chat).toHaveLength(1);
  });

  test("planCommits reuses cached plans for identical inputs", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("plan-cache"), model: "gpt-5.3-codex" },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
                    message: commitMessage("feat(core): cache grouped plan"),
                  },
                ]),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      {
                        hunks: [0, 1],
                        path: "src/commit-planning/orchestration.ts",
                      },
                      {
                        hunks: [3],
                        path: "src/commit-planning/orchestration.ts",
                      },
                      { path: "src/cli/main.ts" },
                    ],
                    message:
                      "feat(ai): consolidate duplicate file entries\n\n- Keep one file entry per path after consolidation.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("plan-cache");
    const files = [makeFile("src/a.ts"), makeFile("src/b.ts")];

    const first = await ai.planCommits(files, formatFileDiff);
    const second = await ai.planCommits(files, formatFileDiff);

    expect(first).toEqual(second);
    expect(calls.chat.length).toBeGreaterThanOrEqual(1);
    expect(calls.chat.length).toBeLessThanOrEqual(2);
  });

  test("finalizePlannedGroups skips follow-up AI passes for clearly independent commits", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("postprocess-gate"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?postprocess-gate-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/auth.ts" }],
        message: commitMessage("feat(auth): add login endpoint"),
      },
      {
        files: [{ path: "src/legal.ts" }],
        message: commitMessage("fix(legal): rename notice copy"),
      },
    ];
    const allFiles = [makeFile("src/auth.ts"), makeFile("src/legal.ts")];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(result).toEqual(groups);
    expect(calls.chat).toHaveLength(0);
  });

  test("finalizePlannedGroups skips follow-up AI passes for support commits that only share broad folders", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("support-folder-gate"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?support-folder-gate-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/commit-planning/grouping/subject-analysis.ts" }],
        message: commitMessage(
          "fix(planned-commit-grouping): narrow support merge gating",
          "- Ignore broad shared folders that do not indicate the same commit intent.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/prompts/rules/commit/message.ts",
          },
          { path: "tests/ai-coverage.test.ts" },
        ],
        message: commitMessage(
          "docs(prompts): clarify runtime prompt typing",
          "- Explain that prompt-builder source changes are runtime behavior, not docs-only updates.",
        ),
      },
      {
        files: [{ path: "src/commit-planning/token-estimation.ts" }],
        message: commitMessage(
          "fix(token-estimation): buffer consolidation budgets",
          "- Reduce low estimates during planner follow-up calls.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/grouping/subject-analysis.ts"),
      makeFile("src/commit-planning/prompts/rules/commit/message.ts"),
      makeFile("tests/ai-coverage.test.ts"),
      makeFile("src/commit-planning/token-estimation.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(0);
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toEqual([
      "fix(planned-commit-grouping): narrow support merge gating",
      "fix(token-estimation): buffer consolidation budgets",
      "docs(prompts): clarify runtime prompt typing",
    ]);
  });

  test("finalizePlannedGroups keeps the implementation-led subject when merging support coverage", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("support-subject-merge"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/commit-planning/result-cache.ts" },
                      { path: "tests/ai-coverage.test.ts" },
                    ],
                    message:
                      "test(ai): cover plan cache reuse\n\n- Verify cache hits and stage reporting.",
                  },
                ]),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: ".gitleaks.toml" },
                      { path: ".secretlintrc" },
                      { hunks: [0], path: ".gitignore" },
                      { hunks: [0], path: ".jscpd.json" },
                      { path: "bun.lock" },
                      { hunks: [0], path: "eslint.config.js" },
                      { hunks: [0, 1], path: "package.json" },
                      { hunks: [0], path: "scripts/check.json" },
                      { path: "scripts/check.ts" },
                      { path: "tests/ai-coverage.test.ts" },
                      { path: "tests/git-coverage.test.ts" },
                      { path: "tests/tsconfig.json" },
                      { path: "knip.json" },
                      { path: ".husky/pre-commit" },
                    ],
                    message: commitMessage(
                      "chore(tooling): add quality and validation workflow",
                    ),
                  },
                  {
                    files: [{ path: "logo.svg" }],
                    message: commitMessage(
                      "style(branding): refresh logo artwork",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?support-subject-merge-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message:
          "test(ai): cover plan cache reuse\n\n- Verify cache hits and stage reporting.",
      },
      {
        files: [{ path: "src/commit-planning/result-cache.ts" }],
        message:
          "feat(ai-cache): cache planned commit analysis\n\n- Reuse grouped plans for identical diff inputs.",
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/result-cache.ts"),
      makeFile("tests/ai-coverage.test.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain(
      "feat(ai-cache): cache planned commit analysis",
    );
    expect(result[0]?.message).toContain(
      "- Verify cache hits and stage reporting.",
    );
  });

  test("finalizePlannedGroups keeps a feature entrypoint follow-up with its nested rollout", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("feature-entrypoint-follow-up"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      {
                        path: "src/application/config/service.ts",
                      },
                      { path: "src/application/index.ts" },
                    ],
                    message: commitMessage(
                      "feat(config): add layered config loading and public exports",
                      "- Keep the feature entrypoint wiring with the nested config rollout.",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?feature-entrypoint-follow-up-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          {
            path: "src/application/config/service.ts",
          },
        ],
        message: commitMessage(
          "feat(config): add layered config loading and cached initialization",
          "- Load and validate layered config sources through the config service.",
        ),
      },
      {
        files: [{ path: "src/application/index.ts" }],
        message: commitMessage(
          "feat(application): expose layered config loading through the public entrypoint",
          "- Re-export the config service from the application surface.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/application/config/service.ts"),
      makeFile("src/application/index.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(0);
    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { path: "src/application/config/service.ts" },
      { path: "src/application/index.ts" },
    ]);
  });

  test("finalizePlannedGroups keeps a tiny public-entrypoint follow-up with its nested rollout on thin subject overlap", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("thin-entrypoint-follow-up"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?thin-entrypoint-follow-up-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/application/config/service.ts" }],
        message: commitMessage(
          "refactor(application-config): split config and command exports into library modules",
          "- Add a dedicated config service that owns layered loading and cache management.",
        ),
      },
      {
        files: [{ path: "src/application/index.ts" }],
        message: commitMessage(
          "refactor(application): update public exports",
          "- Keep the public entrypoint aligned with the narrowed config surface.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        makeFile("src/application/config/service.ts"),
        makeFile("src/application/index.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { path: "src/application/config/service.ts" },
      { path: "src/application/index.ts" },
    ]);
  });

  test("finalizePlannedGroups keeps same-feature surface rollouts together across sibling module surfaces", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("feature-surface-rollout"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?feature-surface-rollout-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/cli/main.ts" }],
        message: commitMessage(
          "refactor(cli): split runtime entrypoint from reusable command modules",
          "- Introduce a focused CLI entrypoint for command dispatch.",
        ),
      },
      {
        files: [{ path: "src/cli/options.ts" }],
        message: commitMessage(
          "refactor(cli): split runtime entrypoint from reusable command modules",
          "- Move option parsing into a dedicated CLI surface module.",
        ),
      },
      {
        files: [{ path: "src/cli/fatal.ts" }],
        message: commitMessage(
          "refactor(cli): split runtime entrypoint from reusable command modules",
          "- Keep fatal reporting on the reusable CLI surface.",
        ),
      },
      {
        files: [{ path: "src/cli/terminal/index.ts" }],
        message: commitMessage(
          "refactor(cli): split runtime entrypoint from reusable command modules",
          "- Replace wildcard terminal exports with a focused surface.",
        ),
      },
      {
        files: [{ path: "src/cli/token/index.ts" }],
        message: commitMessage(
          "refactor(cli): split runtime entrypoint from reusable command modules",
          "- Replace wildcard token exports with a focused surface.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/cli/main.ts"),
      makeFile("src/cli/options.ts"),
      makeFile("src/cli/fatal.ts"),
      makeFile("src/cli/terminal/index.ts"),
      makeFile("src/cli/token/index.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(0);
    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual(
      allFiles.map((file) => ({ path: file.path })),
    );
    expect(result[0]?.message).toContain(
      "refactor(cli): split runtime entrypoint from reusable command modules",
    );
  });

  test("finalizePlannedGroups keeps broad shallow CLI display surfaces together across sibling surface owners", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("cli-display-surface-rollout"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?cli-display-surface-rollout-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/cli/output-presentation.ts" }],
        message: commitMessage(
          "refactor(cli): tighten exports and formatting in display helpers",
          "- Keep display output helpers on the explicit CLI surface.",
        ),
      },
      {
        files: [{ path: "src/cli/planner-notices.ts" }],
        message: commitMessage(
          "refactor(cli): tighten exports and formatting in display helpers",
          "- Keep planner notices on the explicit CLI display surface.",
        ),
      },
      {
        files: [{ path: "src/cli/session-display.ts" }],
        message: commitMessage(
          "refactor(cli): tighten exports and formatting in display helpers",
          "- Keep session display helpers on the explicit CLI surface.",
        ),
      },
      {
        files: [{ path: "src/cli/staging-guard.ts" }],
        message: commitMessage(
          "refactor(cli): tighten exports and formatting in display helpers",
          "- Keep staging guard helpers on the explicit CLI surface.",
        ),
      },
      {
        files: [{ path: "src/cli/verbose-output.ts" }],
        message: commitMessage(
          "refactor(cli): tighten exports and formatting in display helpers",
          "- Keep verbose output helpers on the explicit CLI surface.",
        ),
      },
      {
        files: [{ path: "src/cli/viewport.ts" }],
        message: commitMessage(
          "refactor(cli): tighten exports and formatting in display helpers",
          "- Keep viewport helpers on the explicit CLI surface.",
        ),
      },
      {
        files: [{ path: "src/cli/terminal/index.ts" }],
        message: commitMessage(
          "refactor(cli): tighten exports and formatting in display helpers",
          "- Replace wildcard terminal exports with an explicit display surface.",
        ),
      },
      {
        files: [{ path: "src/cli/token/index.ts" }],
        message: commitMessage(
          "refactor(cli): tighten exports and formatting in display helpers",
          "- Replace wildcard token exports with an explicit display surface.",
        ),
      },
      {
        files: [{ path: "src/cli/verbose-rendering/index.ts" }],
        message: commitMessage(
          "refactor(cli): tighten exports and formatting in display helpers",
          "- Replace wildcard verbose-rendering exports with an explicit display surface.",
        ),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(0);
    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual(
      allFiles.map((file) => ({ path: file.path })),
    );
    expect(result[0]?.message).toContain(
      "refactor(cli): tighten exports and formatting in display helpers",
    );
  });

  test("finalizePlannedGroups keeps config-service extraction aligned with application entrypoint export narrowing", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("config-service-entrypoint-rollout"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?config-service-entrypoint-rollout-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/application/config/service.ts" },
          { path: "src/application/config/index.ts" },
        ],
        message: commitMessage(
          "refactor(config): narrow config-service exports behind explicit module surfaces",
          "- Keep config loading and public config module exports in one rollout.",
        ),
      },
      {
        files: [{ path: "src/application/index.ts" }],
        message: commitMessage(
          "refactor(application): narrow top-level exports for config-service rollout",
          "- Keep the application entrypoint aligned with the narrowed config exports.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        makeFile("src/application/config/service.ts"),
        makeFile("src/application/config/index.ts"),
        makeFile("src/application/index.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { path: "src/application/config/service.ts" },
      { path: "src/application/config/index.ts" },
      { path: "src/application/index.ts" },
    ]);
  });

  test("finalizePlannedGroups keeps live config export entrypoint rollout together across cli and application surfaces", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("live-config-entrypoint-rollout"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/cli/command-line-interface.ts" },
                      { path: "src/cli/counts.ts" },
                      { path: "src/application/config/service.ts" },
                      { path: "src/application/cache-paths.ts" },
                      { path: "src/application/config/index.ts" },
                      { path: "src/application/config/schema.ts" },
                      { path: "src/application/index.ts" },
                    ],
                    message: commitMessage(
                      "refactor(entrypoints): keep config and public export rollout together",
                      "- Keep the CLI entrypoint split, config service extraction, cache-path updates, and narrowed application exports on one rollout.",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?live-config-entrypoint-rollout-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/cli/command-line-interface.ts" },
          { path: "src/cli/counts.ts" },
        ],
        message: commitMessage(
          "refactor(cli): split config and public exports from entrypoint",
          "- Keep CLI entrypoint wiring aligned with the new config export surface.",
        ),
      },
      {
        files: [{ path: "src/application/config/service.ts" }],
        message: commitMessage(
          "refactor(application-config): split config and public exports from entrypoint",
          "- Add the dedicated config service behind the narrowed export surface.",
        ),
      },
      {
        files: [
          { path: "src/application/cache-paths.ts" },
          { path: "src/application/config/index.ts" },
          { path: "src/application/config/schema.ts" },
        ],
        message: commitMessage(
          "refactor(config): split config exports and align cache settings",
          "- Keep config re-exports, schema updates, and cache-path support together.",
        ),
      },
      {
        files: [{ path: "src/application/index.ts" }],
        message: commitMessage(
          "refactor(application): update public exports",
          "- Keep the application entrypoint aligned with the narrowed config exports.",
        ),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat.length).toBeGreaterThan(0);
    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual(
      allFiles.map((file) => ({ path: file.path })),
    );
  });

  test("finalizePlannedGroups keeps CLI export tightening together across terminal token verbose-rendering and adjacent entrypoints", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("cli-export-tightening-rollout"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?cli-export-tightening-rollout-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/cli/index.ts" }, { path: "src/cli/main.ts" }],
        message: commitMessage(
          "refactor(cli): tighten explicit export surfaces for terminal and rendering modules",
          "- Keep root CLI entrypoint exports aligned with the explicit module surfaces.",
        ),
      },
      {
        files: [{ path: "src/cli/terminal/index.ts" }],
        message: commitMessage(
          "refactor(cli): tighten explicit export surfaces for terminal and rendering modules",
          "- Replace wildcard terminal exports with explicit symbols.",
        ),
      },
      {
        files: [{ path: "src/cli/token/index.ts" }],
        message: commitMessage(
          "refactor(cli): tighten explicit export surfaces for terminal and rendering modules",
          "- Replace wildcard token exports with explicit symbols.",
        ),
      },
      {
        files: [{ path: "src/cli/verbose-rendering/index.ts" }],
        message: commitMessage(
          "refactor(cli): tighten explicit export surfaces for terminal and rendering modules",
          "- Replace wildcard verbose-rendering exports with explicit symbols.",
        ),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(0);
    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual(
      allFiles.map((file) => ({ path: file.path })),
    );
  });

  test("harmonizeConsolidatedMessages restores breaking metadata dropped during consolidation", async () => {
    const { harmonizeConsolidatedMessages } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?breaking-consolidation-restore-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ hunks: [0], path: "src/step/args.ts" }],
        message: [
          "feat(step)!: add kind-based step entry contracts",
          "",
          "- Expand StepEntry and KindsConfigEntry shapes for declarative configs.",
          "",
          "BREAKING CHANGE: External config normalizers that narrow CheckConfigEntry must handle StepEntry and KindsConfigEntry variants before upgrading.",
        ].join("\n"),
      },
      {
        files: [{ hunks: [1], path: "src/step/args.ts" }],
        message: commitMessage(
          "feat(step): add kind-based step entry exports",
          "- Expose kind-entry helper contracts from the public step entrypoint.",
        ),
      },
    ];
    const allFiles = [makeFile("src/step/args.ts", 2)];
    const fileByPath = new Map(allFiles.map((file) => [file.path, file]));
    const consolidated = [
      {
        files: [{ hunks: [0, 1], path: "src/step/args.ts" }],
        message: commitMessage(
          "feat(step): add declarative step factories",
          "- Add kind-based step authoring helpers and exports.",
          "- Keep related command argument support in the same rollout.",
        ),
      },
    ];

    const result = harmonizeConsolidatedMessages(
      groups,
      consolidated,
      fileByPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain(
      "feat(step)!: add declarative step factories",
    );
    expect(result[0]?.message).toContain(
      "BREAKING CHANGE: External config normalizers that narrow CheckConfigEntry must handle StepEntry and KindsConfigEntry variants before upgrading.",
    );
  });

  test("harmonizeConsolidatedMessages suppresses breaking metadata in no-breaking mode", async () => {
    const { harmonizeConsolidatedMessages } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?breaking-consolidation-suppress-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ hunks: [0], path: "src/step/args.ts" }],
        message: [
          "feat(step)!: add kind-based step entry contracts",
          "",
          "- Expand StepEntry and KindsConfigEntry shapes for declarative configs.",
          "",
          "BREAKING CHANGE: External config normalizers must handle the new StepEntry variants before upgrading.",
        ].join("\n"),
      },
    ];
    const allFiles = [makeFile("src/step/args.ts", 1)];
    const fileByPath = new Map(allFiles.map((file) => [file.path, file]));
    const consolidated = [
      {
        files: [{ hunks: [0], path: "src/step/args.ts" }],
        message: [
          "feat(step)!: add declarative step factories",
          "",
          "- Add kind-based step authoring helpers and exports.",
          "",
          "BREAKING CHANGE: Existing config normalizers must migrate.",
        ].join("\n"),
      },
    ];

    const result = harmonizeConsolidatedMessages(
      groups,
      consolidated,
      fileByPath,
      { breakingMode: "disabled" },
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain(
      "feat(step): add declarative step factories",
    );
    expect(result[0]?.message).not.toContain("feat(step)!");
    expect(result[0]?.message).not.toContain("BREAKING CHANGE:");
  });

  test("rescopeGroupMessageToCoveredGroups rewrites uncovered export-surface splits", async () => {
    const { rescopeGroupMessageToCoveredGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?uncovered-export-surface-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const broadSourceGroup = {
      files: [
        { path: "src/application/config/service.ts" },
        { path: "src/application/index.ts" },
        { path: "src/cli/commit/index.ts" },
        { path: "src/cli/index.ts" },
      ],
      message: commitMessage(
        "feat(config): expose config services and curated defaults",
        "- Add a dedicated config service with layered loading from defaults, system, user, local, and environment overrides.",
        "- Export config entry points and typed public surfaces explicitly so CLI and library consumers can import stable helpers directly.",
      ),
    };
    const splitGroup = {
      files: [{ path: "src/cli/index.ts" }],
      message: commitMessage(
        "feat(src/cli): expose config services and curated defaults",
        "- Add a dedicated config service with layered loading from defaults, system, user, local, and environment overrides.",
      ),
    };
    const allFiles = [
      makeFile("src/application/config/service.ts"),
      makeFile("src/application/index.ts"),
      makeFile("src/cli/commit/index.ts"),
      makeFile("src/cli/index.ts"),
    ];

    const result = rescopeGroupMessageToCoveredGroups(
      splitGroup,
      [broadSourceGroup],
      new Map(allFiles.map((file) => [file.path, file])),
    );

    expect(result.message).toBe("feat(cli): update public exports");
  });

  test("finalizePlannedGroups retries one transient consolidation failure before succeeding", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("consolidation-retry"),
        model: "gpt-5.3-codex",
      },
      performance: { timeoutMs: 25 },
    });
    const abortError = new Error("Request was aborted.");
    abortError.name = "AbortError";
    const calls = installOpenAiMock({
      chatQueue: [
        abortError,
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/commit-planning/result-cache.ts" },
                      { path: "tests/ai-coverage.test.ts" },
                    ],
                    message:
                      "feat(ai-cache): cache planned commit analysis\n\n- Reuse grouped plans for identical diff inputs.\n- Keep cache coverage aligned with the grouped rollout.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const observer = await import("../src/commit-planning/openai-client.js");
    const events: { content: string; kind?: string; stage: string }[] = [];
    observer.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?consolidation-retry-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message:
          "test(ai): cover plan cache reuse\n\n- Verify cache hits and stage reporting.",
      },
      {
        files: [{ path: "src/commit-planning/result-cache.ts" }],
        message:
          "feat(ai-cache): cache planned commit analysis\n\n- Reuse grouped plans for identical diff inputs.",
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/result-cache.ts"),
      makeFile("tests/ai-coverage.test.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(2);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain(
      "feat(ai-cache): cache planned commit analysis",
    );
    expect(
      events.some((event) =>
        event.content.includes('"decision":"consolidation-retry-scheduled"'),
      ),
    ).toBe(true);
    expect(
      events.some((event) =>
        event.content.includes('"decision":"consolidation-failed"'),
      ),
    ).toBe(false);
    observer.setAiOutputObserver(null);
  });

  test("finalizePlannedGroups rejects exhausted consolidation retries instead of falling back", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("consolidation-retry-exhausted"),
        model: "gpt-5.3-codex",
      },
      performance: { timeoutMs: 25 },
    });
    const firstAbortError = new Error("Request was aborted.");
    firstAbortError.name = "AbortError";
    const secondAbortError = new Error("Request was aborted.");
    secondAbortError.name = "AbortError";
    installOpenAiMock({
      chatQueue: [firstAbortError, secondAbortError],
    });
    const observer = await import("../src/commit-planning/openai-client.js");
    const events: { content: string; kind?: string; stage: string }[] = [];
    observer.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?consolidation-retry-exhausted-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message:
          "test(ai): cover plan cache reuse\n\n- Verify cache hits and stage reporting.",
      },
      {
        files: [{ path: "src/commit-planning/result-cache.ts" }],
        message:
          "feat(ai-cache): cache planned commit analysis\n\n- Reuse grouped plans for identical diff inputs.",
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/result-cache.ts"),
      makeFile("tests/ai-coverage.test.ts"),
    ];

    await expect(finalizePlannedGroups(allFiles, groups)).rejects.toThrow(
      OpenAIError,
    );

    expect(
      events.some((event) =>
        event.content.includes('"decision":"consolidation-retry-scheduled"'),
      ),
    ).toBe(true);
    expect(
      events.some((event) =>
        event.content.includes('"decision":"consolidation-failed"'),
      ),
    ).toBe(true);
    expect(
      events.some((event) =>
        event.content.includes('"decision":"consolidation-fallback"'),
      ),
    ).toBe(false);
    observer.setAiOutputObserver(null);
  });

  test("finalizePlannedGroups emits missing coverage diagnostics when consolidation drops a hunk", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("consolidation-coverage-mismatch"),
        model: "gpt-5.3-codex",
      },
    });
    installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      {
                        hunks: [0],
                        path: "src/commit-planning/result-cache.ts",
                      },
                    ],
                    message:
                      "feat(ai-cache): cache planned commit analysis\n\n- Reuse grouped plans for identical diff inputs.",
                  },
                  {
                    files: [{ path: "tests/ai-coverage.test.ts" }],
                    message:
                      "test(ai): cover plan cache reuse\n\n- Verify cache hits and stage reporting.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const observer = await import("../src/commit-planning/openai-client.js");
    const events: { content: string; kind?: string; stage: string }[] = [];
    observer.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?consolidation-coverage-mismatch-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ hunks: [0, 1], path: "src/commit-planning/result-cache.ts" }],
        message:
          "feat(ai-cache): cache planned commit analysis\n\n- Reuse grouped plans for identical diff inputs.",
      },
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message:
          "test(ai): cover plan cache reuse\n\n- Verify cache hits and stage reporting.",
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/result-cache.ts", 2),
      makeFile("tests/ai-coverage.test.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);
    const fallbackEvent = events.find((event) =>
      event.content.includes('"decision":"consolidation-fallback"'),
    );

    expect(result).toEqual(groups);
    expect(fallbackEvent).toBeDefined();
    expect(fallbackEvent?.content).toContain('"reason":"coverage-mismatch"');
    expect(fallbackEvent?.content).toContain('"missingCoverageCount":1');
    expect(fallbackEvent?.content).toContain(
      '"missingCoverageSample":["src/commit-planning/result-cache.ts#1"]',
    );
    expect(fallbackEvent?.content).toContain('"extraCoverageCount":0');
    observer.setAiOutputObserver(null);
  });

  test("finalizePlannedGroups keeps coverage-safe merges when another consolidated group drops coverage", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("consolidation-partial-salvage"),
        model: "gpt-5.3-codex",
      },
    });
    installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      {
                        path: "src/commit-planning/prompts/index.ts",
                      },
                      { path: "tests/ai.test.ts" },
                    ],
                    message: commitMessage(
                      "refactor(prompts): clarify consolidation guidance",
                      "- Keep the prompt focused on one clear why per commit.",
                      "- Cover the stronger why-first consolidation rules.",
                    ),
                  },
                  {
                    files: [
                      {
                        hunks: [0],
                        path: "src/commit-planning/result-cache.ts",
                      },
                    ],
                    message: commitMessage(
                      "feat(ai-cache): cache planned commit analysis",
                      "- Reuse grouped plans for identical diff inputs.",
                    ),
                  },
                  {
                    files: [
                      { path: "src/commit-planning/token-estimation.ts" },
                    ],
                    message: commitMessage(
                      "fix(token-estimation): buffer consolidation budgets",
                      "- Reduce low estimates during planner follow-up calls.",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const observer = await import("../src/commit-planning/openai-client.js");
    const events: { content: string; kind?: string; stage: string }[] = [];
    observer.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?consolidation-partial-salvage-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/prompts/index.ts",
          },
        ],
        message: commitMessage(
          "refactor(prompts): clarify consolidation guidance",
          "- Keep the prompt focused on one clear why per commit.",
        ),
      },
      {
        files: [{ path: "tests/ai.test.ts" }],
        message: commitMessage(
          "test(prompts): lock consolidation wording",
          "- Cover the stronger why-first consolidation rules.",
        ),
      },
      {
        files: [{ hunks: [0, 1], path: "src/commit-planning/result-cache.ts" }],
        message: commitMessage(
          "feat(ai-cache): cache planned commit analysis",
          "- Reuse grouped plans for identical diff inputs.",
        ),
      },
      {
        files: [{ path: "src/commit-planning/token-estimation.ts" }],
        message: commitMessage(
          "fix(token-estimation): buffer consolidation budgets",
          "- Reduce low estimates during planner follow-up calls.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/prompts/index.ts"),
      makeFile("tests/ai.test.ts"),
      makeFile("src/commit-planning/result-cache.ts", 2),
      makeFile("src/commit-planning/token-estimation.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);
    const salvageEvent = events.find((event) =>
      event.content.includes('"decision":"consolidation-partial-salvage"'),
    );
    const fallbackEvent = events.find((event) =>
      event.content.includes('"decision":"consolidation-fallback"'),
    );

    expect(result).toHaveLength(3);
    expect(result[0]?.files).toEqual([
      {
        path: "src/commit-planning/prompts/index.ts",
      },
      { path: "tests/ai.test.ts" },
    ]);
    expect(result[0]?.message).toContain(
      "refactor(prompts): clarify consolidation guidance",
    );
    expect(result[1]).toEqual(groups[2]);
    expect(result[2]).toEqual(groups[3]);
    expect(salvageEvent).toBeDefined();
    expect(salvageEvent?.content).toContain('"reason":"coverage-mismatch"');
    expect(salvageEvent?.content).toContain('"missingCoverageCount":1');
    expect(fallbackEvent).toBeUndefined();
    observer.setAiOutputObserver(null);
  });

  test("finalizePlannedGroups uses the extended planner timeout for slow consolidation reviews", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("consolidation-timeout-budget"),
        model: "gpt-5.3-codex",
      },
      performance: { timeoutMs: 10 },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        async (_payload: unknown, mockOptions: unknown) => {
          const signal = (mockOptions as { signal?: AbortSignal }).signal;

          return await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve({
                choices: [
                  {
                    message: {
                      content: JSON.stringify([
                        {
                          files: [
                            { path: "src/commit-planning/result-cache.ts" },
                            { path: "tests/ai-coverage.test.ts" },
                          ],
                          message:
                            "feat(ai-cache): cache planned commit analysis\n\n- Reuse grouped plans for identical diff inputs.\n- Keep cache coverage aligned with the grouped rollout.",
                        },
                      ]),
                    },
                  },
                ],
              });
            }, 20);

            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                const abortError = new Error("Request was aborted.");
                abortError.name = "AbortError";
                reject(abortError);
              },
              { once: true },
            );
          });
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?consolidation-timeout-budget-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message:
          "test(ai): cover plan cache reuse\n\n- Verify cache hits and stage reporting.",
      },
      {
        files: [{ path: "src/commit-planning/result-cache.ts" }],
        message:
          "feat(ai-cache): cache planned commit analysis\n\n- Reuse grouped plans for identical diff inputs.",
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/result-cache.ts"),
      makeFile("tests/ai-coverage.test.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain(
      "feat(ai-cache): cache planned commit analysis",
    );
  });

  test("finalizePlannedGroups increases consolidation output budget beyond the generic max token cap", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("consolidation-output-budget"),
        maxTokens: 64,
        model: "gpt-5.3-codex",
      },
    });
    const mergedPlan = JSON.stringify([
      {
        files: [
          { path: "src/commit-planning/result-cache.ts" },
          { path: "tests/ai-coverage.test.ts" },
        ],
        message:
          "feat(ai-cache): cache planned commit analysis\n\n- Reuse grouped plans for identical diff inputs.\n- Keep cache coverage aligned with the grouped rollout.",
      },
    ]);
    const calls = installOpenAiMock({
      chatQueue: [
        (payload: unknown) => {
          const requestedMaxTokens =
            (payload as { max_completion_tokens?: number })
              .max_completion_tokens ?? 0;

          return {
            choices: [
              {
                message: {
                  content:
                    requestedMaxTokens < 512
                      ? mergedPlan.slice(0, Math.floor(mergedPlan.length / 2))
                      : mergedPlan,
                },
              },
            ],
          };
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?consolidation-output-budget-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message:
          "test(ai): cover plan cache reuse\n\n- Verify cache hits and stage reporting.",
      },
      {
        files: [{ path: "src/commit-planning/result-cache.ts" }],
        message:
          "feat(ai-cache): cache planned commit analysis\n\n- Reuse grouped plans for identical diff inputs.",
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/result-cache.ts"),
      makeFile("tests/ai-coverage.test.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(1);
    expect(
      (calls.chat[0]?.payload as { max_completion_tokens?: number })
        .max_completion_tokens,
    ).toBeGreaterThan(64);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain(
      "feat(ai-cache): cache planned commit analysis",
    );
  });

  test("finalizePlannedGroups merges duplicate file entries inside one consolidated commit", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("consolidated-duplicate-files"),
        model: "gpt-5.3-codex",
      },
    });
    const duplicateConsolidationResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify([
              {
                files: [
                  {
                    hunks: [0, 1],
                    path: "src/commit-planning/orchestration.ts",
                  },
                  {
                    hunks: [3],
                    path: "src/commit-planning/orchestration.ts",
                  },
                  { path: "src/commit-planning/openai-client.ts" },
                ],
                message:
                  "feat(ai): consolidate duplicate file entries\n\n- Keep one file entry per path after consolidation.",
              },
            ]),
          },
        },
      ],
    };
    const calls = installOpenAiMock({
      chatQueue: Array.from(
        { length: 8 },
        () => duplicateConsolidationResponse,
      ),
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?consolidated-duplicate-files-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { hunks: [0, 1], path: "src/commit-planning/orchestration.ts" },
        ],
        message: commitMessage(
          "feat(ai): normalize stage metrics",
          "- Keep stage metric handling consistent across planner outputs.",
        ),
      },
      {
        files: [
          { hunks: [3], path: "src/commit-planning/orchestration.ts" },
          { path: "src/commit-planning/openai-client.ts" },
        ],
        message: commitMessage(
          "feat(ai): normalize stage metrics output",
          "- Align CLI rendering with the normalized stage metric shape.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/orchestration.ts", 5),
      makeFile("src/commit-planning/openai-client.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(0);
    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { hunks: [0, 1, 3], path: "src/commit-planning/orchestration.ts" },
      { path: "src/commit-planning/openai-client.ts" },
    ]);
  });

  test("finalizePlannedGroups splits disconnected consolidation intents back apart", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-disconnected-consolidation"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      {
                        path: "src/commit-planning/grouping/index.ts",
                      },
                      {
                        path: "src/commit-planning/prompts/index.ts",
                      },
                      { path: "tests/ai.test.ts" },
                    ],
                    message:
                      "refactor(ai): tighten merge planning rules\n\n- Combine grouping heuristics and prompt changes into one broader update.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-disconnected-consolidation-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/index.ts",
          },
        ],
        message: commitMessage(
          "refactor(planned-commit-grouping): tighten merge-signal gating",
          "- Limit consolidation to commits with strong merge evidence.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/prompts/index.ts",
          },
        ],
        message: commitMessage(
          "refactor(prompts): clarify consolidation guidance",
          "- Keep the prompt focused on one clear why per commit.",
        ),
      },
      {
        files: [{ path: "tests/ai.test.ts" }],
        message: commitMessage(
          "test(prompts): lock consolidation wording",
          "- Cover the stronger why-first consolidation rules.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/grouping/index.ts"),
      makeFile("src/commit-planning/prompts/index.ts"),
      makeFile("tests/ai.test.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(groups[0]);
    expect(result[1]?.files).toEqual([
      {
        path: "src/commit-planning/prompts/index.ts",
      },
      { path: "tests/ai.test.ts" },
    ]);
    expect(result[1]?.message).toContain(
      "refactor(prompts): clarify consolidation guidance",
    );
    expect(result[1]?.message).toContain(
      "- Cover the stronger why-first consolidation rules.",
    );
  });

  test("finalizePlannedGroups merges the exact CLI export-surface shards from terminal token verbose rendering and display helpers", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("exact-cli-export-surface-shards"),
        model: "gpt-5.3-codex",
      },
    });
    const files = [
      "src/cli/terminal/columns.ts",
      "src/cli/terminal/index.ts",
      "src/cli/terminal/line-wrapping.ts",
      "src/cli/token/index.ts",
      "src/cli/token/splitting.ts",
      "src/cli/verbose-rendering/block-render.ts",
      "src/cli/verbose-rendering/event-stats.ts",
      "src/cli/verbose-rendering/index.ts",
      "src/cli/verbose-rendering/json-trace.ts",
      "src/cli/output-presentation.ts",
      "src/cli/planner-notices.ts",
      "src/cli/session-display.ts",
      "src/cli/staging-guard.ts",
      "src/cli/verbose-output.ts",
      "src/cli/viewport.ts",
    ];
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: files.map((path) => ({ path })),
                    message: commitMessage(
                      "refactor(cli): narrow terminal and verbose rendering exports",
                      "- Replace wildcard terminal, token, verbose-rendering, and display-helper exports with one explicit CLI surface.",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?exact-cli-export-surface-shards-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const groups = [
      {
        files: [
          { path: "src/cli/terminal/columns.ts" },
          { path: "src/cli/terminal/index.ts" },
          { path: "src/cli/terminal/line-wrapping.ts" },
        ],
        message: commitMessage(
          "refactor(cli): narrow terminal and verbose rendering exports",
          "- Replace wildcard terminal exports with explicit symbols.",
        ),
      },
      {
        files: [
          { path: "src/cli/token/index.ts" },
          { path: "src/cli/token/splitting.ts" },
        ],
        message: commitMessage(
          "refactor(cli): narrow terminal and verbose rendering exports",
          "- Replace wildcard token exports with explicit symbols.",
        ),
      },
      {
        files: [
          { path: "src/cli/verbose-rendering/block-render.ts" },
          { path: "src/cli/verbose-rendering/event-stats.ts" },
          { path: "src/cli/verbose-rendering/index.ts" },
          { path: "src/cli/verbose-rendering/json-trace.ts" },
        ],
        message: commitMessage(
          "refactor(cli): narrow terminal and verbose rendering exports",
          "- Replace wildcard verbose-rendering exports with explicit symbols.",
        ),
      },
      {
        files: [
          { path: "src/cli/output-presentation.ts" },
          { path: "src/cli/planner-notices.ts" },
          { path: "src/cli/session-display.ts" },
          { path: "src/cli/staging-guard.ts" },
          { path: "src/cli/verbose-output.ts" },
          { path: "src/cli/viewport.ts" },
        ],
        message: commitMessage(
          "refactor(cli): narrow terminal and verbose rendering exports",
          "- Keep display and verbose-output helpers on the same explicit CLI surface.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      files.map((path) => makeFile(path)),
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual(files.map((path) => ({ path })));
    expect(result[0]?.message.split("\n")[0]).toBe(
      "refactor(cli): narrow terminal and verbose rendering exports",
    );
  });

  test("absorbIncidentalAdjacentGroups merges the exact diff and git coverage hardening slices for local repo setup", async () => {
    const { absorbIncidentalAdjacentGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/group/index.js?exact-git-test-hardening-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { hunks: [0, 1], path: "tests/git-coverage.test.ts" },
          { hunks: [0], path: "tests/git-header.test.ts" },
        ],
        message: commitMessage(
          "test(git): isolate integration repos from global git settings",
          "- Add shared repository initialization that disables signing and resets hooks.",
        ),
      },
      {
        files: [{ hunks: [0], path: "tests/diff.test.ts" }],
        message: commitMessage(
          "test(diff): isolate integration repos from global git settings",
          "- Reuse the local Git repo setup so machine-specific hooks do not block diff coverage.",
        ),
      },
    ];

    const files = [
      makeFile("tests/git-coverage.test.ts"),
      makeFile("tests/git-header.test.ts"),
      makeFile("tests/diff.test.ts"),
    ];

    const result = absorbIncidentalAdjacentGroups(
      groups,
      new Map(files.map((file) => [file.path, file])),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { hunks: [0, 1], path: "tests/git-coverage.test.ts" },
      { hunks: [0], path: "tests/git-header.test.ts" },
      { hunks: [0], path: "tests/diff.test.ts" },
    ]);
    expect(result[0]?.message.split("\n")[0]).toBe(
      "test(git): isolate integration repos from global git settings",
    );
  });

  test("splitWeakConsolidations splits cross-domain umbrella feature consolidations", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?cross-domain-umbrella-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?cross-domain-umbrella-split-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/config-schema/entries.ts" }],
        message: commitMessage(
          "feat(config-schema): add declarative authoring helpers",
          "- Normalize kind-based config entries through registered handlers.",
        ),
      },
      {
        files: [{ path: "src/step/args.ts" }],
        message: commitMessage(
          "feat(step): add declarative authoring helpers",
          "- Normalize string and array command args for step factories.",
        ),
      },
      {
        files: [{ path: "src/quality/complexity/step.ts" }],
        message: commitMessage(
          "feat(quality): add declarative authoring helpers",
          "- Expose complexity checks through reusable config authoring helpers.",
        ),
      },
      {
        files: [{ path: "tests/config-authoring.test.ts" }],
        message: commitMessage(
          "test(config): cover declarative authoring helpers",
          "- Verify config parsing, step factories, and quality helper composition.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/config-schema/entries.ts"),
      makeFile("src/step/args.ts"),
      makeFile("src/quality/complexity/step.ts"),
      makeFile("tests/config-authoring.test.ts"),
    ];

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: [
            { path: "src/config-schema/entries.ts" },
            { path: "src/step/args.ts" },
            { path: "src/quality/complexity/step.ts" },
            { path: "tests/config-authoring.test.ts" },
          ],
          message: commitMessage(
            "feat(config-schema): add declarative step factories and helpers",
            "- Combine config entry parsing, step factories, quality helpers, and tests into one rollout.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toEqual([
      "feat(config-schema): add declarative authoring helpers",
      "feat(step): add declarative authoring helpers",
      "feat(quality): add declarative authoring helpers",
    ]);
    expect(result[0]?.files).toEqual([
      { path: "src/config-schema/entries.ts" },
      { path: "tests/config-authoring.test.ts" },
    ]);
  });

  test("splitWeakConsolidations keeps unrelated style support out of single-owner fixes", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?single-owner-style-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?single-owner-style-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/merge-heuristics.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping): block weak cross-domain umbrella merges",
          "- Reject mixed-domain implementation buckets without strong coupling.",
        ),
      },
      {
        files: [{ hunks: [1, 2, 3], path: "tests/zz-cli-coverage.test.ts" }],
        message: commitMessage(
          "style(tests): reflow cli coverage formatting",
          "- Rewrap helper signatures and multiline expectations without changing behavior.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/grouping/merge-heuristics.ts"),
      makeFile("tests/zz-cli-coverage.test.ts", 4),
    ];

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: [
            {
              path: "src/commit-planning/grouping/merge-heuristics.ts",
            },
            { hunks: [1, 2, 3], path: "tests/zz-cli-coverage.test.ts" },
          ],
          message: commitMessage(
            "fix(grouping): block weak cross-domain umbrella merges",
            "- Combine merge heuristic changes with unrelated test formatting cleanup.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toEqual([
      "fix(grouping): block weak cross-domain umbrella merges",
      "style(tests): reflow cli coverage formatting",
    ]);
  });

  test("splitWeakConsolidations keeps same-intent sibling fixes together within one feature root", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?same-root-tls-fix-merge-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?same-root-tls-fix-merge-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const groups = [
      {
        files: [{ path: "src/lib/api/contracts.ts" }],
        message: commitMessage(
          "fix(api): remove allowInsecureTls from proxy and fetch contracts",
          "- Drop the insecure TLS escape hatch from API-facing contract types.",
        ),
      },
      {
        files: [{ path: "src/lib/core/contracts.ts" }],
        message: commitMessage(
          "fix(core): remove allowInsecureTls from proxy and fetch contracts",
          "- Drop the insecure TLS escape hatch from shared core contract types.",
        ),
      },
      {
        files: [{ path: "src/lib/fetch/contracts.ts" }],
        message: commitMessage(
          "fix(fetch): remove allowInsecureTls from proxy and fetch contracts",
          "- Drop the insecure TLS escape hatch from fetch-layer contract types.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/lib/api/contracts.ts"),
      makeFile("src/lib/core/contracts.ts"),
      makeFile("src/lib/fetch/contracts.ts"),
    ];

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: groups.flatMap((group) => group.files),
          message: commitMessage(
            "fix(lib): remove allowInsecureTls from proxy and fetch contracts",
            "- Remove the insecure TLS override throughout shared proxy and fetch contracts.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual(groups.flatMap((group) => group.files));
    expect(result[0]?.message).toContain(
      "remove allowInsecureTls from proxy and fetch contracts",
    );
  });

  test("splitWeakConsolidations splits a cross-root rollout back to its baseline groups", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?step-identity-rollout-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?step-identity-rollout-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/types/step-types.ts" }],
        message: commitMessage(
          "refactor(src/types): remove StepConfig label and standardize on key",
          "- Drops the redundant label field from StepConfig.",
          "- Standardizes step identity on key across the suite pipeline.",
        ),
      },
      {
        files: [{ path: "src/summary/simple.ts" }],
        message: commitMessage(
          "refactor(src/summary): remove StepConfig label and standardize on key",
          "- Drops the redundant label field from StepConfig.",
          "- Standardizes step identity on key across the suite pipeline.",
        ),
      },
      {
        files: [
          { path: "src/step/build.ts" },
          { path: "src/suite-processing/batch.ts" },
        ],
        message: commitMessage(
          "refactor(src/step): remove StepConfig label and standardize on key",
          "- Drops the redundant label field from StepConfig.",
          "- Standardizes step identity on key across the suite pipeline.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/types/step-types.ts"),
      makeFile("src/summary/simple.ts"),
      makeFile("src/step/build.ts"),
      makeFile("src/suite-processing/batch.ts"),
    ];

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: allFiles.map((file) => ({ path: file.path })),
          message: commitMessage(
            "refactor(step): remove StepConfig label and standardize on key",
            "- Drops the redundant label field from StepConfig.",
            "- Standardizes step identity on key across the suite pipeline.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    // Cross-root rollouts (each group in a different featureRoot) are structurally
    // indistinguishable from umbrella families with coincidentally identical subjects,
    // so they get split back to their baseline groups rather than preserved.
    expect(result).toHaveLength(3);
    expect(result.map((g: PlannedCommit) => g.message.split("\n")[0])).toEqual(
      groups.map((g) => g.message.split("\n")[0]),
    );
  });

  test("splitWeakConsolidations keeps deep internal planner reorganizations split even when subjects overlap", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?deep-planner-internals-counterexample-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?deep-planner-internals-counterexample-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/commit-planning/prompts/rules/commit/generation.ts" },
        ],
        message: commitMessage(
          "refactor(commit-planning): reorganize planner internals around staged rollouts",
          "- Move prompt-rule internals into the staged planner rule composition path.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/implementation-merge/eligibility.ts",
          },
        ],
        message: commitMessage(
          "refactor(commit-planning): reorganize planner internals around staged rollouts",
          "- Move implementation-merge eligibility internals into stricter ownership boundaries.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/support-attachment/scoring.ts",
          },
        ],
        message: commitMessage(
          "refactor(commit-planning): reorganize planner internals around staged rollouts",
          "- Move support-attachment scoring internals into stricter ownership boundaries.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/prompts/rules/commit/generation.ts"),
      makeFile(
        "src/commit-planning/grouping/implementation-merge/eligibility.ts",
      ),
      makeFile("src/commit-planning/grouping/support-attachment/scoring.ts"),
    ];

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: allFiles.map((file) => ({ path: file.path })),
          message: commitMessage(
            "refactor(commit-planning): reorganize planner internals around staged rollouts",
            "- Combine prompt-rule, grouping, and path internals in one broad planner rollout.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(3);
    expect(result.map((group: PlannedCommit) => group.files)).toEqual(
      groups.map((group) => group.files),
    );
  });

  test("splitWeakConsolidations keeps mixed-type rollout slices together within one feature root", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?mixed-type-step-rollout-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?mixed-type-step-rollout-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/step/build.ts" }],
        message: commitMessage(
          "refactor(step): remove StepConfig label and standardize on key",
          "- Removes the redundant label field from step definitions.",
          "- Standardizes step identity on key across the suite pipeline.",
        ),
      },
      {
        files: [{ path: "src/step/lint.ts" }],
        message: commitMessage(
          "fix(lint): use stable step key for lint command labeling",
          "- Switches lint command labeling to step.key so runtime output stays aligned.",
          "- Keeps the same step identity migration visible in operator-facing output.",
        ),
      },
      {
        files: [{ path: "src/quality/module-boundaries/step.ts" }],
        message: commitMessage(
          "fix(quality): align architecture step options with inline runner API",
          "- Removes the unsupported label option from the architecture step contract.",
          "- Passes the same key-based step identity through the inline runner path.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/step/build.ts"),
      makeFile("src/step/lint.ts"),
      makeFile("src/quality/module-boundaries/step.ts"),
    ];

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: allFiles.map((file) => ({ path: file.path })),
          message: commitMessage(
            "refactor(steps): standardize step identity on key",
            "- Removes the redundant label field from step definitions and step adapters.",
            "- Keeps step identity and runtime output aligned on key across the suite pipeline.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.files).toEqual([
      { path: "src/step/build.ts" },
      { path: "src/step/lint.ts" },
    ]);
    expect(result[0]?.message).toContain("step key");
    expect(result[1]?.files).toEqual([
      { path: "src/quality/module-boundaries/step.ts" },
    ]);
  });

  test("splitWeakConsolidations splits oversized same-feature implementation umbrellas by structural owner", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?same-feature-owner-fanout-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?same-feature-owner-fanout-split-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/core/parser/service.ts" }],
        message: commitMessage(
          "fix(core): harden parser validation flow",
          "- Keep parser validation coverage and fallback handling precise.",
        ),
      },
      {
        files: [{ path: "src/core/cache/service.ts" }],
        message: commitMessage(
          "fix(core): harden cache salvage flow",
          "- Preserve cache recovery behavior without smearing planner state.",
        ),
      },
      {
        files: [{ path: "src/core/ordering/service.ts" }],
        message: commitMessage(
          "fix(core): harden ordering stabilization flow",
          "- Keep dependency ordering stable after consolidation changes.",
        ),
      },
      {
        files: [{ path: "src/core/messages/service.ts" }],
        message: commitMessage(
          "fix(core): harden message metadata flow",
          "- Preserve message metadata while validating merged plans.",
        ),
      },
    ];
    const allFiles = groups.map((group) => makeFile(group.files[0]!.path));

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: groups.flatMap((group) => group.files),
          message: commitMessage(
            "fix(core): harden parser, cache, ordering, and message flows",
            "- Combine parser validation, cache salvage, ordering stabilization, and message metadata fixes.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(4);
    expect(result.map((group: PlannedCommit) => group.files)).toEqual(
      groups.map((group) => group.files),
    );
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toEqual(groups.map((group) => group.message.split("\n")[0]));
  });

  test("splitWeakConsolidations splits broad same-feature umbrellas even when one direct feature file shares the root", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?mixed-direct-and-nested-owner-fanout-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?mixed-direct-and-nested-owner-fanout-split-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/commit-planning/client-contracts.ts" }],
        message: commitMessage(
          "fix(planning): allow temperature for gpt-5 codex model variants",
          "- Keep request parameter validation aligned with supported Codex model families.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/group/finalization.ts",
          },
          {
            path: "src/commit-planning/grouping/group/message-harmonization.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping): stabilize consolidation with safer merge decisions",
          "- Keep grouping stabilization and message harmonization on one ownership boundary.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
          {
            path: "src/commit-planning/prompts/stages/plan-consolidation.ts",
          },
        ],
        message: commitMessage(
          "refactor(prompts): centralize planning prompt rules and builders",
          "- Keep staged prompt builders and consolidation prompts on the same prompt surface.",
        ),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: allFiles.map((file) => ({ path: file.path })),
          message: commitMessage(
            "fix(commit-planning): stabilize grouping and prompt planning flow",
            "- Fold client-contract validation, grouping stabilization, and prompt-stage rewrites into one planner umbrella.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(3);
    expect(result.map((group: PlannedCommit) => group.files)).toEqual(
      groups.map((group) => group.files),
    );
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toEqual(groups.map((group) => group.message.split("\n")[0]));
  });

  test("splitWeakConsolidations splits deep same-owner grouping umbrellas by nested surface owner", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?deep-same-owner-surface-fanout-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?deep-same-owner-surface-fanout-split-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/commit-planning/grouping/dependency/index.ts" },
          {
            path: "src/commit-planning/grouping/dependency/ordering.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping): keep dependency helpers on their own structural surface",
          "- Keep dependency helpers out of broader grouping umbrellas.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/group/finalization.ts",
          },
          {
            path: "src/commit-planning/grouping/group/message-harmonization.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping): stabilize final grouping and message harmonization",
          "- Keep finalization and message repair on the same grouping surface.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/implementation-merge/eligibility.ts",
          },
          {
            path: "src/commit-planning/grouping/implementation-merge/service.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping): tighten implementation merge rollout decisions",
          "- Keep implementation merge eligibility and service logic on the same rollout boundary.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/subject/analysis.ts" },
          {
            path: "src/commit-planning/grouping/subject/path-areas.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping): tighten subject merge signals for compact rollouts",
          "- Keep subject analysis and path-area heuristics together.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/baseline-restoration.ts" },
          { path: "src/commit-planning/grouping/repartition.ts" },
        ],
        message: commitMessage(
          "fix(grouping): preserve cohesive rollouts when repartitioning commits",
          "- Keep baseline restoration and repartition flow changes together.",
        ),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: allFiles.map((file) => ({ path: file.path })),
          message: commitMessage(
            "fix(grouping): align prompts, cache keys, and validation modes",
            "- Fold finalization, implementation merge, subject heuristics, and repartition work into one grouping umbrella.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(5);
    expect(result.map((group: PlannedCommit) => group.files)).toEqual(
      groups.map((group) => group.files),
    );
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toEqual(groups.map((group) => group.message.split("\n")[0]));
  });

  test("normalizeMixedRootImplementationGroups emits a planner decision event when mixed-root normalization splits a broad grouping umbrella", async () => {
    const observer = await import("../src/commit-planning/openai-client.js");
    const events: { content: string; kind?: string; stage: string }[] = [];
    observer.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });
    const { normalizeMixedRootImplementationGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/group/normalization.js?mixed-root-normalization-trace-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const sourceGroups = [
      {
        files: [
          { path: "src/commit-planning/grouping/dependency/index.ts" },
          { path: "src/commit-planning/grouping/dependency/ordering.ts" },
        ],
        message: commitMessage(
          "fix(grouping): keep dependency helpers on their own structural surface",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/group/finalization.ts" },
          {
            path: "src/commit-planning/grouping/group/message-harmonization.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping): stabilize final grouping and message harmonization",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/implementation-merge/eligibility.ts",
          },
          {
            path: "src/commit-planning/grouping/implementation-merge/service.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping): tighten implementation merge rollout decisions",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/subject/analysis.ts" },
          { path: "src/commit-planning/grouping/subject/path-areas.ts" },
        ],
        message: commitMessage(
          "fix(grouping): tighten subject merge signals for compact rollouts",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/baseline-restoration.ts" },
          { path: "src/commit-planning/grouping/repartition.ts" },
        ],
        message: commitMessage(
          "fix(grouping): preserve cohesive rollouts when repartitioning commits",
        ),
      },
    ];
    const mergedGroup = {
      files: sourceGroups.flatMap((group) => group.files),
      message: commitMessage(
        "fix(grouping): align prompts, cache keys, and validation modes",
        "- Fold finalization, implementation merge, subject heuristics, and repartition work into one grouping umbrella.",
      ),
    };
    const allFiles = mergedGroup.files.map((file) => makeFile(file.path));

    const result = normalizeMixedRootImplementationGroups(
      [mergedGroup],
      sourceGroups,
      new Map(allFiles.map((file) => [file.path, file])),
    );

    expect(result).toHaveLength(sourceGroups.length);
    expect(
      events.some(
        (event) =>
          event.kind === "planner-decision" &&
          event.stage === "consolidate" &&
          event.content.includes('"decision":"normalization-split"') &&
          event.content.includes(
            '"normalizationKind":"mixed-root-implementation"',
          ),
      ),
    ).toBe(true);
    observer.setAiOutputObserver(null);
  });

  test("shouldPreserveIdenticalRollout rejects broad deep grouping baselines even when one root bucket is present", async () => {
    const normalizationModule = await import(
      new URL(
        `../src/commit-planning/grouping/group/normalization.js?broad-grouping-baseline-restore-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const rolloutPreservationModule = await import(
      new URL(
        `../src/commit-planning/grouping/rollout-preservation.js?broad-grouping-baseline-restore-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const { normalizeMixedRootImplementationGroups } = normalizationModule;
    const { shouldPreserveIdenticalRollout } = rolloutPreservationModule;

    const allFiles = [
      makeFile("src/commit-planning/grouping/baseline-restoration.ts"),
      makeFile("src/commit-planning/grouping/grouping-types.ts"),
      makeFile("src/commit-planning/grouping/repartition.ts"),
      makeFile("src/commit-planning/grouping/dependency/index.ts"),
      makeFile("src/commit-planning/grouping/dependency/ordering.ts"),
      makeFile("src/commit-planning/grouping/group/adjacent/absorption.ts"),
      makeFile(
        "src/commit-planning/grouping/group/adjacent/support-merge/eligibility.ts",
      ),
      makeFile("src/commit-planning/grouping/group/finalization.ts"),
      makeFile(
        "src/commit-planning/grouping/implementation-merge/eligibility.ts",
      ),
      makeFile("src/commit-planning/grouping/implementation-merge/index.ts"),
      makeFile(
        "src/commit-planning/grouping/style-splitting/area-splitting.ts",
      ),
      makeFile("src/commit-planning/grouping/style-splitting/index.ts"),
      makeFile("src/commit-planning/grouping/subject/premerge/follow-ups.ts"),
      makeFile("src/commit-planning/grouping/subject/premerge/index.ts"),
      makeFile("src/commit-planning/grouping/subject/path-areas.ts"),
    ];
    const umbrella = {
      files: allFiles.map((file) => ({ path: file.path })),
      message: commitMessage(
        "fix(commit-planning-grouping): align prompts, cache keys, and validation modes",
        "- Fold root grouping helpers and deep nested grouping surfaces into one umbrella.",
      ),
    };
    const fileByPath = new Map(allFiles.map((file) => [file.path, file]));
    const baseline = normalizeMixedRootImplementationGroups(
      [umbrella],
      [umbrella],
      fileByPath,
    );

    expect(baseline).toHaveLength(6);
    expect(shouldPreserveIdenticalRollout(baseline)).toBe(false);
  });

  test("resolveHarmonizedConsolidation rejects style-only support absorbed by a fix", async () => {
    const { resolveHarmonizedConsolidation } = await import(
      new URL(
        `../src/commit-planning/grouping/group/group-stability.js?style-support-consolidation-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?style-support-consolidation-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const groups = [
      {
        files: [
          { path: "src/commit-planning/response-validation.ts" },
          { path: "src/commit-planning/result-cache.ts" },
          { hunks: [5], path: "tests/ai-coverage.test.ts" },
        ],
        message: commitMessage(
          "fix(commit-planning): suppress markers in disabled mode output",
          "- Normalize generated metadata before validation when disabled mode is active.",
        ),
      },
      {
        files: [
          { hunks: [0, 1, 2], path: "tests/ai.test.ts" },
          { hunks: [1, 2, 3], path: "tests/zz-cli-coverage.test.ts" },
        ],
        message: commitMessage(
          "style(tests): reflow long lines in AI and CLI coverage specs",
          "- Wrap long imports and expectations without changing assertions.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/response-validation.ts"),
      makeFile("src/commit-planning/result-cache.ts"),
      makeFile("tests/ai-coverage.test.ts", 6),
      makeFile("tests/ai.test.ts", 3),
      makeFile("tests/zz-cli-coverage.test.ts", 4),
    ];

    const result = resolveHarmonizedConsolidation(
      groups,
      [
        {
          files: [
            { path: "src/commit-planning/response-validation.ts" },
            { path: "src/commit-planning/result-cache.ts" },
            { hunks: [5], path: "tests/ai-coverage.test.ts" },
            { hunks: [0, 1, 2], path: "tests/ai.test.ts" },
            { hunks: [1, 2, 3], path: "tests/zz-cli-coverage.test.ts" },
          ],
          message: commitMessage(
            "fix(commit-planning): suppress markers in disabled mode output",
            "- Combine validation fixes with unrelated test formatting cleanup.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
      performance.now(),
    );

    expect(result).toBeNull();
  });

  test("splitWeakConsolidations distributes broad test support by implementation owner", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?broad-test-support-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?broad-test-support-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/prompts/rules/commit/message.ts",
          },
          {
            path: "src/commit-planning/prompts/stages/hunk-grouping.ts",
          },
        ],
        message: commitMessage(
          "feat(commit-planning): add breaking-mode prompt policies",
          "- Centralize prompt guidance for normal, sensitive, and disabled modes.",
        ),
      },
      {
        files: [{ path: "src/cli/main.ts" }],
        message: commitMessage(
          "feat(cli): support no-breaking mode selection",
          "- Parse mode flags and expose help for metadata policy selection.",
        ),
      },
      {
        files: [{ path: "src/commit-messages/formatting.ts" }],
        message: commitMessage(
          "feat(commit-messages): add metadata suppression helper",
          "- Remove release-impact markers from generated commit messages when disabled.",
        ),
      },
      {
        files: [
          { hunks: [11], path: "tests/ai.test.ts" },
          { hunks: [0, 1], path: "tests/commit-messages.test.ts" },
          { hunks: [0], path: "tests/cli.test.ts" },
        ],
        message: commitMessage(
          "test(breaking-mode): cover sensitive and no-breaking behavior",
          "- Verify prompt, formatter, and CLI mode behavior together.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/prompts/rules/commit/message.ts"),
      makeFile("src/commit-planning/prompts/stages/hunk-grouping.ts"),
      makeFile("src/cli/main.ts"),
      makeFile("src/commit-messages/formatting.ts"),
      makeFile("tests/ai.test.ts", 12),
      makeFile("tests/commit-messages.test.ts", 2),
      makeFile("tests/cli.test.ts", 1),
    ];

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: groups.flatMap((group) => group.files),
          message: commitMessage(
            "feat(commit-planning): add breaking-mode prompt policies and coverage",
            "- Combine prompt policies, CLI flags, formatter helpers, and cross-suite tests.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    const resultSubjects = result.map(
      (group: PlannedCommit) => group.message.split("\n")[0],
    );
    expect(resultSubjects).toEqual(
      expect.arrayContaining([
        "feat(commit-planning): add breaking-mode prompt policies",
        "feat(cli): support no-breaking mode selection",
        "feat(commit-messages): add metadata suppression helper",
        "test(ai): cover sensitive and no-breaking behavior",
        "test(commit-messages): cover sensitive and no-breaking behavior",
        "test(cli): cover sensitive and no-breaking behavior",
      ]),
    );
    expect(resultSubjects).not.toContain(
      "feat(commit-planning): add breaking-mode prompt policies and coverage",
    );
  });

  test("splitWeakConsolidations keeps coherent test support grouped when one attachment is decisive", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?coherent-test-support-attachment-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?coherent-test-support-attachment-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/step/build.ts" }, { path: "src/step/lint.ts" }],
        message: commitMessage(
          "refactor(step): remove StepConfig label and standardize on key",
          "- Standardizes step identity on key across step builders and runtime output.",
        ),
      },
      {
        files: [{ path: "src/quality/complexity/main.ts" }],
        message: commitMessage(
          "fix(complexity): resolve relative metric paths against run cwd",
          "- Resolves analyzer-reported relative file paths before AST matching.",
        ),
      },
      {
        files: [
          { path: "tests/helper-coverage-regression.test.ts" },
          { path: "tests/suite-processing/batch.test.ts" },
          { path: "tests/suite-processing/execution.test.ts" },
          { path: "tests/suite-processing/selection.test.ts" },
        ],
        message: commitMessage(
          "test(step-config): stop requiring label in step test fixtures",
          "- Updates helper builders and suite-processing assertions to use key as the canonical step identifier.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/step/build.ts"),
      makeFile("src/step/lint.ts"),
      makeFile("src/quality/complexity/main.ts"),
      makeFile("tests/helper-coverage-regression.test.ts"),
      makeFile("tests/suite-processing/batch.test.ts"),
      makeFile("tests/suite-processing/execution.test.ts"),
      makeFile("tests/suite-processing/selection.test.ts"),
    ];

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: allFiles.map((file) => ({ path: file.path })),
          message: commitMessage(
            "fix(step-config): standardize step identity on key across config, runtime, and tests",
            "- Combines step identity rollout work with the focused step-config regression coverage.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.files).toEqual([
      { path: "src/step/build.ts" },
      { path: "src/step/lint.ts" },
      { path: "tests/helper-coverage-regression.test.ts" },
      { path: "tests/suite-processing/batch.test.ts" },
      { path: "tests/suite-processing/execution.test.ts" },
      { path: "tests/suite-processing/selection.test.ts" },
    ]);
    expect(result[1]?.files).toEqual([
      { path: "src/quality/complexity/main.ts" },
    ]);
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).not.toEqual(
      expect.arrayContaining([
        "test(helper-regression): cover related behavior",
        "test(batch): cover related behavior",
        "test(execution): cover related behavior",
        "test(selection): cover related behavior",
      ]),
    );
  });
  test("splitWeakConsolidations does not collapse a partially attachable broad support bundle back into one owner", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?partial-support-attachment-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?partial-support-attachment-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/cli/interactive-prompt.ts" },
          { path: "src/cli/token/confirmation.ts" },
        ],
        message: commitMessage(
          "fix(cli): abort plan confirmation on stdin EOF instead of auto-accept",
          "- Default closed confirmation prompts to decline so interrupted sessions cannot silently continue.",
        ),
      },
      {
        files: [
          { path: "tests/cli.test.ts" },
          { path: "tests/config.test.ts" },
          { path: "tests/planner-helpers.test.ts" },
        ],
        message: commitMessage(
          "test(runtime): cover EOF confirmation, config defaults, and model support helpers",
          "- Combine CLI EOF coverage with broader configuration and planner helper assertions.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/cli/interactive-prompt.ts"),
      makeFile("src/cli/token/confirmation.ts"),
      makeFile("tests/cli.test.ts"),
      makeFile("tests/config.test.ts"),
      makeFile("tests/planner-helpers.test.ts"),
    ];

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: allFiles.map((file) => ({ path: file.path })),
          message: commitMessage(
            "fix(cli): harden EOF confirmation and related test coverage",
            "- Combine CLI EOF confirmation changes with broader test updates.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    const cliRuntimeGroup = result.find(
      (group: PlannedCommit) =>
        group.files.some(
          (file) => file.path === "src/cli/interactive-prompt.ts",
        ) &&
        group.files.some(
          (file) => file.path === "src/cli/token/confirmation.ts",
        ),
    );
    const configSupportGroup = result.find((group: PlannedCommit) =>
      group.files.some((file) => file.path === "tests/config.test.ts"),
    );
    const plannerHelperSupportGroup = result.find((group: PlannedCommit) =>
      group.files.some((file) => file.path === "tests/planner-helpers.test.ts"),
    );

    expect(cliRuntimeGroup).toBeDefined();
    expect(
      cliRuntimeGroup?.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "tests/config.test.ts",
      ),
    ).toBe(false);
    expect(
      cliRuntimeGroup?.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "tests/planner-helpers.test.ts",
      ),
    ).toBe(false);
    expect(configSupportGroup).toBeDefined();
    expect(
      configSupportGroup?.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "src/cli/interactive-prompt.ts",
      ),
    ).toBe(false);
    expect(plannerHelperSupportGroup).toBeDefined();
    expect(
      plannerHelperSupportGroup?.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "src/cli/interactive-prompt.ts",
      ),
    ).toBe(false);
  });

  test("splitWeakConsolidations keeps broad dashboard e2e preference seeding separate from feed mutation reload work", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?dashboard-preference-seeding-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?dashboard-preference-seeding-split-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          {
            path: "src/app/dashboard/dashboard-hooks/feed-loader/useFeedLoader.ts",
          },
          {
            path: "src/app/dashboard/dashboard-hooks/feedSourceActionState.ts",
          },
          {
            path: "src/app/dashboard/dashboard-services/feed-data/source/operations.ts",
          },
          { path: "src/app/dashboard/dashboard-services/opml-import.ts" },
          { path: "tests/dashboard-hooks.test.ts" },
          { path: "tests/dashboard-source-operations.test.ts" },
          { path: "tests/e2e/dashboard-add-feed-visibility.e2e.test.ts" },
        ],
        message: commitMessage(
          "fix(dashboard): force fresh source reloads after feed mutations",
          "- Force authoritative source reloads after feed mutations so sidebar and settings stay in sync.",
        ),
      },
      {
        files: [
          { path: "tests/e2e/helpers.ts" },
          { path: "tests/e2e/dashboard-article-sort-order.e2e.test.ts" },
          {
            path: "tests/e2e/dashboard-feed-pagination-visible-read.e2e.test.ts",
          },
          {
            path: "tests/e2e/dashboard-pagination-skeleton-contract.e2e.test.ts",
          },
          { path: "tests/e2e/dashboard-preview.e2e.test.ts" },
          { path: "tests/e2e/dashboard-feed-pagination-window.e2e.test.ts" },
        ],
        message: commitMessage(
          "test(e2e): seed preview preferences before dashboard navigation",
          "- Preload preview preferences before hydration so dashboard e2e coverage starts from deterministic state.",
        ),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    // This replay guards the traced regression where broad dashboard-themed
    // e2e tests were attached to the feed-mutation implementation commit even
    // though they do not verify the same reload behavior.
    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: groups.flatMap((group) => group.files),
          message: commitMessage(
            "fix(dashboard): force fresh source reloads after feed mutations",
            "- Combine feed mutation reload changes with dashboard preview preference seeding coverage.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.message.split("\n")[0]).toBe(
      "fix(dashboard): force fresh source reloads after feed mutations",
    );
    expect(result[1]?.message.split("\n")[0]).toBe(
      "test(e2e): seed preview preferences before dashboard navigation",
    );
  });

  test("splitWeakConsolidations attaches standalone coherent test support to its matching rollout", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?standalone-test-support-attachment-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?standalone-test-support-attachment-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/step/build.ts" }, { path: "src/step/lint.ts" }],
        message: commitMessage(
          "refactor(steps): remove label from step contracts and use key",
          "- Rewires step builders and runtime output to use key as the single step identity.",
        ),
      },
      {
        files: [{ path: "src/quality/complexity/main.ts" }],
        message: commitMessage(
          "fix(complexity): resolve relative metric paths against run cwd",
          "- Resolves analyzer-reported relative file paths before AST matching.",
        ),
      },
      {
        files: [
          { path: "tests/helper-coverage-regression.test.ts" },
          { path: "tests/inline-ts.test.ts" },
          { path: "tests/suite-processing/batch.test.ts" },
          { path: "tests/suite-processing/execution.test.ts" },
          { path: "tests/suite-processing/selection.test.ts" },
        ],
        message: commitMessage(
          "test(step-config): align suite tests with key-only step identity",
          "- Removes label from step fixtures and assertions so tests reflect the key-centered contract.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/step/build.ts"),
      makeFile("src/step/lint.ts"),
      makeFile("src/quality/complexity/main.ts"),
      makeFile("tests/helper-coverage-regression.test.ts"),
      makeFile("tests/inline-ts.test.ts"),
      makeFile("tests/suite-processing/batch.test.ts"),
      makeFile("tests/suite-processing/execution.test.ts"),
      makeFile("tests/suite-processing/selection.test.ts"),
    ];

    const result = splitWeakConsolidations(
      groups,
      groups,
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.files).toEqual([
      { path: "src/step/build.ts" },
      { path: "src/step/lint.ts" },
      { path: "tests/helper-coverage-regression.test.ts" },
      { path: "tests/inline-ts.test.ts" },
      { path: "tests/suite-processing/batch.test.ts" },
      { path: "tests/suite-processing/execution.test.ts" },
      { path: "tests/suite-processing/selection.test.ts" },
    ]);
    expect(result[1]?.files).toEqual([
      { path: "src/quality/complexity/main.ts" },
    ]);
  });

  test("splitWeakConsolidations preserves broad style areas instead of collapsing them into one formatting bucket", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?broad-style-area-preserve-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?broad-style-area-preserve-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const moduleBoundaryFiles = [
      "src/quality/module-boundaries/analysis/layout.ts",
      "src/quality/module-boundaries/runner.ts",
      "src/quality/module-boundaries/scan/rules.ts",
      "src/runtime-config/state.ts",
    ];
    const runtimeFiles = [
      "src/suite-processing/runner.ts",
      "src/suite-processing/display.ts",
      "src/timeout/messages.ts",
      "src/timeout/resolution.ts",
    ];
    const formattingFiles = [
      "src/cli/main.ts",
      "src/cli/args/parser.ts",
      "src/format/strings.ts",
      "src/process/collectors.ts",
    ];
    const groups = [
      {
        files: moduleBoundaryFiles.map((path) => ({ path })),
        message: commitMessage(
          "style(module-boundaries): reformat analyzer and runtime config files",
          "- Apply consistent multiline wrapping across module-boundary analysis files.",
        ),
      },
      {
        files: runtimeFiles.map((path) => ({ path })),
        message: commitMessage(
          "style(runtime): normalize formatting and newline consistency",
          "- Apply formatting-only line wraps in suite runner and timeout modules.",
        ),
      },
      {
        files: formattingFiles.map((path) => ({ path })),
        message: commitMessage(
          "style(formatting): apply prettier wrapping across source files",
          "- Reflow long ternaries, unions, and call sites in CLI and utility modules.",
        ),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    const result = splitWeakConsolidations(
      groups,
      [
        {
          files: groups.flatMap((group) => group.files),
          message: commitMessage(
            "style(module-boundaries): reformat analyzer and runtime config files",
            "- Collapse unrelated formatter buckets into one broad style commit.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result.map((group: PlannedCommit) => group.files)).toEqual(
      groups.map((group) => group.files),
    );
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toEqual([
      "style(module-boundaries): reformat analyzer and runtime config files",
      "style(runtime): normalize formatting and newline consistency",
      "style(formatting): apply prettier wrapping across source files",
    ]);
  });

  test("splitWeakConsolidations splits multi-area style sinks before they become junk-drawer commits", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?multi-area-style-sink-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?multi-area-style-sink-split-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const sourceFiles = [
      "src/cli/output.ts",
      "src/cli/prompt.ts",
      "src/cli/session.ts",
    ];
    const testFiles = [
      "tests/output.test.ts",
      "tests/prompt.test.ts",
      "tests/session.test.ts",
      "tests/wrapping.test.ts",
    ];
    const files = [...sourceFiles, ...testFiles];
    const allFiles = files.map((path) => makeFile(path));

    const result = splitWeakConsolidations(
      [
        {
          files: files.map((path) => ({ path })),
          message: commitMessage(
            "style(codebase): normalize wrapping and newline endings",
            "- Reflow source helpers and test assertions without changing behavior.",
          ),
        },
      ],
      [
        {
          files: files.map((path) => ({ path })),
          message: commitMessage(
            "style(codebase): normalize wrapping and newline endings",
            "- Reflow source helpers and test assertions without changing behavior.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.files).toEqual(sourceFiles.map((path) => ({ path })));
    expect(result[1]?.files).toEqual(testFiles.map((path) => ({ path })));
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toEqual([
      "style(cli): normalize wrapping and newline endings",
      "style(tests): normalize wrapping and newline endings",
    ]);
  });

  test("splitWeakConsolidations re-scopes split style details to the covered baseline groups", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?style-detail-rescoping-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?style-detail-rescoping-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const sourceFiles = [
      "src/cli/main.ts",
      "src/cli/output-presentation.ts",
      "src/git/operations.ts",
    ];
    const testFiles = [
      "tests/cli.test.ts",
      "tests/output-presentation.test.ts",
      "tests/git-header.test.ts",
    ];
    const allFiles = [...sourceFiles, ...testFiles].map((path) =>
      makeFile(path),
    );

    const result = splitWeakConsolidations(
      [
        {
          files: sourceFiles.map((path) => ({ path })),
          message: commitMessage(
            "style(src): normalize wrapping and newline endings",
            "- Reflow source helpers and export wrappers.",
          ),
        },
        {
          files: testFiles.map((path) => ({ path })),
          message: commitMessage(
            "style(tests): normalize wrapping and newline endings",
            "- Reflow test assertions and fixture wrapping.",
          ),
        },
      ],
      [
        {
          files: [...sourceFiles, ...testFiles].map((path) => ({ path })),
          message: commitMessage(
            "style(codebase): normalize wrapping and newline endings",
            "- Reflow source helpers and export wrappers.",
            "- Reflow test assertions and fixture wrapping.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.message.split("\n")[0]).toBe(
      "style(src): normalize wrapping and newline endings",
    );
    expect(result[0]?.message).toContain(
      "- Reflow source helpers and export wrappers.",
    );
    expect(result[0]?.message).not.toContain(
      "- Reflow test assertions and fixture wrapping.",
    );
    expect(result[1]?.message.split("\n")[0]).toBe(
      "style(tests): normalize wrapping and newline endings",
    );
    expect(result[1]?.message).toContain(
      "- Reflow test assertions and fixture wrapping.",
    );
    expect(result[1]?.message).not.toContain(
      "- Reflow source helpers and export wrappers.",
    );
  });

  test("splitWeakConsolidations keeps git and commit-planning style sweeps in separate ownership buckets", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?git-vs-planning-style-sweep-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?git-vs-planning-style-sweep-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const gitFiles = [
      "src/git/diff.ts",
      "src/git/chunks.ts",
      "src/git/formatting.ts",
      "src/git/header.ts",
      "src/git/parser.ts",
      "src/git/patches.ts",
    ];
    const planningFiles = [
      "src/commit-planning/planning-workflow.ts",
      "src/commit-planning/planner-heuristics.ts",
      "src/commit-planning/output-text.ts",
      "src/commit-planning/overlap-resolution.ts",
      "src/commit-planning/grouping/group/stage.ts",
      "src/commit-planning/grouping/group/finalization.ts",
      "src/commit-planning/orchestration.ts",
      "src/commit-planning/response-validation.ts",
    ];
    const residualCliFiles = ["src/cli/fatal.ts"];
    const allFiles = [...gitFiles, ...planningFiles, ...residualCliFiles].map(
      (path) => makeFile(path),
    );

    const result = splitWeakConsolidations(
      [
        {
          files: [...gitFiles, ...planningFiles, ...residualCliFiles].map(
            (path) => ({ path }),
          ),
          message: commitMessage(
            "style(git): normalize diff utility formatting",
            "- Reflow long expressions, signatures, and wrapped helper calls without changing behavior.",
          ),
        },
      ],
      [
        {
          files: [...gitFiles, ...planningFiles, ...residualCliFiles].map(
            (path) => ({ path }),
          ),
          message: commitMessage(
            "style(git): normalize diff utility formatting",
            "- Reflow long expressions, signatures, and wrapped helper calls without changing behavior.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toHaveLength(3);
    const gitGroup = result.find(
      (group: PlannedCommit) =>
        group.message.split("\n")[0] ===
        "style(git): normalize diff utility formatting",
    );
    const planningGroup = result.find(
      (group: PlannedCommit) =>
        group.message.split("\n")[0] ===
        "style(commit-planning): normalize diff utility formatting",
    );
    const cliGroup = result.find(
      (group: PlannedCommit) =>
        group.message.split("\n")[0] ===
        "style(cli): normalize diff utility formatting",
    );

    expect(gitGroup?.files).toEqual(gitFiles.map((path) => ({ path })));
    expect(planningGroup?.files).toEqual(
      planningFiles.map((path) => ({ path })),
    );
    expect(cliGroup?.files).toEqual(residualCliFiles.map((path) => ({ path })));
    expect(
      result.some(
        (group: PlannedCommit) =>
          group.files.some((file) => file.path.startsWith("src/git/")) &&
          group.files.some((file) =>
            file.path.startsWith("src/commit-planning/"),
          ),
      ),
    ).toBe(false);
  });

  test("splitWeakConsolidations splits broad style sweeps by source feature and direct-file surfaces", async () => {
    const { splitWeakConsolidations } = await import(
      new URL(
        `../src/commit-planning/grouping/repartition.js?broad-style-owner-split-${Math.random()}`,
        import.meta.url,
      ).href
    );
    const { buildFileChangeSignals } = await import(
      new URL(
        `../src/commit-planning/grouping/file/index.js?broad-style-owner-split-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const files = [
      "README.md",
      "src/cli/args/parser.ts",
      "src/cli/args/selection/options.ts",
      "src/cli/main.ts",
      "src/quality/module-boundaries/analysis/layout.ts",
      "src/quality/module-boundaries/analysis/module-resolution.ts",
      "src/quality/module-boundaries/discovery/grouped-config.ts",
      "src/quality/module-boundaries/policy-inference.ts",
      "src/quality/module-boundaries/runner.ts",
      "src/quality/module-boundaries/scan/index.ts",
      "src/quality/module-boundaries/scan/rules.ts",
      "src/quality/module-boundaries/worker.ts",
      "src/runtime-config/config-files.ts",
      "src/runtime-config/state.ts",
      "src/suite-processing/display.ts",
      "src/suite-processing/runner.ts",
      "src/timeout/messages.ts",
    ];
    const allFiles = files.map((path) => makeFile(path));

    const result = splitWeakConsolidations(
      [
        {
          files: files.map((path) => ({ path })),
          message: commitMessage(
            "style(codebase): apply formatting and docstring cleanup sweep",
            "- Reflow unrelated formatting across CLI, quality, runtime, and docs files.",
          ),
        },
      ],
      [
        {
          files: files.map((path) => ({ path })),
          message: commitMessage(
            "style(codebase): apply formatting and docstring cleanup sweep",
            "- Reflow unrelated formatting across CLI, quality, runtime, and docs files.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    const moduleBoundaryFiles = files.filter((path) =>
      path.startsWith("src/quality/module-boundaries/"),
    );
    const moduleBoundaryGroup = result.find((group: PlannedCommit) =>
      group.message.startsWith("style(quality):"),
    );
    const cliGroup = result.find(
      (group: PlannedCommit) =>
        group.message.split("\n")[0] ===
        "style(cli): apply formatting and docstring cleanup sweep",
    );
    const runtimeConfigGroup = result.find((group: PlannedCommit) =>
      group.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "src/runtime-config/config-files.ts",
      ),
    );
    const suiteProcessingGroup = result.find(
      (group: PlannedCommit) =>
        group.message.split("\n")[0] ===
        "style(suite-processing): apply formatting and docstring cleanup sweep",
    );
    const timeoutGroup = result.find(
      (group: PlannedCommit) =>
        group.message.split("\n")[0] ===
        "style(timeout): apply formatting and docstring cleanup sweep",
    );
    const readmeGroup = result.find(
      (group: PlannedCommit) =>
        group.files.length === 1 && group.files[0]?.path === "README.md",
    );

    expect(moduleBoundaryGroup?.files).toEqual(
      moduleBoundaryFiles.map((path) => ({ path })),
    );
    expect(cliGroup?.files).toEqual([
      { path: "src/cli/args/parser.ts" },
      { path: "src/cli/args/selection/options.ts" },
      { path: "src/cli/main.ts" },
    ]);
    expect(runtimeConfigGroup?.files).toEqual([
      { path: "src/runtime-config/config-files.ts" },
      { path: "src/runtime-config/state.ts" },
    ]);
    expect(suiteProcessingGroup?.files).toEqual([
      { path: "src/suite-processing/display.ts" },
      { path: "src/suite-processing/runner.ts" },
    ]);
    expect(timeoutGroup?.files).toEqual([{ path: "src/timeout/messages.ts" }]);
    expect(readmeGroup?.files).toEqual([{ path: "README.md" }]);
    expect(readmeGroup?.message.split("\n")[0]).toBe(
      "style(readme-md): apply formatting and docstring cleanup sweep",
    );
    expect(result).toHaveLength(6);
  });

  test("finalizePlannedGroups rejects umbrella consolidation that repartition would mostly undo", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("reject-unstable-consolidation"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/commit-planning/result-cache.ts" },
                      {
                        path: "src/commit-planning/prompts/stages/plan-consolidation.ts",
                      },
                      { path: "src/commit-planning/token-estimation.ts" },
                      { path: "tests/ai.test.ts" },
                    ],
                    message:
                      "fix(commit-planning): harden planner orchestration rollout\n\n- Fold cache, prompt, budget, and test changes into one broad umbrella update.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const observer = await import("../src/commit-planning/openai-client.js");
    const events: { content: string; kind?: string; stage: string }[] = [];
    observer.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?reject-unstable-consolidation-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/commit-planning/result-cache.ts" }],
        message: commitMessage(
          "feat(ai-cache): cache planned commit analysis",
          "- Reuse grouped plans for identical diff inputs.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/prompts/stages/plan-consolidation.ts",
          },
        ],
        message: commitMessage(
          "fix(prompts): tighten consolidation ownership rules",
          "- Keep consolidation focused on one clear why per commit.",
        ),
      },
      {
        files: [{ path: "src/commit-planning/token-estimation.ts" }],
        message: commitMessage(
          "fix(token-estimation): buffer consolidation budgeting",
          "- Reduce underestimation risk during planner calls.",
        ),
      },
      {
        files: [{ path: "tests/ai.test.ts" }],
        message: commitMessage(
          "test(prompts): lock consolidation ownership guidance",
          "- Cover the tighter why-first consolidation wording.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/result-cache.ts"),
      makeFile("src/commit-planning/prompts/stages/plan-consolidation.ts"),
      makeFile("src/commit-planning/token-estimation.ts"),
      makeFile("tests/ai.test.ts"),
    ];

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat).toHaveLength(1);
    expect(result).toHaveLength(4);
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toContain("feat(ai-cache): cache planned commit analysis");
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toContain("fix(prompts): tighten consolidation ownership rules");
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toContain("fix(token-estimation): buffer consolidation budgeting");
    expect(
      result.map((group: PlannedCommit) => group.message.split("\n")[0]),
    ).toContain("test(prompts): lock consolidation ownership guidance");
    expect(events.length > 0).toBe(true);
    observer.setAiOutputObserver(null);
  });

  test("finalizePlannedGroups rejects a late commit-planning mega-umbrella when repartition still fans back out across prompt, path, bundle, grouping, and cli rollouts", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("reject-commit-planning-mega-umbrella"),
        model: "gpt-5.3-codex",
      },
    });
    const umbrellaFiles = [
      {
        path: "src/commit-planning/grouping/subject/premerge/index.ts",
      },
      {
        path: "src/commit-planning/grouping/subject/premerge/service.ts",
      },
      {
        path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
      },
      {
        path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
      },
      {
        path: "src/commit-planning/grouping/support-attachment/index.ts",
      },
      {
        path: "src/commit-planning/grouping/support-attachment/scoring.ts",
      },
      { path: "src/cli/execution-flow.ts" },
      { path: "src/cli/index.ts" },
      { path: "src/cli/interactive-prompt.ts" },
      { path: "src/cli/main.ts" },
      { path: "src/cli/options.ts" },
      {
        path: "src/commit-planning/grouping/support-attachment/selection.ts",
      },
      {
        path: "src/commit-planning/grouping/support-attachment/single-owner-anchor.ts",
      },
      {
        path: "src/commit-planning/grouping/support-attachment/test-ownership.ts",
      },
      {
        path: "src/commit-planning/grouping/surface-rollout-shape.ts",
      },
      {
        path: "src/commit-planning/prompt-builders/cluster-prompts.ts",
      },
      {
        path: "src/commit-planning/prompt-builders/commit-format.ts",
      },
      {
        path: "src/commit-planning/prompt-builders/consolidation-prompts.ts",
      },
      {
        path: "src/commit-planning/prompt-builders/generation-prompts.ts",
      },
      {
        path: "src/commit-planning/prompt-builders/grouping-prompts.ts",
      },
      {
        path: "src/commit-planning/prompts/context/diff-context.ts",
      },
      { path: "src/commit-planning/prompts/index.ts" },
      {
        path: "src/commit-planning/prompts/rules/cluster-merge.ts",
      },
      {
        path: "src/commit-planning/prompts/rules/commit/generation.ts",
      },
      {
        path: "src/commit-planning/prompts/rules/commit/index.ts",
      },
      {
        path: "src/commit-planning/prompts/rules/commit/message.ts",
      },
      {
        path: "src/commit-planning/prompts/rules/formatting.ts",
      },
      {
        path: "src/commit-planning/prompts/rules/hunk-grouping.ts",
      },
      { path: "src/commit-planning/path/structure.ts" },
      { path: "src/commit-planning/plan-bundles/hashes.ts" },
      { path: "src/commit-planning/plan-bundles/index.ts" },
      { path: "src/commit-planning/plan-bundles/schemas.ts" },
      { path: "src/commit-planning/plan-bundles/service.ts" },
      { path: "src/commit-planning/plan-bundles/storage.ts" },
      { path: "src/commit-planning/planned-commit-clone.ts" },
      { path: "src/commit-planning/planning-workflow.ts" },
      { path: "src/commit-planning/path-resolver.ts" },
      { path: "src/commit-planning/path/aliases.ts" },
      { path: "src/commit-planning/path/index.ts" },
      {
        path: "src/commit-planning/path/repository-structure.ts",
      },
      { path: "src/commit-planning/path/resolver.ts" },
      {
        path: "src/commit-planning/grouping/baseline-restoration.ts",
      },
      { path: "src/commit-planning/grouping/dependency/rules.ts" },
      { path: "src/commit-planning/grouping/file/extraction.ts" },
      {
        path: "src/commit-planning/grouping/style-splitting/service.ts",
      },
      { path: "src/commit-planning/orchestration.ts" },
      { path: "src/commit-planning/output-text.ts" },
      { path: "src/commit-planning/overlap-resolution.ts" },
      { path: "src/commit-planning/prompts/rules/index.ts" },
      {
        path: "src/commit-planning/prompts/rules/plan-consolidation.ts",
      },
      {
        path: "src/commit-planning/prompts/rules/semantic-planning.ts",
      },
      { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
      { path: "src/commit-planning/prompts/stages/commit-generation.ts" },
      { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
      { path: "src/commit-planning/prompts/stages/index.ts" },
      { path: "src/commit-planning/prompts/stages/plan-consolidation.ts" },
      { path: "src/commit-planning/response-validation.ts" },
      { path: "src/commit-planning/result-cache.ts" },
      { path: "src/commit-planning/token-estimation.ts" },
      { path: "tests/plan-bundles.test.ts" },
    ];
    const umbrellaMessage =
      "feat(commit-planning): add modular prompt stages and breaking-aware planning\n\n- Fold prompt stages, path aliases, plan bundles, support routing, and CLI resume flows into one umbrella feature.\n- Thread breaking-aware planning and shared prompt mode behavior through the same broad planning rollout.";
    const identityClusters = Array.from({ length: 10 }, (_, index) => [index]);
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify(identityClusters),
              },
            },
          ],
        },
        ...Array.from({ length: 5 }, () => ({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: umbrellaFiles,
                    message: umbrellaMessage,
                  },
                ]),
              },
            },
          ],
        })),
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?reject-commit-planning-mega-umbrella-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/commit-planning/grouping/subject/premerge/index.ts" },
          {
            path: "src/commit-planning/grouping/subject/premerge/service.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
          },
          { path: "src/commit-planning/grouping/support-attachment/index.ts" },
          {
            path: "src/commit-planning/grouping/support-attachment/scoring.ts",
          },
        ],
        message: commitMessage(
          "feat(grouping): add deterministic premerge and support attachment",
          "- Keep subject premerge clustering and core support attachment routing together.",
        ),
      },
      {
        files: [
          { path: "src/cli/execution-flow.ts" },
          { path: "src/cli/index.ts" },
          { path: "src/cli/interactive-prompt.ts" },
          { path: "src/cli/main.ts" },
          { path: "src/cli/options.ts" },
        ],
        message: commitMessage(
          "feat(cli): add resumable plan bundles and resume selection flags",
          "- Keep resume command wiring and selection parsing on the CLI surface.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/support-attachment/selection.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/single-owner-anchor.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/test-ownership.ts",
          },
          { path: "src/commit-planning/grouping/surface-rollout-shape.ts" },
        ],
        message: commitMessage(
          "feat(grouping): add support-attachment ownership heuristics",
          "- Keep ownership rejection and rollout-shape heuristics on the grouping surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/prompt-builders/cluster-prompts.ts" },
          { path: "src/commit-planning/prompt-builders/commit-format.ts" },
          {
            path: "src/commit-planning/prompt-builders/consolidation-prompts.ts",
          },
          {
            path: "src/commit-planning/prompt-builders/generation-prompts.ts",
          },
          {
            path: "src/commit-planning/prompt-builders/grouping-prompts.ts",
          },
          { path: "src/commit-planning/prompts/context/diff-context.ts" },
          { path: "src/commit-planning/prompts/index.ts" },
          { path: "src/commit-planning/prompts/rules/cluster-merge.ts" },
          {
            path: "src/commit-planning/prompts/rules/commit/generation.ts",
          },
          { path: "src/commit-planning/prompts/rules/commit/index.ts" },
          { path: "src/commit-planning/prompts/rules/commit/message.ts" },
          { path: "src/commit-planning/prompts/rules/formatting.ts" },
          { path: "src/commit-planning/prompts/rules/hunk-grouping.ts" },
        ],
        message: commitMessage(
          "refactor(prompts): centralize prompt rules into reusable modules",
          "- Keep prompt builders, prompt rules, and prompt entrypoints on the prompts surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/path/structure.ts" },
          { path: "src/commit-planning/plan-bundles/hashes.ts" },
          { path: "src/commit-planning/plan-bundles/index.ts" },
          { path: "src/commit-planning/plan-bundles/schemas.ts" },
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/plan-bundles/storage.ts" },
          { path: "src/commit-planning/planned-commit-clone.ts" },
          { path: "src/commit-planning/planning-workflow.ts" },
        ],
        message: commitMessage(
          "feat(planning): add persisted plan bundles with integrity checks",
          "- Keep bundle persistence, hashing, storage, and cloned-plan workflow changes together.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/path-resolver.ts" },
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/index.ts" },
          {
            path: "src/commit-planning/path/repository-structure.ts",
          },
          { path: "src/commit-planning/path/resolver.ts" },
        ],
        message: commitMessage(
          "feat(path): expand file alias resolution across repo path shapes",
          "- Keep alias, repository-structure, and path-resolver work together.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/baseline-restoration.ts",
          },
          { path: "src/commit-planning/grouping/dependency/rules.ts" },
          { path: "src/commit-planning/grouping/file/extraction.ts" },
        ],
        message: commitMessage(
          "feat(grouping): strengthen baseline restoration and alias-aware signals",
          "- Keep baseline restoration, alias extraction, and dependency rules on the grouping surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/style-splitting/service.ts" },
        ],
        message: commitMessage(
          "feat(grouping): split broad style commits by ownership boundaries",
          "- Keep style repartitioning isolated from neighboring rollout work.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/orchestration.ts" },
          { path: "src/commit-planning/output-text.ts" },
          { path: "src/commit-planning/overlap-resolution.ts" },
        ],
        message: commitMessage(
          "fix(planning): honor breaking-change mode through commit generation",
          "- Keep orchestration, output-text, and overlap-resolution changes together.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/prompts/rules/index.ts" },
          {
            path: "src/commit-planning/prompts/rules/plan-consolidation.ts",
          },
          {
            path: "src/commit-planning/prompts/rules/semantic-planning.ts",
          },
          { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
          {
            path: "src/commit-planning/prompts/stages/commit-generation.ts",
          },
          { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
          { path: "src/commit-planning/prompts/stages/index.ts" },
          {
            path: "src/commit-planning/prompts/stages/plan-consolidation.ts",
          },
          { path: "src/commit-planning/response-validation.ts" },
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
        ],
        message: commitMessage(
          "feat(commit-planning): add modular prompt stages and breaking-aware planning",
          "- Keep prompt stages, prompt rules, validation, caching, and token estimation together.",
        ),
      },
      {
        files: [{ path: "tests/plan-bundles.test.ts" }],
        message: commitMessage(
          "test(plan-bundles): add end-to-end coverage for persisted resume data",
          "- Keep saved-plan bundle coverage isolated from production rollout commits.",
        ),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    const result = await finalizePlannedGroups(allFiles, groups);

    expect(calls.chat.length).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeGreaterThan(6);
    expect(
      result.some(
        (group: PlannedCommit) =>
          group.files.some(
            (file) => file.path === "src/cli/execution-flow.ts",
          ) &&
          group.files.some(
            (file) =>
              file.path ===
              "src/commit-planning/prompts/stages/plan-consolidation.ts",
          ),
      ),
    ).toBe(false);
    expect(
      result.some(
        (group: PlannedCommit) =>
          group.files.some(
            (file) => file.path === "src/commit-planning/path/aliases.ts",
          ) &&
          group.files.some(
            (file) =>
              file.path === "src/commit-planning/plan-bundles/service.ts",
          ) &&
          group.files.some(
            (file) => file.path === "src/commit-planning/result-cache.ts",
          ),
      ),
    ).toBe(false);
    const planBundleCliCrossMerge = result
      .filter(
        (group: PlannedCommit) =>
          group.files.some(
            (file) => file.path === "tests/plan-bundles.test.ts",
          ) &&
          group.files.some((file) => file.path === "src/cli/execution-flow.ts"),
      )
      .map((group: PlannedCommit) =>
        group.files.map((file) => file.path).sort(),
      );
    expect(planBundleCliCrossMerge).toEqual([]);
    expect(
      result.some(
        (group: PlannedCommit) =>
          group.files.some(
            (file) =>
              file.path ===
              "src/commit-planning/grouping/style-splitting/service.ts",
          ) &&
          group.files.some(
            (file) =>
              file.path === "src/commit-planning/plan-bundles/service.ts",
          ) &&
          group.files.some(
            (file) => file.path === "src/commit-planning/path/aliases.ts",
          ),
      ),
    ).toBe(false);
  });

  test("finalizePlannedGroups keeps runtime telemetry separate from cli trace presentation", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-runtime-from-cli"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/commit-planning/openai-client.ts" },
                      { path: "src/commit-planning/orchestration.ts" },
                      { path: "src/cli/main.ts" },
                      { path: "src/cli/verbose-output.ts" },
                      { path: "tests/verbose-output.test.ts" },
                    ],
                    message:
                      "feat(ai): add stage tracing and terminal presentation\n\n- Combine runtime telemetry plumbing with CLI trace rendering.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-runtime-from-cli-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/commit-planning/openai-client.ts" },
          { path: "src/commit-planning/orchestration.ts" },
        ],
        message: commitMessage(
          "feat(ai-client): track stage-level token usage",
          "- Record stage attribution and AI output events.",
        ),
      },
      {
        files: [
          { path: "src/cli/main.ts" },
          { path: "src/cli/verbose-output.ts" },
          { path: "tests/verbose-output.test.ts" },
        ],
        message: commitMessage(
          "feat(cli): render trace output in the terminal",
          "- Show raw AI payloads with readable CLI formatting.",
        ),
      },
    ];

    const cliFile = makeFile("src/cli/main.ts");
    cliFile.hunks[0]!.lines = [
      " import { setAiOutputObserver } from './ai-commit-orchestration.js'",
      "+setAiOutputObserver(logVerboseAiOutput)",
    ];

    const result: PlannedCommit[] = await finalizePlannedGroups(
      [
        makeFile("src/commit-planning/openai-client.ts"),
        makeFile("src/commit-planning/orchestration.ts"),
        cliFile,
        makeFile("src/cli/verbose-output.ts"),
        makeFile("tests/verbose-output.test.ts"),
      ],
      groups,
    );

    expect(result).toHaveLength(2);
    expect(result).toEqual(groups);
  });

  test("finalizePlannedGroups keeps cache outputs separate from stage telemetry", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-cache-from-telemetry"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/commit-planning/result-cache.ts" },
                      { path: "src/commit-planning/openai-client.ts" },
                      { path: "src/commit-planning/orchestration.ts" },
                      { path: "tests/ai-coverage.test.ts" },
                    ],
                    message:
                      "feat(ai): add stage-aware telemetry and cache planned outputs\n\n- Combine plan caching with stage observability for the planning pipeline.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-cache-from-telemetry-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/commit-planning/result-cache.ts" },
          { path: "tests/ai-coverage.test.ts" },
        ],
        message: commitMessage(
          "feat(ai-cache): cache commit grouping plans",
          "- Reuse identical planning outputs across repeated runs.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/openai-client.ts" },
          { path: "src/commit-planning/orchestration.ts" },
        ],
        message: commitMessage(
          "feat(ai-client): track stage-level token usage",
          "- Surface per-stage telemetry and AI output events.",
        ),
      },
    ];

    const aiFile = makeFile("src/commit-planning/orchestration.ts");
    aiFile.hunks[0]!.lines = [
      " import { getPlanCache, setPlanCache } from './ai-result-cache.js'",
      "+setPlanCache(cacheKey, result)",
    ];

    const result: PlannedCommit[] = await finalizePlannedGroups(
      [
        makeFile("src/commit-planning/result-cache.ts"),
        makeFile("src/commit-planning/openai-client.ts"),
        aiFile,
        makeFile("tests/ai-coverage.test.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual(groups);
  });

  test("finalizePlannedGroups does not attach broad ai coverage to mixed cache runtime commits", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-broad-coverage-from-mixed-cache-runtime"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/commit-planning/result-cache.ts" },
                      {
                        hunks: [0],
                        path: "src/commit-planning/orchestration.ts",
                      },
                      {
                        path: "src/commit-planning/grouping/index.ts",
                      },
                      { path: "tests/ai-coverage.test.ts" },
                    ],
                    message:
                      "feat(ai): harden planning cache and grouping coverage\n\n- Combine runtime caching, grouping heuristics, and regression coverage into one planner update.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-broad-coverage-from-mixed-cache-runtime-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const aiFile = makeFile("src/commit-planning/orchestration.ts");
    aiFile.hunks[0]!.lines = [
      " import { getCachedPlan } from './ai-result-cache.js'",
      "+const cachedPlan = getCachedPlan(cacheKey)",
    ];

    const groups = [
      {
        files: [
          { path: "src/commit-planning/result-cache.ts" },
          { hunks: [0], path: "src/commit-planning/orchestration.ts" },
        ],
        message: commitMessage(
          "feat(ai-cache): cache planned outputs",
          "- Reuse serialized planning results before recomputing batch output.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/index.ts",
          },
        ],
        message: commitMessage(
          "feat(planned-commit-grouping): preserve dependency order",
          "- Keep helper commits ahead of their first consumers.",
        ),
      },
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message: commitMessage(
          "test(ai): expand planning coverage",
          "- Cover cache reuse, dependency ordering, and consolidation boundaries.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        makeFile("src/commit-planning/result-cache.ts"),
        aiFile,
        makeFile("src/commit-planning/grouping/index.ts"),
        makeFile("tests/ai-coverage.test.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(
      result.some((group: { files: { path: string }[] }) => {
        const paths = new Set(
          group.files.map((file: { path: string }) => file.path),
        );
        return (
          paths.has("tests/ai-coverage.test.ts") &&
          paths.has("src/commit-planning/result-cache.ts") &&
          paths.has("src/commit-planning/orchestration.ts")
        );
      }),
    ).toBe(false);
  });

  test("finalizePlannedGroups keeps cache, estimation, and validation reasons separate", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-cache-estimate-validate"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/commit-planning/result-cache.ts" },
                      { path: "src/commit-planning/token-estimation.ts" },
                      { path: "src/commit-planning/response-validation.ts" },
                      { path: "src/commit-planning/orchestration.ts" },
                    ],
                    message:
                      "feat(planning): estimate and cache multi-pass workflows\n\n- Combine caching, estimation, and validation hardening for planning.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-cache-estimate-validate-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/commit-planning/result-cache.ts" }],
        message: commitMessage(
          "feat(ai-cache): cache commit plans",
          "- Reuse equivalent planning runs from persisted plan outputs.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/token-estimation.ts" },
          { path: "src/commit-planning/orchestration.ts" },
        ],
        message: commitMessage(
          "feat(planning): estimate multi-pass planning costs",
          "- Predict grouping and consolidation follow-up request sizes.",
        ),
      },
      {
        files: [{ path: "src/commit-planning/response-validation.ts" }],
        message: commitMessage(
          "fix(ai-validation): dedupe repeated file entries",
          "- Keep normalized plan coverage deterministic and structurally valid.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        makeFile("src/commit-planning/result-cache.ts"),
        makeFile("src/commit-planning/token-estimation.ts"),
        makeFile("src/commit-planning/response-validation.ts"),
        makeFile("src/commit-planning/orchestration.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual(groups);
  });

  test("finalizePlannedGroups keeps grouping, prompts, helper, and cli fixes separate", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-grouping-prompts-helper-cli"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      {
                        path: "src/commit-planning/grouping/index.ts",
                      },
                      {
                        path: "src/commit-planning/prompts/index.ts",
                      },
                      { path: "src/commit-messages/subject-parser.ts" },
                      { path: "src/cli/main.ts" },
                    ],
                    message:
                      "feat(planned-commit-grouping): harden grouping, prompt, helper, and cli review flow\n\n- Combine planner heuristics, prompt guidance, subject parsing, and confirmation fixes.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-grouping-prompts-helper-cli-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/index.ts",
          },
        ],
        message: commitMessage(
          "feat(planned-commit-grouping): make clustering dependency-aware",
          "- Split weak merge groups and order resulting commits safely.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/prompts/index.ts",
          },
        ],
        message: commitMessage(
          "refactor(prompts): harden intent-first merge guidance",
          "- Keep final consolidation centered on one clear why.",
        ),
      },
      {
        files: [{ path: "src/commit-messages/subject-parser.ts" }],
        message: commitMessage(
          "feat(subject-parser): add subject parsing helpers",
          "- Normalize subject words for downstream planner analysis.",
        ),
      },
      {
        files: [{ path: "src/cli/main.ts" }],
        message: commitMessage(
          "fix(cli): stop timing out interactive confirmations",
          "- Keep manual review prompts stable during slower operator flows.",
        ),
      },
    ];

    const groupingFile = makeFile("src/commit-planning/grouping/index.ts");
    groupingFile.hunks[0]!.lines = [
      " import { parseConventionalSubject } from '../../commit-messages/subject-parser.js'",
      "+const subject = parseConventionalSubject(message)",
    ];

    const result = await finalizePlannedGroups(
      [
        groupingFile,
        makeFile("src/commit-planning/prompts/index.ts"),
        makeFile("src/commit-messages/subject-parser.ts"),
        makeFile("src/cli/main.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toHaveLength(4);
    const promptsIndex = result.findIndex((group: PlannedCommit) =>
      group.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "src/commit-planning/prompts/index.ts",
      ),
    );
    const subjectParserIndex = result.findIndex((group: PlannedCommit) =>
      group.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "src/commit-messages/subject-parser.ts",
      ),
    );
    const groupingIndex = result.findIndex((group: PlannedCommit) =>
      group.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "src/commit-planning/grouping/index.ts",
      ),
    );
    expect(promptsIndex).toBeLessThan(groupingIndex);
    expect(subjectParserIndex).toBeLessThan(groupingIndex);
    expect(
      result.some((group: PlannedCommit) =>
        group.files.some(
          (file: PlannedCommit["files"][number]) =>
            file.path === "src/cli/main.ts",
        ),
      ),
    ).toBe(true);
  });

  test("finalizePlannedGroups rejects a repeated prompt-builder umbrella family and restores ownership slices", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("reject-prompt-builder-umbrella-family"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      {
                        path: "src/commit-planning/prompt-builders/commit-format.ts",
                      },
                      {
                        path: "src/commit-planning/prompt-builders/grouping-prompts.ts",
                      },
                      { path: "src/commit-planning/prompts/index.ts" },
                      {
                        path: "src/commit-planning/prompts/context/diff-context.ts",
                      },
                      { path: "src/commit-planning/grouping/index.ts" },
                      { path: "src/commit-planning/ai-file-paths.ts" },
                      { path: "src/commit-planning/orchestration.ts" },
                    ],
                    message:
                      "refactor(planning): centralize reusable commit-planning rule blocks\n\n- Combine prompt-builders, prompts, grouping surfaces, and planning helpers into one module-ownership sweep.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const observer = await import("../src/commit-planning/openai-client.js");
    const events: { content: string; kind?: string; stage: string }[] = [];
    observer.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?reject-prompt-builder-umbrella-family-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/prompt-builders/commit-format.ts",
          },
          {
            path: "src/commit-planning/prompt-builders/grouping-prompts.ts",
          },
        ],
        message: commitMessage(
          "refactor(src/commit-planning/prompt-builders): centralize reusable commit-planning rule blocks",
          "- Replace stage-specific prompt-builder modules with shared rule factories.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/prompts/index.ts" },
          { path: "src/commit-planning/prompts/context/diff-context.ts" },
        ],
        message: commitMessage(
          "refactor(src/commit-planning/prompts): centralize reusable commit-planning rule blocks",
          "- Move diff-context helpers under the prompts surface.",
        ),
      },
      {
        files: [{ path: "src/commit-planning/grouping/index.ts" }],
        message: commitMessage(
          "refactor(src/commit-planning/grouping): centralize reusable commit-planning rule blocks",
          "- Keep grouping exports aligned with the reorganized module layout.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/ai-file-paths.ts" },
          { path: "src/commit-planning/orchestration.ts" },
        ],
        message: commitMessage(
          "refactor(src/commit-planning): centralize reusable commit-planning rule blocks",
          "- Rewire planning helpers without changing planner behavior.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        makeFile("src/commit-planning/prompt-builders/commit-format.ts"),
        makeFile("src/commit-planning/prompt-builders/grouping-prompts.ts"),
        makeFile("src/commit-planning/prompts/index.ts"),
        makeFile("src/commit-planning/prompts/context/diff-context.ts"),
        makeFile("src/commit-planning/grouping/index.ts"),
        makeFile("src/commit-planning/ai-file-paths.ts"),
        makeFile("src/commit-planning/orchestration.ts"),
      ],
      groups,
    );

    expect(calls.chat.length).toBeGreaterThanOrEqual(1);
    expect(result).toHaveLength(4);
    expect(
      result.some((group: PlannedCommit) =>
        group.files.every((file: PlannedCommit["files"][number]) =>
          file.path.startsWith("src/commit-planning/prompt-builders/"),
        ),
      ),
    ).toBe(true);
    expect(
      result.some((group: PlannedCommit) =>
        group.files.every((file: PlannedCommit["files"][number]) =>
          file.path.startsWith("src/commit-planning/prompts/"),
        ),
      ),
    ).toBe(true);
    expect(
      result.some((group: PlannedCommit) =>
        group.files.some(
          (file: PlannedCommit["files"][number]) =>
            file.path === "src/commit-planning/grouping/index.ts",
        ),
      ),
    ).toBe(true);
    expect(
      result.some((group: PlannedCommit) =>
        group.files.some(
          (file: PlannedCommit["files"][number]) =>
            file.path === "src/commit-planning/orchestration.ts",
        ),
      ),
    ).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    observer.setAiOutputObserver(null);
  });

  test("finalizePlannedGroups keeps a repeated stage-builder umbrella family from spreading across unrelated ownership roots", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("reject-stage-builder-umbrella-family"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/commit-planning/path/aliases.ts" },
                      { path: "src/commit-planning/path/resolver.ts" },
                      {
                        path: "src/commit-planning/prompts/stages/cluster-merge.ts",
                      },
                      {
                        path: "src/commit-planning/prompts/stages/hunk-grouping.ts",
                      },
                      { path: "src/cli/options.ts" },
                      { path: "tests/ai-coverage.test.ts" },
                    ],
                    message:
                      "feat(planning): add stage-specific prompt builders and modes\n\n- Combine path resolution, prompt stages, CLI mode wiring, and coverage into one broad planning rollout.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?reject-stage-builder-umbrella-family-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/resolver.ts" },
        ],
        message: commitMessage(
          "feat(src/commit-planning/path): add stage-specific prompt builders and modes",
          "- Resolve flattened and virtual planner file aliases.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
          { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
        ],
        message: commitMessage(
          "feat(src/commit-planning/prompts): add stage-specific prompt builders and modes",
          "- Keep stage-specific prompt builders on the prompts surface.",
        ),
      },
      {
        files: [
          { path: "src/cli/options.ts" },
          { path: "tests/ai-coverage.test.ts" },
        ],
        message: commitMessage(
          "feat(cli): add stage-specific prompt builders and modes",
          "- Thread planner mode selection through CLI options and coverage.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        makeFile("src/commit-planning/path/aliases.ts"),
        makeFile("src/commit-planning/path/resolver.ts"),
        makeFile("src/commit-planning/prompts/stages/cluster-merge.ts"),
        makeFile("src/commit-planning/prompts/stages/hunk-grouping.ts"),
        makeFile("src/cli/options.ts"),
        makeFile("tests/ai-coverage.test.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual(groups);
  });

  test("finalizePlannedGroups keeps planner rollout slices separate across distinct ownership roots", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-planner-rollout-slices"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      {
                        path: "src/commit-planning/prompts/rules/index.ts",
                      },
                      {
                        path: "src/commit-planning/grouping/support-attachment/scoring.ts",
                      },
                      { path: "src/commit-planning/orchestration.ts" },
                      { path: "src/cli/main.ts" },
                      { path: "tests/ai-coverage.test.ts" },
                    ],
                    message:
                      "feat(commit-planning): ship one breaking-mode planner rollout\n\n- Combine prompt rules, support attachment, orchestration, cli flags, and coverage in one planner-wide change.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-planner-rollout-slices-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/prompts/rules/index.ts",
          },
        ],
        message: commitMessage(
          "feat(prompts): centralize breaking-mode rule composition",
          "- Reuse one staged rules surface across planner prompts.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/support-attachment/scoring.ts",
          },
        ],
        message: commitMessage(
          "feat(grouping): score support attachment by structural ownership",
          "- Keep support commits attached only when one owner is decisively stronger.",
        ),
      },
      {
        files: [{ path: "src/commit-planning/orchestration.ts" }],
        message: commitMessage(
          "feat(orchestration): thread breaking mode through planner execution",
          "- Keep planning and message generation aligned on release-impact mode.",
        ),
      },
      {
        files: [{ path: "src/cli/main.ts" }],
        message: commitMessage(
          "feat(cli): expose breaking-mode planner flags",
          "- Let operators choose planner release-impact sensitivity from the CLI.",
        ),
      },
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message: commitMessage(
          "test(ai): cover planner rollout boundaries",
          "- Lock broad breaking-mode planner slices to separate ownership roots.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        makeFile("src/commit-planning/prompts/rules/index.ts"),
        makeFile("src/commit-planning/grouping/support-attachment/scoring.ts"),
        makeFile("src/commit-planning/orchestration.ts"),
        makeFile("src/cli/main.ts"),
        makeFile("tests/ai-coverage.test.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual(groups);
  });

  test("callCluster salvages non-overlapping cluster indexes when one cluster repeats an index", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("duplicate-cluster-salvage"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  [0, 1],
                  [2, 3],
                  [3],
                  [4, 5],
                  [6, 7],
                  [8, 9],
                ]),
              },
            },
          ],
        },
      ],
    });
    const observer = await import("../src/commit-planning/openai-client.js");
    const events: { content: string; kind?: string; stage: string }[] = [];
    observer.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });
    const { callCluster } = await import(
      new URL(
        `../src/commit-planning/grouping/group/stage.js?duplicate-cluster-salvage-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = Array.from({ length: 10 }, (_, index) => ({
      files: [
        {
          path:
            index % 2 === 0
              ? `src/area-${String(index)}/workflow.ts`
              : `tests/area-${String(index - 1)}/workflow.test.ts`,
        },
      ],
      message: commitMessage(
        index % 2 === 0
          ? `feat(area-${String(index)}): add workflow support`
          : `test(area-${String(index - 1)}): cover workflow support`,
        `- Preserve workflow support slice ${String(index)}.`,
      ),
    }));

    const result = await callCluster(
      groups,
      () => "Cluster these commits.",
      () => "Return cluster JSON.",
    );

    expect(calls.chat).toHaveLength(1);
    expect(result).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [8, 9],
    ]);
    expect(
      events.some((event) =>
        event.content.includes('"decision":"cluster-partial-salvage"'),
      ),
    ).toBe(true);
    expect(
      events.some((event) =>
        event.content.includes('"decision":"cluster-fallback"'),
      ),
    ).toBe(false);
    observer.setAiOutputObserver(null);
  });

  test("harmonizeConsolidatedMessages restores coverage-scoped text when a split group inherits broad wording", async () => {
    const { harmonizeConsolidatedMessages } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?coverage-scoped-consolidation-messages-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/domain/parser.ts" }],
        message: commitMessage(
          "feat(parser): add structured input parsing",
          "- Parse structured input into normalized domain records.",
        ),
      },
      {
        files: [{ path: "tests/domain/parser.test.ts" }],
        message: commitMessage(
          "test(parser): cover structured input parsing",
          "- Verify structured input normalization behavior.",
        ),
      },
      {
        files: [{ path: "src/workflow/resume-store.ts" }],
        message: commitMessage(
          "feat(resume): persist workflow checkpoints",
          "- Store resumable workflow checkpoints for later execution.",
        ),
      },
      {
        files: [{ path: "tests/workflow/resume-store.test.ts" }],
        message: commitMessage(
          "test(resume): cover checkpoint persistence",
          "- Verify resumable checkpoint storage behavior.",
        ),
      },
    ];

    const allFiles = groups.map((group) => makeFile(group.files[0]!.path));
    const result = harmonizeConsolidatedMessages(
      groups,
      [
        {
          files: [
            { path: "src/domain/parser.ts" },
            { path: "tests/domain/parser.test.ts" },
          ],
          message: commitMessage(
            "feat(runtime): add parser and resume storage workflows",
            "- Combine parser behavior, parser coverage, resume persistence, and resume coverage into one rollout.",
          ),
        },
        {
          files: [
            { path: "src/workflow/resume-store.ts" },
            { path: "tests/workflow/resume-store.test.ts" },
          ],
          message: commitMessage(
            "feat(runtime): add parser and resume storage workflows",
            "- Combine parser behavior, parser coverage, resume persistence, and resume coverage into one rollout.",
          ),
        },
      ],
      new Map(allFiles.map((file) => [file.path, file])),
    );
    const parserGroup = result.find((group: PlannedCommit) =>
      group.files.some((file) => file.path === "src/domain/parser.ts"),
    );
    const resumeGroup = result.find((group: PlannedCommit) =>
      group.files.some((file) => file.path === "src/workflow/resume-store.ts"),
    );

    expect(result).toHaveLength(2);
    expect(parserGroup?.message).toContain(
      "feat(parser): add structured input parsing",
    );
    expect(parserGroup?.message).not.toContain("resume");
    expect(resumeGroup?.message).toContain(
      "feat(resume): persist workflow checkpoints",
    );
    expect(resumeGroup?.message).not.toContain("parser");
  });

  test("harmonizeConsolidatedMessages deduplicates repeated merged detail bullets", async () => {
    const { harmonizeConsolidatedMessages } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?dedupe-merged-bullets-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const repeatedBullet =
      "- Keep planner ownership boundaries stable across split and merge passes.";
    const originalGroups = [
      {
        files: [{ path: "src/commit-planning/grouping/group/finalization.ts" }],
        message: commitMessage(
          "fix(grouping): stabilize finalization ownership boundaries",
          repeatedBullet,
        ),
      },
      {
        files: [{ path: "src/commit-planning/grouping/repartition.ts" }],
        message: commitMessage(
          "fix(grouping): preserve ownership boundaries during repartition",
          repeatedBullet,
        ),
      },
    ];

    const consolidated = [
      {
        files: [
          { path: "src/commit-planning/grouping/group/finalization.ts" },
          { path: "src/commit-planning/grouping/repartition.ts" },
        ],
        message: commitMessage(
          "fix(grouping): keep ownership boundaries stable",
          "- Keep planner ownership boundaries stable across split and merge passes.",
          "- Keep planner ownership boundaries stable across split and merge passes.",
        ),
      },
    ];

    const allFiles = [
      makeFile("src/commit-planning/grouping/group/finalization.ts"),
      makeFile("src/commit-planning/grouping/repartition.ts"),
    ];

    const result = harmonizeConsolidatedMessages(
      originalGroups,
      consolidated,
      new Map(allFiles.map((file) => [file.path, file])),
    );
    const dedupedLines =
      result[0]?.message
        .split("\n")
        .filter((line: string) => line.trim() === repeatedBullet.slice(2)) ??
      [];

    expect(result).toHaveLength(1);
    expect(dedupedLines).toHaveLength(0);
    expect(
      result[0]?.message
        .split("\n")
        .filter((line: string) => line.trim() === repeatedBullet.trim()),
    ).toHaveLength(1);
  });

  test("harmonizeConsolidatedMessages rewrites uncovered export-only consolidation splits", async () => {
    const { harmonizeConsolidatedMessages } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?uncovered-export-consolidation-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/application/config/service.ts" },
          { path: "src/application/index.ts" },
          { path: "src/cli/commit/index.ts" },
          { path: "src/cli/index.ts" },
        ],
        message: commitMessage(
          "refactor(exports): narrow public entry points and config helpers",
          "- Add a dedicated config service with default values, layered loading, and cache reset helpers behind the application export surface.",
          "- Replace wildcard re-exports with explicit symbols so consumers only import supported config, CLI, constant, and error APIs.",
        ),
      },
    ];
    const consolidated = [
      {
        files: [{ path: "src/cli/index.ts" }],
        message: commitMessage(
          "refactor(src/cli): narrow public entry points and config helpers",
          "- Add a dedicated config service with default values, layered loading, and cache reset helpers behind the application export surface.",
          "- Replace wildcard re-exports with explicit symbols so consumers only import supported config, CLI, constant, and error APIs.",
        ),
      },
      {
        files: [{ path: "src/cli/commit/index.ts" }],
        message: commitMessage(
          "refactor(src/cli/commit): narrow public entry points and config helpers",
          "- Add a dedicated config service with default values, layered loading, and cache reset helpers behind the application export surface.",
          "- Replace wildcard re-exports with explicit symbols so consumers only import supported config, CLI, constant, and error APIs.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/application/config/service.ts"),
      makeFile("src/application/index.ts"),
      makeFile("src/cli/commit/index.ts"),
      makeFile("src/cli/index.ts"),
    ];

    const result = harmonizeConsolidatedMessages(
      groups,
      consolidated,
      new Map(allFiles.map((file) => [file.path, file])),
    );

    expect(result).toEqual([
      {
        files: [{ path: "src/cli/index.ts" }],
        message: "refactor(cli): update public exports",
      },
      {
        files: [{ path: "src/cli/commit/index.ts" }],
        message: "refactor(commit): update public exports",
      },
    ]);
  });

  test("harmonizeConsolidatedMessages drops inherited umbrella details for uncovered non-export splits", async () => {
    const { harmonizeConsolidatedMessages } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?uncovered-generic-consolidation-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/commit-planning/prompt-builders/cluster-prompts.ts" },
          { path: "src/commit-planning/prompt-builders/commit-format.ts" },
          { path: "src/commit-planning/prompts/index.ts" },
          { path: "src/commit-planning/grouping/index.ts" },
        ],
        message: commitMessage(
          "refactor(planning): extract reusable prompt rule modules",
          "- Replace monolithic prompt-builder files with dedicated rules modules for commit authoring, hunk grouping, cluster merging, and shared formatting.",
          "- Move shared diff-context helpers into the prompts namespace and update imports so stage builders can consume the new structure consistently.",
        ),
      },
    ];
    const consolidated = [
      {
        files: [
          { path: "src/commit-planning/prompts/index.ts" },
          { path: "src/commit-planning/prompt-builders/commit-format.ts" },
        ],
        message: commitMessage(
          "refactor(src/commit-planning/prompts): extract reusable prompt rule modules",
          "- Replace monolithic prompt-builder files with dedicated rules modules for commit authoring, hunk grouping, cluster merging, and shared formatting.",
          "- Move shared diff-context helpers into the prompts namespace and update imports so stage builders can consume the new structure consistently.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/prompt-builders/cluster-prompts.ts"),
      makeFile("src/commit-planning/prompt-builders/commit-format.ts"),
      makeFile("src/commit-planning/prompts/index.ts"),
      makeFile("src/commit-planning/grouping/index.ts"),
    ];

    const result = harmonizeConsolidatedMessages(
      groups,
      consolidated,
      new Map(allFiles.map((file) => [file.path, file])),
    );

    expect(result).toEqual([
      {
        files: [
          { path: "src/commit-planning/prompts/index.ts" },
          { path: "src/commit-planning/prompt-builders/commit-format.ts" },
        ],
        message:
          "refactor(src/commit-planning/prompts): extract reusable prompt rule modules",
      },
    ]);
  });

  test("harmonizeConsolidatedMessages keeps narrowed subject while rebuilding covered bullets only", async () => {
    const { harmonizeConsolidatedMessages } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?covered-body-only-merge-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const originalGroups = [
      {
        files: [{ path: "src/cli/index.ts" }],
        message: commitMessage(
          "refactor(cli): narrow entrypoint exports",
          "- Replace wildcard exports with explicit CLI symbols.",
        ),
      },
      {
        files: [{ path: "tests/cli.test.ts" }],
        message: commitMessage(
          "test(cli): cover narrowed entrypoint exports",
          "- Add coverage for the explicit CLI surface.",
        ),
      },
      {
        files: [{ path: "src/application/config/service.ts" }],
        message: commitMessage(
          "feat(config): add layered config loading",
          "- Add layered loading and validation helpers behind config service.",
        ),
      },
    ];

    const consolidatedGroups = [
      {
        files: [{ path: "src/cli/index.ts" }, { path: "tests/cli.test.ts" }],
        message: commitMessage(
          "test(cli): cover narrowed entrypoint exports",
          "- Add layered loading and validation helpers behind config service.",
          "- Add coverage for the explicit CLI surface.",
        ),
      },
    ];

    const allFiles = [
      makeFile("src/cli/index.ts"),
      makeFile("tests/cli.test.ts"),
      makeFile("src/application/config/service.ts"),
    ];

    const result = harmonizeConsolidatedMessages(
      originalGroups,
      consolidatedGroups,
      new Map(allFiles.map((file) => [file.path, file])),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain(
      "refactor(cli): narrow entrypoint exports",
    );
    expect(result[0]?.message).toContain(
      "- Add coverage for the explicit CLI surface.",
    );
    expect(result[0]?.message).not.toContain(
      "layered loading and validation helpers",
    );
  });

  test("harmonizeConsolidatedMessages restores path subjects when narrowed slices inherit premerge umbrella wording", async () => {
    const { harmonizeConsolidatedMessages } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?path-premerge-umbrella-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const originalGroups = [
      {
        files: [
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/index.ts" },
          { path: "src/commit-planning/path/resolver.ts" },
        ],
        message: commitMessage(
          "feat(path): resolve flattened and aliased planner file paths",
          "- Add project, absolute, and virtual nested-path aliases for planner file references.",
          "- Separate alias generation from canonical path resolution behind the path package.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/subject/premerge/service.ts" },
        ],
        message: commitMessage(
          "feat(grouping): premerge obviously related subject clusters",
          "- Collapse same-owner follow-up fragments before later planner stages.",
        ),
      },
    ];
    const consolidatedGroups = [
      {
        files: [
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/index.ts" },
          { path: "src/commit-planning/path/resolver.ts" },
        ],
        message: commitMessage(
          "feat(commit-planning): premerge obviously related subject clusters",
          "- Collapse same-owner follow-up fragments before later planner stages.",
          "- Add project, absolute, and virtual nested-path aliases for planner file references.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/subject/premerge/service.ts" },
        ],
        message: commitMessage(
          "feat(commit-planning): premerge obviously related subject clusters",
          "- Collapse same-owner follow-up fragments before later planner stages.",
          "- Add project, absolute, and virtual nested-path aliases for planner file references.",
        ),
      },
    ];
    const fileByPath = new Map(
      [
        "src/commit-planning/path/aliases.ts",
        "src/commit-planning/path/index.ts",
        "src/commit-planning/path/resolver.ts",
        "src/commit-planning/grouping/subject/premerge/service.ts",
      ].map((path) => [path, makeFile(path)]),
    );

    const result = harmonizeConsolidatedMessages(
      originalGroups,
      consolidatedGroups,
      fileByPath,
    );
    const pathGroup = result.find((group: PlannedCommit) =>
      group.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "src/commit-planning/path/resolver.ts",
      ),
    );

    expect(pathGroup).toBeDefined();
    expect(pathGroup?.message).toContain(
      "feat(path): resolve flattened and aliased planner file paths",
    );
    expect(pathGroup?.message).not.toContain(
      "premerge obviously related subject clusters",
    );
  });

  test("harmonizeConsolidatedMessages restores persisted plan bundle rollout subjects after umbrella wording leaks in", async () => {
    const { harmonizeConsolidatedMessages } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?plan-bundle-premerge-umbrella-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const originalGroups = [
      {
        files: [
          { path: "src/commit-planning/plan-bundles/index.ts" },
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/plan-bundles/storage.ts" },
        ],
        message: commitMessage(
          "feat(plan-bundles): persist resumable plans with content integrity",
          "- Save staged patches, repo identity, and content hashes for resumable plans.",
          "- Restore saved staging only when the saved bundle still matches the current checkout.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/planned-commit-clone.ts" },
          { path: "src/commit-planning/planning-workflow.ts" },
        ],
        message: commitMessage(
          "feat(planning): carry persisted bundle state through finalization",
          "- Clone planned commits before saving or replaying cached plan bundles.",
          "- Thread saved-plan metadata through finalization so resume reuses the same planning context.",
        ),
      },
    ];
    const consolidatedGroups = [
      {
        files: [
          { path: "src/commit-planning/plan-bundles/index.ts" },
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/plan-bundles/storage.ts" },
          { path: "src/commit-planning/planned-commit-clone.ts" },
          { path: "src/commit-planning/planning-workflow.ts" },
        ],
        message: commitMessage(
          "feat(commit-planning): premerge obviously related subject clusters",
          "- Collapse same-owner follow-up fragments before later planner stages.",
          "- Save staged patches, repo identity, and content hashes for resumable plans.",
          "- Clone planned commits before saving or replaying cached plan bundles.",
        ),
      },
    ];
    const fileByPath = new Map(
      [
        "src/commit-planning/plan-bundles/index.ts",
        "src/commit-planning/plan-bundles/service.ts",
        "src/commit-planning/plan-bundles/storage.ts",
        "src/commit-planning/planned-commit-clone.ts",
        "src/commit-planning/planning-workflow.ts",
      ].map((path) => [path, makeFile(path)]),
    );

    const result = harmonizeConsolidatedMessages(
      originalGroups,
      consolidatedGroups,
      fileByPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain(
      "persist resumable plans with content integrity",
    );
    expect(result[0]?.message).toContain(
      "Clone planned commits before saving or replaying cached plan bundles.",
    );
    expect(result[0]?.message).not.toContain(
      "premerge obviously related subject clusters",
    );
  });

  test("harmonizeConsolidatedMessages rebuilds full-coverage README and CLI rollout details from covered groups", async () => {
    const { harmonizeConsolidatedMessages } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?readme-cli-rollout-details-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const originalGroups = [
      {
        files: [{ path: "README.md" }],
        message: commitMessage(
          "docs(readme): refresh resume and breaking-mode usage",
          "- Document the resume command, saved plan bundles, and breaking-mode flags.",
        ),
      },
      {
        files: [{ path: "src/cli/commit/group-staging.ts" }],
        message: commitMessage(
          "feat(commit): save resumable commit plans from staged changes",
          "- Persist the analyzed staged patch so resume can replay the same split later.",
        ),
      },
      {
        files: [{ path: "src/cli/commit/plan-display.ts" }],
        message: commitMessage(
          "feat(commit): save resumable commit plans from staged changes",
          "- Show the saved bundle identifier in the plan display after analysis.",
        ),
      },
    ];
    const consolidatedGroups = [
      {
        files: [
          { path: "README.md" },
          { path: "src/cli/commit/group-staging.ts" },
          { path: "src/cli/commit/plan-display.ts" },
        ],
        message: commitMessage(
          "feat(commit): save resumable commit plans from staged changes",
          "- Document the resume command, saved plan bundles, and breaking-mode flags.",
        ),
      },
    ];
    const fileByPath = new Map(
      [
        "README.md",
        "src/cli/commit/group-staging.ts",
        "src/cli/commit/plan-display.ts",
      ].map((path) => [path, makeFile(path)]),
    );

    const result = harmonizeConsolidatedMessages(
      originalGroups,
      consolidatedGroups,
      fileByPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.message.split("\n")[0]).toBe(
      "feat(commit): save resumable commit plans from staged changes",
    );
    expect(result[0]?.message).toContain(
      "Persist the analyzed staged patch so resume can replay the same split later.",
    );
    expect(result[0]?.message).toContain(
      "Show the saved bundle identifier in the plan display after analysis.",
    );
    expect(result[0]?.message).toContain(
      "Document the resume command, saved plan bundles, and breaking-mode flags.",
    );
  });

  test("rewriteUncoveredSplitMessage rewrites untyped single-owner slices and drops stale body bullets", async () => {
    const { rewriteUncoveredSplitMessage } = await import(
      new URL(
        `../src/commit-planning/grouping/group/uncovered-split-message.js?rewrite-owner-slice-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const rewritten = rewriteUncoveredSplitMessage({
      files: [{ path: "src/cli/output-presentation.ts" }],
      message: commitMessage(
        "narrow public surfaces",
        "- Add config-service details that should not survive uncovered owner slices.",
      ),
    });

    expect(rewritten).toEqual({
      files: [{ path: "src/cli/output-presentation.ts" }],
      message: "chore(cli): update related slice",
    });
  });

  test("rescopeGroupMessageToCoveredGroups drops merged umbrella details when covered owners are broader than the slice", async () => {
    const { rescopeGroupMessageToCoveredGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?covered-owner-span-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const broadSourceGroups = [
      {
        files: [
          { path: "src/commit-planning/prompt-builders/commit-format.ts" },
          { path: "src/commit-planning/prompt-builders/grouping-prompts.ts" },
          { path: "src/commit-planning/prompts/context/diff-context.ts" },
          { path: "src/commit-planning/prompts/index.ts" },
        ],
        message: commitMessage(
          "refactor(planning): centralize reusable commit-planning rule blocks",
          "- Replace stage-specific prompt-builder modules with shared rule factories for commit messages, hunk grouping, and cluster merging.",
          "- Move diff-context helpers under prompts/context and update imports so prompt stages can compose shared context and rule modules from one namespace.",
        ),
      },
    ];
    const narrowedSlice = {
      files: [
        { path: "src/commit-planning/prompt-builders/commit-format.ts" },
        { path: "src/commit-planning/prompt-builders/grouping-prompts.ts" },
      ],
      message: commitMessage(
        "refactor(src/commit-planning/prompt-builders): centralize reusable commit-planning rule blocks",
        "- Replace stage-specific prompt-builder modules with shared rule factories for commit messages, hunk grouping, and cluster merging.",
        "- Move diff-context helpers under prompts/context and update imports so prompt stages can compose shared context and rule modules from one namespace.",
      ),
    };
    const allFiles = [
      makeFile("src/commit-planning/prompt-builders/commit-format.ts"),
      makeFile("src/commit-planning/prompt-builders/grouping-prompts.ts"),
      makeFile("src/commit-planning/prompts/context/diff-context.ts"),
      makeFile("src/commit-planning/prompts/index.ts"),
    ];

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      broadSourceGroups,
      new Map(allFiles.map((file) => [file.path, file])),
    );

    expect(result).toEqual({
      files: [
        { path: "src/commit-planning/prompt-builders/commit-format.ts" },
        { path: "src/commit-planning/prompt-builders/grouping-prompts.ts" },
      ],
      message:
        "refactor(src/commit-planning/prompt-builders): centralize reusable commit-planning rule blocks",
    });
  });

  test("rescopeGroupMessageToCoveredGroups drops stage-builder umbrella details on narrowed covered prompt slices", async () => {
    const { rescopeGroupMessageToCoveredGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/group/message-harmonization.js?covered-stage-builder-owner-span-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const broadSourceGroups = [
      {
        files: [
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/resolver.ts" },
          { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
          { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
        ],
        message: commitMessage(
          "feat(planning): add stage-specific prompt builders and modes",
          "- Introduce dedicated prompt builders for grouping, consolidation, cluster-merge, and commit generation so each planner stage can apply its own instructions and output framing.",
          "- Thread prompt-mode and breaking-mode context through validation, token estimation, and cache keys so cached plans and token budgets match the exact prompt contract used for a run.",
        ),
      },
    ];
    const narrowedSlice = {
      files: [
        { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
        { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
      ],
      message: commitMessage(
        "feat(src/commit-planning/prompts): add stage-specific prompt builders and modes",
        "- Introduce dedicated prompt builders for grouping, consolidation, cluster-merge, and commit generation so each planner stage can apply its own instructions and output framing.",
        "- Thread prompt-mode and breaking-mode context through validation, token estimation, and cache keys so cached plans and token budgets match the exact prompt contract used for a run.",
      ),
    };
    const allFiles = [
      makeFile("src/commit-planning/path/aliases.ts"),
      makeFile("src/commit-planning/path/resolver.ts"),
      makeFile("src/commit-planning/prompts/stages/cluster-merge.ts"),
      makeFile("src/commit-planning/prompts/stages/hunk-grouping.ts"),
      makeFile("src/commit-planning/result-cache.ts"),
      makeFile("src/commit-planning/token-estimation.ts"),
    ];

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      broadSourceGroups,
      new Map(allFiles.map((file) => [file.path, file])),
    );

    expect(result).toEqual({
      files: [
        { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
        { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
      ],
      message:
        "feat(src/commit-planning/prompts): add stage-specific prompt builders and modes",
    });
  });

  test("finalizePlannedGroups keeps support-attachment work out of the resume workflow rollout", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-resume-from-support-attachment"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      {
                        path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
                      },
                      {
                        path: "src/commit-planning/grouping/support-attachment/selection.ts",
                      },
                      { path: "src/commit-planning/plan-bundles/index.ts" },
                      {
                        path: "src/commit-planning/planned-commit-clone.ts",
                      },
                      { path: "src/cli/main.ts" },
                      { path: "src/cli/execution-flow.ts" },
                      { path: "tests/plan-bundles.test.ts" },
                      { path: "tests/cli.test.ts" },
                    ],
                    message:
                      "feat(planning): add resumable plan execution and ownership-aware support routing\n\n- Combine support attachment, saved-plan persistence, CLI resume flow, and coverage in one broad rollout.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-resume-from-support-attachment-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/selection.ts",
          },
        ],
        message: commitMessage(
          "feat(grouping): attach support commits to the right owner",
          "- Score and route broad support groups to the most specific implementation owner.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/plan-bundles/index.ts" },
          { path: "src/commit-planning/planned-commit-clone.ts" },
        ],
        message: commitMessage(
          "feat(planning): persist reusable plan bundles for resume",
          "- Save validated planned commits so resume can replay the same staging context.",
        ),
      },
      {
        files: [
          { path: "src/cli/main.ts" },
          { path: "src/cli/execution-flow.ts" },
        ],
        message: commitMessage(
          "feat(cli): add resume command for saved plan bundles",
          "- Load a saved bundle hash and execute the planned commits later.",
        ),
      },
      {
        files: [{ path: "tests/plan-bundles.test.ts" }],
        message: commitMessage(
          "test(plan-bundles): cover saved-plan resume execution",
          "- Verify saved bundles resume only in the matching repository state.",
        ),
      },
      {
        files: [{ path: "tests/cli.test.ts" }],
        message: commitMessage(
          "test(cli): cover resume command wiring",
          "- Verify the CLI accepts a saved bundle hash and displays the planned resume flow.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        makeFile(
          "src/commit-planning/grouping/support-attachment/component-attachment.ts",
        ),
        makeFile(
          "src/commit-planning/grouping/support-attachment/selection.ts",
        ),
        makeFile("src/commit-planning/plan-bundles/index.ts"),
        makeFile("src/commit-planning/planned-commit-clone.ts"),
        makeFile("src/cli/main.ts"),
        makeFile("src/cli/execution-flow.ts"),
        makeFile("tests/plan-bundles.test.ts"),
        makeFile("tests/cli.test.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(1);
    expect(result.length).toBeGreaterThan(1);
    expect(
      result.some(
        (group: PlannedCommit) =>
          group.files.some(
            (file) =>
              file.path ===
              "src/commit-planning/grouping/support-attachment/component-attachment.ts",
          ) &&
          !group.files.some(
            (file) => file.path === "src/commit-planning/plan-bundles/index.ts",
          ) &&
          !group.files.some((file) => file.path === "src/cli/main.ts"),
      ),
    ).toBe(true);
  });

  test("finalizePlannedGroups keeps CLI EOF prompting separate from rename restaging", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-cli-eof-from-rename"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/cli/interactive-prompt.ts" },
                      {
                        path: "src/cli/token/confirmation.ts",
                      },
                      {
                        path: "src/cli/commit/group-staging.ts",
                      },
                    ],
                    message:
                      "fix(cli): harden interactive commit confirmation flow\n\n- Combine EOF handling and rename restaging safety into one CLI guardrail update.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-cli-eof-from-rename-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/cli/interactive-prompt.ts" },
          { path: "src/cli/token/confirmation.ts" },
        ],
        message: commitMessage(
          "fix(cli): abort plan confirmation on EOF instead of auto-accept",
          "- Default EOF answers to decline when interactive confirmation closes unexpectedly.",
        ),
      },
      {
        files: [
          {
            path: "src/cli/commit/group-staging.ts",
          },
        ],
        message: commitMessage(
          "fix(staging): re-anchor rename patches to current index paths",
          "- Keep later split hunks stageable after earlier rename commits move the tracked path.",
        ),
      },
    ];

    const result: PlannedCommit[] = await finalizePlannedGroups(
      [
        makeFile("src/cli/interactive-prompt.ts"),
        makeFile("src/cli/token/confirmation.ts"),
        makeFile("src/cli/commit/group-staging.ts"),
      ],
      groups,
    );

    expect(calls.chat.length).toBeLessThanOrEqual(1);
    expect(result).toHaveLength(2);
    expect(
      result.some(
        (group) =>
          group.files.some(
            (file) => file.path === "src/cli/interactive-prompt.ts",
          ) &&
          group.files.some(
            (file) => file.path === "src/cli/token/confirmation.ts",
          ) &&
          !group.files.some(
            (file) => file.path === "src/cli/commit/group-staging.ts",
          ),
      ),
    ).toBe(true);
    expect(
      result.some(
        (group) =>
          group.files.length === 1 &&
          group.files[0]?.path === "src/cli/commit/group-staging.ts",
      ),
    ).toBe(true);
  });

  test("finalizePlannedGroups keeps breaking footer semantics separate from CLI passthrough wiring", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-breaking-footer-from-cli-wiring"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      {
                        path: "src/commit-messages/breaking-change-footers.ts",
                      },
                      { path: "src/commit-messages/subject-parser.ts" },
                      { path: "tests/commit-messages.test.ts" },
                      { path: "tests/zz-cli-coverage.test.ts" },
                      { path: "tests/cli.test.ts" },
                      { path: "tsconfig.json" },
                    ],
                    message:
                      "feat(messages): ship one breaking-mode metadata rollout\n\n- Combine commit-message footer semantics, CLI passthrough coverage, and test wiring in one release-impact update.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-breaking-footer-from-cli-wiring-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/commit-messages/breaking-change-footers.ts" },
          { path: "src/commit-messages/subject-parser.ts" },
          { path: "tests/commit-messages.test.ts" },
        ],
        message: commitMessage(
          "feat(messages): enforce and manage breaking-change metadata",
          "- Add footer parsing and stricter breaking-subject handling.",
        ),
      },
      {
        files: [
          { path: "tests/zz-cli-coverage.test.ts" },
          { path: "tests/cli.test.ts" },
          { path: "tsconfig.json" },
        ],
        message: commitMessage(
          "test(cli): cover single-commit breaking mode passthrough",
          "- Keep CLI help and single-commit wiring aligned with release-impact mode selection.",
        ),
      },
    ];

    const result: PlannedCommit[] = await finalizePlannedGroups(
      [
        makeFile("src/commit-messages/breaking-change-footers.ts"),
        makeFile("src/commit-messages/subject-parser.ts"),
        makeFile("tests/commit-messages.test.ts"),
        makeFile("tests/zz-cli-coverage.test.ts"),
        makeFile("tests/cli.test.ts"),
        makeFile("tsconfig.json"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(1);
    expect(result.length).toBeGreaterThan(1);
    expect(
      result.some((group) =>
        group.files.some(
          (file) =>
            file.path === "src/commit-messages/breaking-change-footers.ts",
        ),
      ),
    ).toBe(true);
    expect(
      result.some((group) =>
        group.files.some((file) => file.path === "tests/cli.test.ts"),
      ),
    ).toBe(true);
    expect(
      result.some(
        (group) =>
          group.files.some(
            (file) =>
              file.path === "src/commit-messages/breaking-change-footers.ts",
          ) && !group.files.some((file) => file.path === "tests/cli.test.ts"),
      ),
    ).toBe(true);
    expect(
      result.some(
        (group) =>
          group.files.some((file) => file.path === "tests/cli.test.ts") &&
          !group.files.some(
            (file) =>
              file.path === "src/commit-messages/breaking-change-footers.ts",
          ),
      ),
    ).toBe(true);
  });

  test("finalizePlannedGroups keeps unrelated CLI default-model coverage out of config runtime rollouts", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-config-runtime-from-cli-default-model"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/application/config/service.ts" },
                      { path: "src/application/index.ts" },
                      { path: "tests/config.test.ts" },
                      { path: "tests/cli.test.ts" },
                    ],
                    message:
                      "feat(config): ship config runtime defaults and coverage together\n\n- Combine config runtime helpers, default-model coverage, and CLI expectations into one defaults rollout.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-config-runtime-from-cli-default-model-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/application/config/service.ts" },
          { path: "src/application/index.ts" },
        ],
        message: commitMessage(
          "feat(config): expose runtime config service APIs",
          "- Export config entry points from the application surface so callers can consume stable config helpers directly.",
        ),
      },
      {
        files: [{ path: "tests/config.test.ts" }],
        message: commitMessage(
          "test(config): update defaults for the new OpenAI model",
          "- Verify config defaults now use gpt-5.3-codex.",
        ),
      },
      {
        files: [{ path: "tests/cli.test.ts" }],
        message: commitMessage(
          "test(cli): update default model expectations in CLI coverage",
          "- Verify CLI help and config output reflect the new default model.",
        ),
      },
    ];

    const result: PlannedCommit[] = await finalizePlannedGroups(
      [
        makeFile("src/application/config/service.ts"),
        makeFile("src/application/index.ts"),
        makeFile("tests/config.test.ts"),
        makeFile("tests/cli.test.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(1);
    expect(result).toHaveLength(2);
    expect(
      result.some(
        (group) =>
          group.files.some(
            (file) => file.path === "src/application/config/service.ts",
          ) &&
          group.files.some((file) => file.path === "tests/config.test.ts") &&
          !group.files.some((file) => file.path === "tests/cli.test.ts"),
      ),
    ).toBe(true);
    expect(
      result.some(
        (group) =>
          group.files.length === 1 &&
          group.files[0]?.path === "tests/cli.test.ts",
      ),
    ).toBe(true);
  });

  test("finalizePlannedGroups keeps CLI EOF prompting, rename restaging, and incidental formatting shards separate", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("split-cli-eof-rename-formatting"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/cli/interactive-prompt.ts" },
                      { path: "src/cli/token/confirmation.ts" },
                      { path: "src/cli/commit/group-staging.ts" },
                      { hunks: [13], path: "src/cli/execution-flow.ts" },
                    ],
                    message:
                      "fix(cli): harden confirmation, restaging, and formatting follow-ups together\n\n- Combine EOF handling, rename restaging safety, and incidental execution-flow cleanup into one CLI change.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?split-cli-eof-rename-formatting-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [
          { path: "src/cli/interactive-prompt.ts" },
          { path: "src/cli/token/confirmation.ts" },
        ],
        message: commitMessage(
          "fix(cli): abort plan confirmation on EOF instead of auto-accept",
          "- Default EOF answers to decline when interactive confirmation closes unexpectedly.",
        ),
      },
      {
        files: [{ path: "src/cli/commit/group-staging.ts" }],
        message: commitMessage(
          "fix(staging): re-anchor rename patches to current index paths",
          "- Keep later split hunks stageable after earlier rename commits move the tracked path.",
        ),
      },
      {
        files: [{ hunks: [13], path: "src/cli/execution-flow.ts" }],
        message: commitMessage(
          "style(cli): normalize execution-flow wrapping",
          "- Reflow one wrapped helper call without changing behavior.",
        ),
      },
    ];

    const result: PlannedCommit[] = await finalizePlannedGroups(
      [
        makeFile("src/cli/interactive-prompt.ts"),
        makeFile("src/cli/token/confirmation.ts"),
        makeFile("src/cli/commit/group-staging.ts"),
        makeFile("src/cli/execution-flow.ts", 14),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(1);
    expect(
      result.every(
        (group) =>
          !(
            group.files.some(
              (file) => file.path === "src/cli/commit/group-staging.ts",
            ) &&
            group.files.some(
              (file) => file.path === "src/cli/interactive-prompt.ts",
            )
          ),
      ),
    ).toBe(true);
    expect(
      result.every(
        (group) =>
          !(
            group.files.some(
              (file) => file.path === "src/cli/commit/group-staging.ts",
            ) &&
            group.files.some(
              (file) => file.path === "src/cli/token/confirmation.ts",
            )
          ),
      ),
    ).toBe(true);
    expect(
      result.every(
        (group) =>
          !(
            group.files.some(
              (file) => file.path === "src/cli/execution-flow.ts",
            ) &&
            group.files.some(
              (file) => file.path === "src/cli/commit/group-staging.ts",
            )
          ),
      ),
    ).toBe(true);
  });

  test("finalizePlannedGroups reorders enabling helpers before dependent commits", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("dependency-ordering"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?dependency-ordering-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const helperFile = makeFile("src/commit-messages/subject-parser.ts");
    const dependentFile = makeFile("src/commit-planning/grouping/index.ts");
    dependentFile.hunks[0]!.lines = [
      " import { parseConventionalSubject } from '../../commit-messages/subject-parser.js'",
      "+const subject = parseConventionalSubject(message)",
    ];

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/index.ts",
          },
        ],
        message: commitMessage(
          "refactor(planned-commit-grouping): reuse parsed subject metadata",
          "- Route merge heuristics through the shared subject parser.",
        ),
      },
      {
        files: [{ path: "src/commit-messages/subject-parser.ts" }],
        message: commitMessage(
          "feat(subject-parser): add reusable subject parsing",
          "- Expose conventional subject parsing for planner heuristics.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [dependentFile, helperFile],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual([groups[1], groups[0]]);
  });

  test("finalizePlannedGroups reorders helpers when imports live outside changed hunks", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("dependency-ordering-current-file-import"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?dependency-ordering-current-file-import-${Math.random()}`,
        import.meta.url,
      ).href
    );

    mkdirSync(join(sandboxDir, "src/commit-planning/grouping"), {
      recursive: true,
    });
    mkdirSync(join(sandboxDir, "src/commit-messages"), { recursive: true });
    writeFileSync(
      join(sandboxDir, "src/commit-messages/subject-parser.ts"),
      [
        "export function parseConventionalSubject(subject: string) {",
        "  return { description: subject, scope: '', type: '' };",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(sandboxDir, "src/commit-planning/grouping/index.ts"),
      [
        "import { parseConventionalSubject } from '../../commit-messages/subject-parser.js';",
        "",
        "export function describeSubject(subject: string) {",
        "  return parseConventionalSubject(subject).description;",
        "}",
        "",
      ].join("\n"),
    );

    const helperFile = makeFile("src/commit-messages/subject-parser.ts");
    const dependentFile = makeFile("src/commit-planning/grouping/index.ts");
    dependentFile.hunks[0]!.lines = [
      "+const parsedSubject = parseConventionalSubject(subject)",
      "+return parsedSubject.description || 'empty'",
    ];

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/index.ts",
          },
        ],
        message: commitMessage(
          "refactor(planned-commit-grouping): normalize subject handling",
          "- Keep planner subject handling consistent across regrouping passes.",
        ),
      },
      {
        files: [{ path: "src/commit-messages/subject-parser.ts" }],
        message: commitMessage(
          "feat(subject-parser): add reusable subject parsing",
          "- Expose conventional subject parsing for downstream helpers.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [dependentFile, helperFile],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual([groups[1], groups[0]]);
  });

  test("finalizePlannedGroups preserves helper ordering even when other commits cycle", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("dependency-ordering-cycle-break"),
        model: "gpt-5.3-codex",
      },
    });
    mkdirSync(join(sandboxDir, "src/commit-planning/grouping"), {
      recursive: true,
    });
    mkdirSync(join(sandboxDir, "src/commit-messages"), { recursive: true });
    writeFileSync(
      join(sandboxDir, "src/commit-messages/subject-parser.ts"),
      "export function parseConventionalSubject(subject: string) {\n  return { description: subject, scope: '', type: '' };\n}\n",
    );
    writeFileSync(
      join(sandboxDir, "src/commit-planning/grouping/index.ts"),
      "import { parseConventionalSubject } from '../../commit-messages/subject-parser.js';\nexport function describeSubject(subject: string) {\n  return parseConventionalSubject(subject).description;\n}\n",
    );
    writeFileSync(
      join(sandboxDir, "src/cycle-a.ts"),
      "import { betaValue } from './cycle-b.js';\nexport const alphaValue = betaValue + 1;\n",
    );
    writeFileSync(
      join(sandboxDir, "src/cycle-b.ts"),
      "import { alphaValue } from './cycle-a.js';\nexport const betaValue = alphaValue + 1;\n",
    );

    const dependentFile = makeFile("src/commit-planning/grouping/index.ts");
    dependentFile.hunks[0]!.lines = [
      "+const parsedSubject = parseConventionalSubject(subject)",
      "+return parsedSubject.description || 'empty'",
    ];
    const helperFile = makeFile("src/commit-messages/subject-parser.ts");
    const cycleAFile = makeFile("src/cycle-a.ts");
    cycleAFile.hunks[0]!.lines = ["+const nextAlpha = betaValue + 1"];
    const cycleBFile = makeFile("src/cycle-b.ts");
    cycleBFile.hunks[0]!.lines = ["+const nextBeta = alphaValue + 1"];

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/index.ts",
          },
        ],
        message: commitMessage(
          "refactor(planned-commit-grouping): normalize subject handling",
          "- Keep planner subject handling consistent across regrouping passes.",
        ),
      },
      {
        files: [{ path: "src/cycle-a.ts" }],
        message: commitMessage(
          "refactor(cycle-a): consume beta value",
          "- Exercise cycle breaking without discarding valid helper ordering.",
        ),
      },
      {
        files: [{ path: "src/cycle-b.ts" }],
        message: commitMessage(
          "refactor(cycle-b): consume alpha value",
          "- Exercise cycle breaking without discarding valid helper ordering.",
        ),
      },
      {
        files: [{ path: "src/commit-messages/subject-parser.ts" }],
        message: commitMessage(
          "feat(subject-parser): add reusable subject parsing",
          "- Expose conventional subject parsing for downstream helpers.",
        ),
      },
    ];

    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify(groups),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?dependency-ordering-cycle-break-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const result = await finalizePlannedGroups(
      [dependentFile, cycleAFile, cycleBFile, helperFile],
      groups,
    );

    expect(calls.chat.length).toBeLessThanOrEqual(1);
    const helperIndex = result.findIndex((group: PlannedCommit) =>
      group.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "src/commit-messages/subject-parser.ts",
      ),
    );
    const dependentIndex = result.findIndex((group: PlannedCommit) =>
      group.files.some(
        (file: PlannedCommit["files"][number]) =>
          file.path === "src/commit-planning/grouping/index.ts",
      ),
    );
    expect(helperIndex).toBeLessThan(dependentIndex);
  });

  test("finalizePlannedGroups detects generic relative path dependencies without import syntax assumptions", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("dependency-ordering-generic-relative-path"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?dependency-ordering-generic-relative-path-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const helperFile = makeFile("src/planner-subject.custom");
    const dependentFile = makeFile("src/commit-planning/grouping/index.ts");
    dependentFile.hunks[0]!.lines = [
      "+planner_subject_source = '../../planner-subject.custom'",
      "+const subject = loadPlannerSubject(planner_subject_source)",
    ];

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/index.ts",
          },
        ],
        message: commitMessage(
          "refactor(planned-commit-grouping): load external manifest",
          "- Read planner state from a shared relative path.",
        ),
      },
      {
        files: [{ path: "src/planner-subject.custom" }],
        message: commitMessage(
          "feat(planner-subject): add backing manifest file",
          "- Provide a reusable non-code data source for planner state.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [dependentFile, helperFile],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual([groups[1], groups[0]]);
  });

  test("finalizePlannedGroups resolves arbitrary module suffixes without an extension whitelist", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("dependency-ordering-index-alias"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?dependency-ordering-generic-suffix-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const helperFile = makeFile("src/subject-tools.parser-entry");
    const dependentFile = makeFile("src/commit-planning/grouping/index.ts");
    dependentFile.hunks[0]!.lines = [
      " export { parsePlannerSubject } from '../../subject-tools.parser-entry.js'",
      "+const subject = parsePlannerSubject(message)",
    ];

    const groups = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/index.ts",
          },
        ],
        message: commitMessage(
          "refactor(planned-commit-grouping): reuse external parser metadata",
          "- Route planner heuristics through a shared parsing surface.",
        ),
      },
      {
        files: [{ path: "src/subject-tools.parser-entry" }],
        message: commitMessage(
          "feat(subject-tools): add parser entrypoint",
          "- Expose parsing logic from a helper module with a non-language suffix.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [dependentFile, helperFile],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual([groups[1], groups[0]]);
  });

  test("finalizePlannedGroups prefers implementation commits ahead of standalone tests when dependencies tie", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("dependency-ordering-test-tiebreak"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?dependency-ordering-test-tiebreak-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "tests/planner-fallback.test.ts" }],
        message: commitMessage(
          "test(planner-fallback): cover invalid fallback reasons",
          "- Verify fallback notices stay precise when planners degrade.",
        ),
      },
      {
        files: [{ path: "src/cli/verbose-output.ts" }],
        message: commitMessage(
          "feat(verbose-output): render planner trace labels",
          "- Add human-readable planner decision titles to verbose output.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        makeFile("tests/planner-fallback.test.ts"),
        makeFile("src/cli/verbose-output.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual([groups[1], groups[0]]);
  });

  test("finalizePlannedGroups treats semantically undone tail consolidation as noop", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("consolidation-diminishing-returns"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/group-0.ts" },
                      { path: "src/group-1.ts" },
                    ],
                    message: commitMessage(
                      "feat(core): merge adjacent rollout slices",
                      "- Keep closely related rollout changes together.",
                    ),
                  },
                  {
                    files: [{ path: "src/group-2.ts" }],
                    message: commitMessage(
                      "feat(core): keep slice 2",
                      "- Preserve slice 2.",
                    ),
                  },
                  {
                    files: [{ path: "src/group-3.ts" }],
                    message: commitMessage(
                      "feat(core): keep slice 3",
                      "- Preserve slice 3.",
                    ),
                  },
                  {
                    files: [{ path: "src/group-4.ts" }],
                    message: commitMessage(
                      "feat(core): keep slice 4",
                      "- Preserve slice 4.",
                    ),
                  },
                  {
                    files: [{ path: "src/group-5.ts" }],
                    message: commitMessage(
                      "feat(core): keep slice 5",
                      "- Preserve slice 5.",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const observer = await import("../src/commit-planning/openai-client.js");
    const events: { content: string; kind?: string; stage: string }[] = [];
    observer.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?consolidation-diminishing-returns-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = Array.from({ length: 6 }, (_, index) => ({
      files: [{ path: `src/group-${String(index)}.ts` }],
      message: commitMessage(
        [
          "feat(core): add parser workflow",
          "feat(core): add validator pipeline",
          "feat(core): add reporter summary",
          "feat(core): add cache hydration",
          "feat(core): add queue draining",
          "feat(core): add notifier routing",
        ][index] ?? `feat(core): add slice ${String(index)}`,
        `- Preserve distinct rollout slice ${String(index)}.`,
      ),
    }));

    const result = await finalizePlannedGroups(
      groups.map((group) => makeFile(group.files[0]!.path)),
      groups,
    );

    expect(calls.chat).toHaveLength(1);
    expect(result.length).toBeGreaterThanOrEqual(5);
    expect(result.length).toBeLessThanOrEqual(6);
    expect(
      events.some((event) =>
        event.content.includes('"decision":"consolidation-noop"'),
      ),
    ).toBe(true);
    observer.setAiOutputObserver(null);
  });

  test("finalizePlannedGroups stabilizes broad cluster merges before acceptance", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("cluster-repartition-stabilization"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  [0, 1, 2, 3],
                  [4, 5, 6, 7],
                  [8, 9],
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?cluster-repartition-stabilization-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/auth/login.ts" }],
        message: commitMessage(
          "feat(auth): add login endpoint",
          "- Wire the login handler into the auth flow.",
        ),
      },
      {
        files: [{ path: "tests/auth/login.test.ts" }],
        message: commitMessage(
          "test(auth): reject invalid credentials",
          "- Verify the login endpoint rejects invalid credentials.",
        ),
      },
      {
        files: [{ path: "src/cli/prompts.ts" }],
        message: commitMessage(
          "feat(cli): add review prompts",
          "- Show interactive prompts during manual review.",
        ),
      },
      {
        files: [{ path: "docs/cli-prompts.md" }],
        message: commitMessage(
          "docs(cli): explain prompt walkthrough",
          "- Explain the interactive review walkthrough for operators.",
        ),
      },
      {
        files: [{ path: "src/cache/store.ts" }],
        message: commitMessage(
          "feat(cache): add persisted store",
          "- Persist cache state between planner runs.",
        ),
      },
      {
        files: [{ path: "tests/cache/store.test.ts" }],
        message: commitMessage(
          "test(cache): preserve store snapshots",
          "- Verify the persisted store restores its last snapshot.",
        ),
      },
      {
        files: [{ path: "src/tokens/buffer.ts" }],
        message: commitMessage(
          "feat(tokens): add buffer tracking",
          "- Track the planner token buffer budget.",
        ),
      },
      {
        files: [{ path: "docs/tokens-buffer.md" }],
        message: commitMessage(
          "docs(tokens): outline budget heuristics",
          "- Describe the token budget heuristics for planner buffering.",
        ),
      },
      {
        files: [{ path: "src/overlap/resolver.ts" }],
        message: commitMessage(
          "feat(overlap): add resolver flow",
          "- Resolve ownership across overlapping changes.",
        ),
      },
      {
        files: [{ path: "tests/overlap/resolver.test.ts" }],
        message: commitMessage(
          "test(overlap): enforce owner tiebreaks",
          "- Verify overlap ownership uses deterministic tie breaking.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      groups.map((group) => makeFile(group.files[0]!.path)),
      groups,
    );
    const payload = calls.chat[0]?.payload as {
      messages?: { content?: string; role?: string }[];
    };
    const userPrompt = payload.messages?.find(
      (message) => message.role === "user",
    )?.content;

    expect(calls.chat).toHaveLength(1);
    expect(userPrompt).toContain(
      "Cluster these 10 commits into semantic groups.",
    );
    expect(result.length).toBeGreaterThan(3);
    expect(result.length).toBeLessThan(10);
  });

  test("finalizePlannedGroups emits consolidation noop when a pass makes no reduction", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("consolidation-noop-trace"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [{ path: "src/auth/login.ts" }],
                    message: commitMessage(
                      "feat(auth): add login endpoint",
                      "- Wire the login handler into the auth flow.",
                    ),
                  },
                  {
                    files: [{ path: "tests/auth/login.test.ts" }],
                    message: commitMessage(
                      "test(auth): cover login flow",
                      "- Verify the login endpoint accepts valid credentials.",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const observer = await import("../src/commit-planning/openai-client.js");
    const events: { content: string; kind?: string; stage: string }[] = [];
    observer.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?consolidation-noop-trace-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const groups = [
      {
        files: [{ path: "src/auth/login.ts" }],
        message: commitMessage(
          "feat(auth): add login endpoint",
          "- Wire the login handler into the auth flow.",
        ),
      },
      {
        files: [{ path: "tests/auth/login.test.ts" }],
        message: commitMessage(
          "test(auth): cover login flow",
          "- Verify the login endpoint accepts valid credentials.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      groups.map((group) => makeFile(group.files[0]!.path)),
      groups,
    );

    expect(calls.chat).toHaveLength(1);
    expect(result).toEqual(groups);
    expect(
      events.some((event) =>
        event.content.includes('"decision":"consolidation-noop"'),
      ),
    ).toBe(true);
    expect(
      events.some((event) =>
        event.content.includes('"decision":"consolidation-pass"'),
      ),
    ).toBe(false);
    observer.setAiOutputObserver(null);
  });

  test("finalizePlannedGroups keeps separate-hunk workflow neighbors split when action and artifact diverge", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("same-file-hunks-reason-split"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({ chatQueue: [] });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?same-file-hunks-reason-split-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const aiFile = makeFile("src/commit-planning/orchestration.ts", 2);
    aiFile.hunks[0]!.lines = [
      " import { recordStageTokens } from './openai-client.js'",
      "+recordStageTokens(stage, usage)",
    ];
    aiFile.hunks[1]!.lines = ["+estimatePlanningStageTokens(batchCount)"];

    const groups = [
      {
        files: [
          { path: "src/commit-planning/openai-client.ts" },
          { hunks: [0], path: "src/commit-planning/orchestration.ts" },
        ],
        message: commitMessage(
          "feat(ai-client): track stage telemetry",
          "- Record per-stage token usage and output observer events.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/token-estimation.ts" },
          { hunks: [1], path: "src/commit-planning/orchestration.ts" },
        ],
        message: commitMessage(
          "feat(ai-pipeline): estimate planning costs",
          "- Model multi-pass planning request sizes before execution.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        aiFile,
        makeFile("src/commit-planning/openai-client.ts"),
        makeFile("src/commit-planning/token-estimation.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual(groups);
  });

  test("finalizePlannedGroups does not let coordinator files glue cache and planning reasons together", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("coordinator-file-spillover-split"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/commit-planning/result-cache.ts" },
                      { path: "src/commit-planning/token-estimation.ts" },
                      {
                        hunks: [0, 1],
                        path: "src/commit-planning/orchestration.ts",
                      },
                    ],
                    message:
                      "feat(ai): align planning cache and token forecasting\n\n- Combine orchestration changes behind one planner pipeline update.",
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/commit-planning/grouping/index.js?coordinator-file-spillover-split-${Math.random()}`,
        import.meta.url,
      ).href
    );

    const aiFile = makeFile("src/commit-planning/orchestration.ts", 2);
    aiFile.hunks[0]!.lines = [
      " import { getCachedPlan } from './ai-result-cache.js'",
      "+const cachedPlan = getCachedPlan(cacheKey)",
    ];
    aiFile.hunks[1]!.lines = [
      " import { estimatePlanningStageTokens } from './ai-token-estimation.js'",
      "+const estimatedTokens = estimatePlanningStageTokens(batchCount)",
    ];

    const groups = [
      {
        files: [
          { path: "src/commit-planning/result-cache.ts" },
          { hunks: [0], path: "src/commit-planning/orchestration.ts" },
        ],
        message: commitMessage(
          "feat(ai-cache): cache grouped plans",
          "- Reuse previously computed planning output before recomputing commits.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/token-estimation.ts" },
          { hunks: [1], path: "src/commit-planning/orchestration.ts" },
        ],
        message: commitMessage(
          "feat(ai-tokens): forecast planning costs",
          "- Estimate batching overhead before sending planner requests.",
        ),
      },
    ];

    const result = await finalizePlannedGroups(
      [
        aiFile,
        makeFile("src/commit-planning/result-cache.ts"),
        makeFile("src/commit-planning/token-estimation.ts"),
      ],
      groups,
    );

    expect(calls.chat).toHaveLength(0);
    expect(result).toEqual(groups);
  });

  test("planCommits does not recurse forever on an oversized single file", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("single-file-batch"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [{ path: "src/huge.ts" }],
                    message: commitMessage(
                      "refactor(huge): regroup oversized file",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("single-file-batch");
    const oversizedFile = makeFile("src/huge.ts", 1300);

    const result = await ai.planCommits([oversizedFile], formatFileDiff);

    expect(calls.chat).toHaveLength(1);
    expect(result).toEqual([
      {
        files: [{ path: "src/huge.ts" }],
        message: commitMessage("refactor(huge): regroup oversized file"),
      },
    ]);
  });

  test("planCommits rejects excessive recursion depth", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("recursion"), model: "gpt-5.3-codex" },
    });
    const ai = await importFreshAi("recursion");

    await expect(
      ai.planCommits([makeFile("src/a.ts")], formatFileDiff, 6),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("planCommits rejects an empty file set before any AI call", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("empty-plan"), model: "gpt-5.3-codex" },
    });
    const calls = installOpenAiMock({});
    const ai = await importFreshAi("empty-plan");

    await expect(ai.planCommits([], formatFileDiff)).rejects.toThrow(
      "Cannot plan commits for an empty file set",
    );
    expect(calls.chat).toHaveLength(0);
    expect(calls.responses).toHaveLength(0);
  });

  test("planCommits appends a commit for missed hunks", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("missed-hunks"), model: "gpt-5.3-codex" },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [{ hunks: [0], path: "src/app.ts" }],
                    message: commitMessage("feat(app): update first hunk"),
                  },
                ]),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: commitMessage("fix(app): cover second hunk"),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [{ hunks: [0], path: "src/app.ts" }],
                    message: commitMessage("feat(app): update first hunk"),
                  },
                  {
                    files: [{ hunks: [1], path: "src/app.ts" }],
                    message: commitMessage("fix(app): cover second hunk"),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("missed-hunks");

    const result = await ai.planCommits(
      [makeFile("src/app.ts", 2)],
      formatFileDiff,
    );

    expect(calls.chat).toHaveLength(3);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      files: [{ hunks: [0], path: "src/app.ts" }],
      message: commitMessage("feat(app): update first hunk"),
    });
    expect(result[1]).toEqual({
      files: [{ hunks: [1], path: "src/app.ts" }],
      message: commitMessage("fix(app): cover second hunk"),
    });
  });

  test("planCommits does not duplicate zero-hunk file-level changes as missed files", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("zero-hunk-coverage"),
        model: "gpt-5.3-codex",
      },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [{ path: "script.sh" }, { path: "src/app.ts" }],
                    message: commitMessage(
                      "chore(core): keep staged file-level changes together",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("zero-hunk-coverage");

    const result = await ai.planCommits(
      [makeZeroHunkFile("script.sh"), makeFile("src/app.ts")],
      formatFileDiff,
      0,
      { deferFinalization: true },
    );

    expect(calls.chat).toHaveLength(1);
    expect(result).toEqual([
      {
        files: [{ path: "script.sh" }, { path: "src/app.ts" }],
        message: commitMessage(
          "chore(core): keep staged file-level changes together",
        ),
      },
    ]);
  });

  test("planCommits falls back to a single commit when grouping JSON is invalid", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("invalid-grouping"),
        model: "gpt-5.3-codex",
      },
    });
    installOpenAiMock({
      chatQueue: [
        { choices: [{ message: { content: "```json\nnot valid json\n```" } }] },
        {
          choices: [
            {
              message: {
                content: commitMessage("chore(core): fallback grouping"),
              },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("invalid-grouping-json");
    const files = [makeFile("src/a.ts"), makeFile("src/b.ts")];

    const result: PlannedCommit[] = await ai.planCommits(files, formatFileDiff);

    expect(result).toEqual([
      {
        files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        message: commitMessage("chore(core): fallback grouping"),
      },
    ]);
  });

  test("planCommits emits a planner decision event when grouping falls back", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("grouping-fallback-event"),
        model: "gpt-5.3-codex",
      },
    });
    installOpenAiMock({
      chatQueue: [
        { choices: [{ message: { content: "not valid json" } }] },
        {
          choices: [
            {
              message: {
                content: commitMessage("chore(core): fallback grouping"),
              },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("grouping-fallback-event");
    const events: {
      content: string;
      kind?: string;
      stage: string;
      transport?: string;
    }[] = [];
    ai.setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    await ai.planCommits(
      [makeFile("src/a.ts"), makeFile("src/b.ts")],
      formatFileDiff,
    );

    expect(
      events.some((event) => {
        if (event.kind !== "planner-decision" || event.stage !== "group") {
          return false;
        }

        return event.content.includes('"decision":"grouping-fallback"');
      }),
    ).toBe(true);
  });

  test("planCommits falls back when grouping response is suspiciously large", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("too-many-groups"),
        model: "gpt-5.3-codex",
      },
    });
    const tooManyGroups = Array.from({ length: 101 }, (_, index) => ({
      files: [{ path: "src/a.ts" }],
      message: `feat(core): group ${index}`,
    }));
    installOpenAiMock({
      chatQueue: [
        { choices: [{ message: { content: JSON.stringify(tooManyGroups) } }] },
        {
          choices: [
            {
              message: {
                content: commitMessage("chore(core): collapse groups"),
              },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("too-many-groups");

    const result = await ai.planCommits(
      [makeFile("src/a.ts", 2)],
      formatFileDiff,
    );

    expect(result).toEqual([
      {
        files: [{ path: "src/a.ts" }],
        message: commitMessage("chore(core): collapse groups"),
      },
    ]);
  });

  test("planCommits keeps moderate multi-file changesets in one grouping pass", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("single-pass"), model: "gpt-5.3-codex" },
    });
    const files = [
      makeFile(".gitleaks.toml"),
      makeFile("eslint.config.js"),
      makeFile(".gitignore"),
      makeFile(".jscpd.json"),
      makeFile("knip.json"),
      makeFile("scripts/check.json"),
      makeFile("scripts/check.ts"),
      makeFile("logo.svg"),
      makeFile(".secretlintrc"),
      makeFile("package.json"),
      makeFile("bun.lock"),
      makeFile("tests/ai-coverage.test.ts"),
      makeFile("tests/git-coverage.test.ts"),
      makeFile("README.md"),
      makeFile("src/commit-planning/orchestration.ts"),
    ];
    const grouping = [
      {
        files: files.map((file) => ({ path: file.path })),
        message: commitMessage(
          "chore(tooling): bundle quality workflow updates",
        ),
      },
    ];
    const calls = installOpenAiMock({
      chatQueue: [
        { choices: [{ message: { content: JSON.stringify(grouping) } }] },
      ],
    });
    const ai = await importFreshAi("single-pass");

    const result: PlannedCommit[] = await ai.planCommits(files, formatFileDiff);

    expect(calls.chat).toHaveLength(1);
    expect(result).toEqual(grouping);

    const payload = calls.chat[0]?.payload as {
      messages?: { content?: string; role?: string }[];
    };
    const userPrompt = payload.messages?.find(
      (msg) => msg.role === "user",
    )?.content;
    expect(userPrompt).toContain("scripts/check.ts");
    expect(userPrompt).toContain("tests/ai-coverage.test.ts");
    expect(userPrompt).toContain("package.json");
  });

  test("planCommits consolidates adjacent related groups", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("adjacent-support"),
        model: "gpt-5.3-codex",
      },
    });
    const files = [
      makeFile("eslint.config.js"),
      makeFile("package.json", 2),
      makeFile("scripts/check.json"),
      makeFile("scripts/check.ts"),
      makeFile("logo.svg"),
    ];
    const grouping = [
      {
        files: [
          { hunks: [0], path: "eslint.config.js" },
          { hunks: [0, 1], path: "package.json" },
          { hunks: [0], path: "scripts/check.json" },
        ],
        message: commitMessage(
          "chore(tooling): add lint config and check manifest",
        ),
      },
      {
        files: [{ path: "scripts/check.ts" }],
        message: commitMessage(
          "feat(scripts): add configurable bun check runner",
        ),
      },
      {
        files: [{ path: "logo.svg" }],
        message: commitMessage("style(branding): refresh logo artwork"),
      },
    ];
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [{ message: { content: JSON.stringify(grouping) } }],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { hunks: [0], path: "eslint.config.js" },
                      { hunks: [0, 1], path: "package.json" },
                      { hunks: [0], path: "scripts/check.json" },
                      { path: "scripts/check.ts" },
                    ],
                    message: commitMessage(
                      "chore(tooling): add bun check workflow",
                    ),
                  },
                  {
                    files: [{ path: "logo.svg" }],
                    message: commitMessage(
                      "style(branding): refresh logo artwork",
                    ),
                  },
                ]),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: ".gitleaks.toml" },
                      { path: ".secretlintrc" },
                      { hunks: [0], path: ".gitignore" },
                      { hunks: [0], path: ".jscpd.json" },
                      { path: "bun.lock" },
                      { hunks: [0], path: "eslint.config.js" },
                      { hunks: [0, 1], path: "package.json" },
                      { hunks: [0], path: "scripts/check.json" },
                      { path: "scripts/check.ts" },
                      { path: "tests/ai-coverage.test.ts" },
                      { path: "tests/git-coverage.test.ts" },
                      { path: "tests/tsconfig.json" },
                      { path: "knip.json" },
                      { path: ".husky/pre-commit" },
                    ],
                    message: commitMessage(
                      "chore(tooling): add quality and validation workflow",
                    ),
                  },
                  {
                    files: [{ path: "logo.svg" }],
                    message: commitMessage(
                      "style(branding): refresh logo artwork",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("adjacent-support");

    const result = await ai.planCommits(files, formatFileDiff);

    expect(calls.chat.length).toBeGreaterThanOrEqual(2);
    expect(calls.chat.length).toBeLessThanOrEqual(4);
    expect(calls.chat.length).toBeLessThanOrEqual(9);
    expect(result).toEqual([
      {
        files: [
          { hunks: [0], path: "eslint.config.js" },
          { hunks: [0, 1], path: "package.json" },
          { hunks: [0], path: "scripts/check.json" },
          { path: "scripts/check.ts" },
        ],
        message: commitMessage("chore(tooling): add bun check workflow"),
      },
      {
        files: [{ path: "logo.svg" }],
        message: commitMessage("style(branding): refresh logo artwork"),
      },
    ]);
  });

  test("planCommits finalizes regrouping after batching", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("batched-support"),
        model: "gpt-5.3-codex",
      },
    });
    const configFiles = Array.from({ length: 28 }, (_, index) =>
      makeFile(`config-${String(index).padStart(2, "0")}.json`),
    );
    const files = [...configFiles, makeFile("logo.svg")];
    const firstBatchFiles = configFiles.slice(0, 24);
    const secondBatchFiles = configFiles.slice(24);
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: firstBatchFiles
                      .slice(0, 12)
                      .map((file) => ({ path: file.path })),
                    message: commitMessage(
                      "chore(eslint): configure linter validation pipeline",
                    ),
                  },
                  {
                    files: firstBatchFiles
                      .slice(12)
                      .map((file) => ({ path: file.path })),
                    message: commitMessage(
                      "chore(audit): integrate dependency security scanning",
                    ),
                  },
                ]),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: secondBatchFiles
                      .slice(0, 2)
                      .map((file) => ({ path: file.path })),
                    message: commitMessage(
                      "chore(coverage): enforce branch threshold metrics",
                    ),
                  },
                  {
                    files: secondBatchFiles
                      .slice(2)
                      .map((file) => ({ path: file.path })),
                    message: commitMessage(
                      "chore(reporting): provision dashboard analytics widgets",
                    ),
                  },
                  {
                    files: [{ path: "logo.svg" }],
                    message: commitMessage(
                      "style(branding): refresh logo artwork",
                    ),
                  },
                ]),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: configFiles.map((file) => ({ path: file.path })),
                    message: commitMessage(
                      "chore(tooling): add quality workflow foundation",
                    ),
                  },
                  {
                    files: [{ path: "logo.svg" }],
                    message: commitMessage(
                      "style(branding): refresh logo artwork",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("batched-support");

    const result = await ai.planCommits(files, formatFileDiff);

    expect(calls.chat).toHaveLength(3);
    expect(result).toHaveLength(2);
    expect(result[0]?.message).toBe(
      commitMessage("chore(tooling): add quality workflow foundation"),
    );
    expect(result[0]?.files).toHaveLength(28);
    expect(result[1]).toEqual({
      files: [{ path: "logo.svg" }],
      message: commitMessage("style(branding): refresh logo artwork"),
    });

    const firstBatchPayload = calls.chat[0]?.payload as {
      messages?: { content?: string; role?: string }[];
    };
    const firstBatchPrompt = firstBatchPayload.messages?.find(
      (message) => message.role === "user",
    )?.content;
    expect(firstBatchPrompt).toContain("Overall changeset context:");
    expect(firstBatchPrompt).toContain("overall 29-file changeset");
    expect(firstBatchPrompt).toContain("logo.svg");
  });

  test("planCommits keeps distinct tooling reasons separate during consolidation", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("workflow-rollup"),
        model: "gpt-5.3-codex",
      },
    });
    const files = [
      makeFile(".gitleaks.toml"),
      makeFile(".secretlintrc"),
      makeFile(".gitignore"),
      makeFile(".jscpd.json"),
      makeFile("bun.lock"),
      makeFile("eslint.config.js"),
      makeFile("package.json", 2),
      makeFile("scripts/check.json"),
      makeFile("scripts/check.ts"),
      makeFile("tests/ai-coverage.test.ts"),
      makeFile("tests/git-coverage.test.ts"),
      makeFile("tests/tsconfig.json"),
      makeFile("knip.json"),
      makeFile(".husky/pre-commit"),
      makeFile("logo.svg"),
    ];
    const fragmentedGrouping = [
      {
        files: [
          { path: ".gitleaks.toml" },
          { path: ".secretlintrc" },
          { hunks: [0], path: ".gitignore" },
        ],
        message: commitMessage(
          "chore(security): add secret scanning config and ignore outputs",
        ),
      },
      {
        files: [{ hunks: [0], path: ".jscpd.json" }],
        message: commitMessage(
          "chore(quality): add jscpd duplicate code detection config",
        ),
      },
      {
        files: [{ path: "bun.lock" }],
        message: commitMessage(
          "chore(deps): update bun lockfile with new linting toolchain",
        ),
      },
      {
        files: [
          { hunks: [0], path: "eslint.config.js" },
          { hunks: [0, 1], path: "package.json" },
          { hunks: [0], path: "scripts/check.json" },
        ],
        message: commitMessage(
          "chore(tooling): add ESLint and unified quality check config",
        ),
      },
      {
        files: [{ path: "scripts/check.ts" }],
        message: commitMessage(
          "feat(scripts): add configurable bun check orchestrator script",
        ),
      },
      {
        files: [
          { path: "tests/ai-coverage.test.ts" },
          { path: "tests/git-coverage.test.ts" },
          { path: "tests/tsconfig.json" },
        ],
        message: commitMessage(
          "test(coverage): add AI and git coverage test suites",
        ),
      },
      {
        files: [{ path: "knip.json" }],
        message: commitMessage(
          "chore(knip): add unused-code analysis configuration",
        ),
      },
      {
        files: [{ path: ".husky/pre-commit" }],
        message: commitMessage(
          "chore(husky): remove pre-commit API key guard hook",
        ),
      },
      {
        files: [{ path: "logo.svg" }],
        message: commitMessage("style(branding): refresh logo artwork"),
      },
    ];
    const workflowRollupResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify([
              {
                files: [
                  { path: ".gitleaks.toml" },
                  { path: ".secretlintrc" },
                  { hunks: [0], path: ".gitignore" },
                  { hunks: [0], path: ".jscpd.json" },
                  { path: "bun.lock" },
                  { hunks: [0], path: "eslint.config.js" },
                  { hunks: [0, 1], path: "package.json" },
                  { hunks: [0], path: "scripts/check.json" },
                  { path: "scripts/check.ts" },
                  { path: "tests/ai-coverage.test.ts" },
                  { path: "tests/git-coverage.test.ts" },
                  { path: "tests/tsconfig.json" },
                  { path: "knip.json" },
                  { path: ".husky/pre-commit" },
                ],
                message: commitMessage(
                  "chore(tooling): add quality and validation workflow",
                ),
              },
              {
                files: [{ path: "logo.svg" }],
                message: commitMessage("style(branding): refresh logo artwork"),
              },
            ]),
          },
        },
      ],
    };
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            { message: { content: JSON.stringify(fragmentedGrouping) } },
          ],
        },
        ...Array.from({ length: 8 }, () => workflowRollupResponse),
      ],
    });
    const ai = await importFreshAi("workflow-rollup");

    const result: PlannedCommit[] = await ai.planCommits(files, formatFileDiff);

    expect(calls.chat.length).toBeGreaterThanOrEqual(2);
    expect(calls.chat.length).toBeLessThanOrEqual(9);
    expect(
      result.map((group) => ({
        files: group.files.map((file) => file.path),
        subject: group.message.split("\n", 1)[0],
      })),
    ).toEqual([
      {
        files: [
          "bun.lock",
          "eslint.config.js",
          "package.json",
          "scripts/check.json",
          "scripts/check.ts",
        ],
        subject:
          "feat(scripts): add configurable bun check orchestrator script",
      },
      {
        files: [".gitleaks.toml", ".secretlintrc", ".gitignore"],
        subject:
          "chore(security): add secret scanning config and ignore outputs",
      },
      {
        files: [".jscpd.json", "knip.json"],
        subject: "chore(quality): add jscpd duplicate code detection config",
      },
      {
        files: [".husky/pre-commit"],
        subject: "chore(husky): remove pre-commit API key guard hook",
      },
      {
        files: ["logo.svg"],
        subject: "style(branding): refresh logo artwork",
      },
      {
        files: ["tests/ai-coverage.test.ts"],
        subject: "test(ai): add AI and git coverage test suites",
      },
      {
        files: ["tests/git-coverage.test.ts"],
        subject: "test(git): add AI and git coverage test suites",
      },
      {
        files: ["tests/tsconfig.json"],
        subject: "test(tsconfig): add AI and git coverage test suites",
      },
    ]);
  });

  test("planCommits repeats consolidation until the plan stabilizes", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("iterative-consolidation"),
        model: "gpt-5.3-codex",
      },
    });
    const files = [
      makeFile("eslint.config.js"),
      makeFile("package.json", 2),
      makeFile("scripts/check.json"),
      makeFile("scripts/check.ts"),
      makeFile("tests/ai-coverage.test.ts"),
      makeFile("logo.svg"),
    ];
    const partiallyConsolidated = [
      {
        files: [
          { path: "eslint.config.js" },
          { hunks: [0], path: "package.json" },
          { path: "scripts/check.json" },
          { path: "scripts/check.ts" },
        ],
        message: commitMessage("chore(tooling): add lint and quality runner"),
      },
      {
        files: [
          { path: "tests/ai-coverage.test.ts" },
          { hunks: [1], path: "package.json" },
        ],
        message: commitMessage("test(tooling): cover quality workflow"),
      },
      {
        files: [{ path: "logo.svg" }],
        message: commitMessage("style(branding): refresh logo artwork"),
      },
    ];
    const fullyConsolidated = [
      {
        files: [
          { path: "eslint.config.js" },
          { hunks: [0, 1], path: "package.json" },
          { path: "scripts/check.json" },
          { path: "scripts/check.ts" },
          { path: "tests/ai-coverage.test.ts" },
        ],
        message: commitMessage(
          "chore(tooling): add quality workflow and coverage",
        ),
      },
      {
        files: [{ path: "logo.svg" }],
        message: commitMessage("style(branding): refresh logo artwork"),
      },
    ];
    const fragmentedGrouping = [
      {
        files: [
          { path: "eslint.config.js" },
          { hunks: [0], path: "package.json" },
        ],
        message: commitMessage("chore(tooling): add lint and quality runner"),
      },
      {
        files: [{ path: "scripts/check.json" }],
        message: commitMessage(
          "chore(tooling): stage quality-runner configuration files",
        ),
      },
      {
        files: [{ path: "scripts/check.ts" }],
        message: commitMessage("chore(tooling): add lint and quality runner"),
      },
      {
        files: [
          { path: "tests/ai-coverage.test.ts" },
          { hunks: [1], path: "package.json" },
        ],
        message: commitMessage("test(tooling): cover quality workflow"),
      },
      {
        files: [{ path: "logo.svg" }],
        message: commitMessage("style(branding): refresh logo artwork"),
      },
    ];
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            { message: { content: JSON.stringify(fragmentedGrouping) } },
          ],
        },
        {
          choices: [
            { message: { content: JSON.stringify(partiallyConsolidated) } },
          ],
        },
        {
          choices: [
            { message: { content: JSON.stringify(fullyConsolidated) } },
          ],
        },
      ],
    });
    const ai = await importFreshAi("iterative-consolidation");

    const result = await ai.planCommits(files, formatFileDiff);

    expect(calls.chat).toHaveLength(3);
    expect(result).toEqual(fullyConsolidated);
  });

  test("planCommits merges adjacent cosmetic groups in the same structural area", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("cosmetic-area-merge"),
        model: "gpt-5.3-codex",
      },
    });
    const files = [
      makeFile("src/app/dashboard/components/Background.tsx"),
      makeFile("src/app/dashboard/components/DashboardTopHeaderBar.tsx"),
      makeFile("src/app/dashboard/components/settings/SettingsModal.tsx"),
      makeFile("src/app/dashboard/hooks/useFeedLoader.ts"),
      makeFile("src/app/dashboard/services/dashboard-view-model.ts"),
      makeFile("src/lib/auth/session.ts"),
    ];
    const grouping = [
      {
        files: [
          { path: "src/app/dashboard/components/Background.tsx" },
          { path: "src/app/dashboard/components/DashboardTopHeaderBar.tsx" },
        ],
        message: commitMessage(
          "style(dashboard): normalize prop and attribute ordering",
        ),
      },
      {
        files: [
          { path: "src/app/dashboard/components/settings/SettingsModal.tsx" },
        ],
        message: commitMessage(
          "style(settings): normalize prop ordering and JSX attribute layout",
        ),
      },
      {
        files: [{ path: "src/app/dashboard/hooks/useFeedLoader.ts" }],
        message:
          "style(dashboard-hooks): normalize hook type and object formatting\n\n- Keep behavior unchanged while improving readability.",
      },
      {
        files: [{ path: "src/app/dashboard/services/dashboard-view-model.ts" }],
        message: commitMessage(
          "refactor(dashboard): reorganize helper layout without changing behavior",
          "- Keep behavior unchanged while improving structure.",
        ),
      },
      {
        files: [{ path: "src/lib/auth/session.ts" }],
        message: commitMessage(
          "refactor(auth): extract session cache invalidation",
        ),
      },
    ];
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [{ message: { content: JSON.stringify(grouping) } }],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [
                      { path: "src/app/dashboard/components/Background.tsx" },
                      {
                        path: "src/app/dashboard/components/DashboardTopHeaderBar.tsx",
                      },
                      {
                        path: "src/app/dashboard/components/settings/SettingsModal.tsx",
                      },
                      { path: "src/app/dashboard/hooks/useFeedLoader.ts" },
                    ],
                    message: commitMessage(
                      "style(dashboard): normalize dashboard formatting and layout",
                    ),
                  },
                  {
                    files: [
                      {
                        path: "src/app/dashboard/services/dashboard-view-model.ts",
                      },
                    ],
                    message: commitMessage(
                      "refactor(dashboard): reorganize helper layout without changing behavior",
                      "- Keep behavior unchanged while improving structure.",
                    ),
                  },
                  {
                    files: [{ path: "src/lib/auth/session.ts" }],
                    message: commitMessage(
                      "refactor(auth): extract session cache invalidation",
                    ),
                  },
                ]),
              },
            },
          ],
        },
      ],
    });
    const ai = await importFreshAi("cosmetic-area-merge");

    const result = await ai.planCommits(files, formatFileDiff);

    expect(calls.chat).toHaveLength(2);
    expect(result).toEqual([
      {
        files: [{ path: "src/app/dashboard/services/dashboard-view-model.ts" }],
        message: commitMessage(
          "refactor(dashboard): reorganize helper layout without changing behavior",
          "- Keep behavior unchanged while improving structure.",
        ),
      },
      {
        files: [{ path: "src/lib/auth/session.ts" }],
        message: commitMessage(
          "refactor(auth): extract session cache invalidation",
        ),
      },
      {
        files: [
          { path: "src/app/dashboard/components/Background.tsx" },
          { path: "src/app/dashboard/components/DashboardTopHeaderBar.tsx" },
          { path: "src/app/dashboard/components/settings/SettingsModal.tsx" },
          { path: "src/app/dashboard/hooks/useFeedLoader.ts" },
        ],
        message: commitMessage(
          "style(dashboard): normalize dashboard formatting and layout",
          "- Summarize the change.",
          "- Keep behavior unchanged while improving readability.",
        ),
      },
    ]);
  });

  test("planCommits pre-merges style-sweep fragmentation deterministically", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("premerge-style"), model: "gpt-5.3-codex" },
    });
    // 2 feat + 5 style files — style commits all have similar descriptions
    const featFiles = [
      makeFile("src/auth/login.ts"),
      makeFile("src/auth/signup.ts"),
    ];
    const styleFiles = [
      makeFile("src/dashboard/Router.tsx"),
      makeFile("src/dashboard/Card.tsx"),
      makeFile("src/hooks/types.ts"),
      makeFile("src/services/batch.ts"),
      makeFile("src/lib/parsers.ts"),
    ];
    const allFiles = [...featFiles, ...styleFiles];

    const fragmentedGrouping = [
      {
        files: featFiles.map((f) => ({ path: f.path })),
        message: commitMessage("feat(auth): add signup flow"),
      },
      ...styleFiles.map((f) => ({
        files: [{ path: f.path }],
        message: commitMessage(`style: normalize import ordering in ${f.path}`),
      })),
    ];
    // 1 feat + 5 style = 6; below CLUSTERING_THRESHOLD so no clustering
    expect(fragmentedGrouping).toHaveLength(6);

    // After pre-merge: 1 feat + 1 merged style = 2 commits
    // Consolidation runs once (2 > 1), same length → break
    const consolidatedPlan = [
      {
        files: featFiles.map((f) => ({ path: f.path })),
        message: commitMessage("feat(auth): add signup flow"),
      },
      {
        files: styleFiles.map((f) => ({ path: f.path })),
        message: commitMessage(
          "style: normalize import ordering across modules",
        ),
      },
    ];

    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            { message: { content: JSON.stringify(fragmentedGrouping) } },
          ],
        },
        {
          choices: [{ message: { content: JSON.stringify(consolidatedPlan) } }],
        },
      ],
    });

    const ai = await importFreshAi("premerge-style");
    const result = await ai.planCommits(allFiles, formatFileDiff);

    // grouping only: deterministic pre-merge drops the plan to two commits and
    // the narrower merge gate skips follow-up consolidation.
    expect(calls.chat).toHaveLength(1);
    expect(result).toHaveLength(2);
    const styleCommit = result.find(
      (c: { files: unknown[]; message: string }) => c.message.includes("style"),
    );
    expect(styleCommit?.files).toHaveLength(5);
  });

  test("planCommits pre-merges even when AI assigns duplicate hunks across commits", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("premerge-dup-hunks"),
        model: "gpt-5.3-codex",
      },
    });

    // File with 3 hunks — the AI assigns hunk 0 to BOTH style commits
    // (a real-world failure mode: the model double-assigns a hunk).
    const sharedFile = makeFile("src/dashboard/Router.tsx", 3);
    const uniqueFileA = makeFile("src/dashboard/Card.tsx");
    const uniqueFileB = makeFile("src/hooks/types.ts");
    const featFile = makeFile("src/auth/login.ts");
    const allFiles = [sharedFile, uniqueFileA, uniqueFileB, featFile];

    const fragmentedGrouping = [
      {
        files: [{ path: featFile.path }],
        message: commitMessage("feat(auth): add login"),
      },
      {
        // Claims hunks 0,1 of sharedFile + all hunks of uniqueFileA
        files: [
          { hunks: [0, 1], path: sharedFile.path },
          { path: uniqueFileA.path },
        ],
        message: commitMessage(
          "style(dashboard): normalize import ordering in Router",
        ),
      },
      {
        // Claims hunk 0 (DUPLICATE!) and 2 of sharedFile + all hunks of
        // uniqueFileB — hunk 0 overlaps with the commit above.
        files: [
          { hunks: [0, 2], path: sharedFile.path },
          { path: uniqueFileB.path },
        ],
        message: commitMessage(
          "style(hooks): normalize import ordering in types",
        ),
      },
    ];

    // After pre-merge the two style commits collapse into 1 → total = 2.
    // The merged style commit claims hunks {0,1,2} (union) of sharedFile.
    // Previously this would fail because hasMatchingCoverage rejected
    // the merge when hunk 0 appeared twice in "before" but once in "after".
    const consolidatedPlan = [
      {
        files: [{ path: featFile.path }],
        message: commitMessage("feat(auth): add login"),
      },
      {
        files: [
          { path: sharedFile.path },
          { path: uniqueFileA.path },
          { path: uniqueFileB.path },
        ],
        message: commitMessage(
          "style: normalize import ordering across modules",
        ),
      },
    ];

    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            { message: { content: JSON.stringify(fragmentedGrouping) } },
          ],
        },
        {
          choices: [{ message: { content: JSON.stringify(consolidatedPlan) } }],
        },
      ],
    });

    const ai = await importFreshAi("premerge-dup-hunks");
    const result = await ai.planCommits(allFiles, formatFileDiff);

    // grouping only: deterministic pre-merge drops the plan to two commits and
    // the narrower merge gate skips follow-up consolidation.
    expect(calls.chat).toHaveLength(1);
    // Pre-merge collapsed the 2 style commits despite duplicate hunk 0
    expect(result).toHaveLength(2);
  });

  test("planCommits uses AI clustering when plan exceeds threshold", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("cluster-merge"), model: "gpt-5.3-codex" },
    });
    // Build enough files so the initial grouping produces >= CLUSTERING_THRESHOLD commits
    const featFiles = [
      makeFile("src/app/components/legal/metadata.ts"),
      makeFile("src/app/components/legal/content.tsx"),
      makeFile("src/app/components/legal/actions.ts"),
      makeFile("src/lib/api/auth/service.ts"),
      makeFile("src/lib/api/auth/session.ts"),
    ];
    const styleFiles = [
      makeFile("src/app/dashboard/DashboardRouter.tsx"),
      makeFile("src/app/dashboard/components/ArticleCard.tsx"),
      makeFile("src/app/dashboard/hooks/types.ts"),
      makeFile("src/app/dashboard/services/feed-batch.ts"),
      makeFile("src/lib/api/feeds/parsers.ts"),
      makeFile("src/lib/core/feed-http.ts"),
      makeFile("src/lib/db/db.ts"),
      makeFile("src/lib/distill/distill.ts"),
    ];
    const allFiles = [...featFiles, ...styleFiles];

    // Diverse style descriptions so pre-merge does NOT collapse them
    // (pre-merge requires ≥50% word overlap to merge)
    const styleDescriptions = [
      "style(dashboard): reorganize component class names",
      "style(components): simplify conditional rendering",
      "style(hooks): extract inline callbacks",
      "style(services): flatten nested ternary expressions",
      "style(parsers): collapse single-statement arrow fns",
      "style(core): align catch block formatting",
      "style(db): remove trailing whitespace",
      "style(distill): standardize return statement spacing",
    ];
    const fragmentedGrouping = [
      {
        files: featFiles.slice(0, 3).map((f) => ({ path: f.path })),
        message: commitMessage("feat(legal): add legal document framework"),
      },
      {
        files: [{ path: featFiles[3].path }, { path: featFiles[4].path }],
        message: commitMessage("feat(auth): include consent in signup"),
      },
      ...styleFiles.map((f, i) => ({
        files: [{ path: f.path }],
        message: commitMessage(styleDescriptions[i]),
      })),
    ];
    // fragmentedGrouping length = 2 + 8 = 10 (>= CLUSTERING_THRESHOLD)
    expect(fragmentedGrouping).toHaveLength(10);

    // Cluster response: keep 0 and 1 separate (different features), collapse 2-9 into one style commit
    const clusterResponse = [[0], [1], [2, 3, 4, 5, 6, 7, 8, 9]];

    // After clustering: 3 commits — consolidation still runs once
    const consolidatedPlan = [
      {
        files: featFiles.slice(0, 3).map((f) => ({ path: f.path })),
        message: commitMessage("feat(legal): add legal document framework"),
      },
      {
        files: [{ path: featFiles[3].path }, { path: featFiles[4].path }],
        message: commitMessage("feat(auth): include consent in signup"),
      },
      {
        files: styleFiles.map((f) => ({ path: f.path })),
        message: commitMessage(
          "style(codebase): normalize import ordering across modules",
        ),
      },
    ];

    const calls = installOpenAiMock({
      chatQueue: [
        // grouping call → 10 fragmented commits
        {
          choices: [
            { message: { content: JSON.stringify(fragmentedGrouping) } },
          ],
        },
        // cluster call → 3 clusters
        {
          choices: [{ message: { content: JSON.stringify(clusterResponse) } }],
        },
        // consolidation call on the already-3-commit clustered plan
        {
          choices: [{ message: { content: JSON.stringify(consolidatedPlan) } }],
        },
        {
          choices: [{ message: { content: JSON.stringify(consolidatedPlan) } }],
        },
        {
          choices: [{ message: { content: JSON.stringify(consolidatedPlan) } }],
        },
        {
          choices: [{ message: { content: JSON.stringify(consolidatedPlan) } }],
        },
      ],
    });

    const ai = await importFreshAi("cluster-merge");
    const result = await ai.planCommits(allFiles, formatFileDiff);

    // grouping + cluster + consolidation = 3 calls
    expect(calls.chat.length).toBeGreaterThanOrEqual(3);
    expect(calls.chat.length).toBeLessThanOrEqual(10);
    // Final result still preserves the two feature commits while collapsing the
    // eight singleton style commits into a much smaller grouped remainder.
    expect(result.length).toBeLessThan(fragmentedGrouping.length);
    expect(
      result.some((group: PlannedCommit) =>
        group.message.includes("feat(legal): add legal document framework"),
      ),
    ).toBe(true);
    expect(
      result.some((group: PlannedCommit) =>
        group.message.includes("feat(auth): include consent in signup"),
      ),
    ).toBe(true);
    const styleCommitFileCount = result
      .filter((group: PlannedCommit) => group.message.includes("style"))
      .reduce(
        (sum: number, group: PlannedCommit) => sum + group.files.length,
        0,
      );
    expect(styleCommitFileCount).toBe(styleFiles.length);
  });

  /**
   *
   * Root cause: batched grouping produced 43 commits, many of which were nearly
   * identical "style: normalize import ordering" fragments from different
   * batches.  Phase 0 (deterministic pre-merge) collapses the 8 style fragments
   * into 1 without any AI call; Phase 1 (cluster) fires since 36 ≥ threshold.
   *
   * Test replays the exact 43 commit subjects from that run.
   *
   * This test replays the exact 43 commit subjects from that run as the grouping
   * response and asserts that the three-phase finalizer (pre-merge → cluster →
   * consolidation) reduces the plan to an acceptable bound.
   *
   * Phase 0 (deterministic pre-merge): all 8 style commits share "normalize",
   * "import", "ordering" word overlap → collapse into 1.  No AI call needed.
   * → 36 commits remain (≥ CLUSTERING_THRESHOLD=10).
   *
   * Phase 1 (AI cluster): 36 → 9 semantic clusters.
   *
   * Phase 2 (AI consolidation): 9 → 7 final commits.
   */
  describe("planCommits - librerss 43-commit regression", () => {
    // ── helpers ────────────────────────────────────────────────────────────────

    /** Build a minimal FileDiff with the requested number of hunks. */
    function rFile(path: string, n = 1): FileDiff {
      return makeFile(path, n);
    }

    /** Produce a PlannedCommit fixture used in the grouping mock response. */
    function rCommit(
      subject: string,
      paths: string[],
      hunks?: (number[] | undefined)[],
    ): { files: { hunks?: number[]; path: string }[]; message: string } {
      return {
        files: paths.map((p, i) => {
          const h = hunks?.[i];
          return h && h.length > 0 ? { hunks: h, path: p } : { path: p };
        }),
        message: commitMessage(subject),
      };
    }

    test("reduces 43 fragmented commits to ≤8 via pre-merge + cluster + consolidation", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("librerss-regression"),
          model: "gpt-5.3-codex",
        },
      });

      // ── All files touched in the real run ──────────────────────────────────
      const allFiles: FileDiff[] = [
        // Commit 1 – e2e infrastructure
        rFile("next.config.ts", 2),
        rFile("playwright.config.ts"),
        rFile("package.json", 9),
        rFile(".gitignore", 2),
        rFile(".secretlintignore"),
        rFile("README.md"),
        // Commit 2 – lint modernise
        rFile("eslint.config.mjs", 5),
        rFile(".prettierignore"),
        rFile(".stylelintrc.json"),
        rFile("drizzle.config.ts"),
        // Commit 3 – check suite
        rFile("scripts/check.json", 5),
        // Commit 4 – env vars
        rFile(".env", 2),
        // Commit 5 – deps / knip
        rFile("knip.json", 2),
        // Commit 6 – playwright scripts (new files)
        rFile("scripts/generate-playwright-coverage.mjs"),
        rFile("scripts/run-playwright.ts"),
        // Commit 7 + 8 – check.ts (11 hunks total)
        rFile("scripts/check.ts", 11),
        // Commit 9 – account API
        rFile("src/app/api/account/export/route.ts"),
        rFile("src/app/api/account/route.ts"),
        // Commit 10 – script polish
        rFile("scripts/test-pipeline-proxy.ts"),
        rFile("scripts/test-reading-pipeline-regen-results.ts"),
        // Commit 11 – proxy creds
        rFile("src/app/api/settings/proxy/route.ts"),
        rFile("src/app/api/articles/extract/route.ts", 6),
        rFile("src/app/api/settings/proxy/compatibility-check/route.ts"),
        rFile("src/app/api/articles/proxy-status/route.ts", 3),
        rFile("src/app/api/settings/proxy/test-bot-detection/route.ts"),
        // Commit 12 – articles-extract refactor
        // (extract/route.ts already in allFiles above)
        // Commit 13 – auth signup
        rFile("src/app/api/auth/signup/route.ts"),
        // Commit 14 – legal components
        rFile("src/app/components/LegalDocumentPage.tsx"),
        rFile("src/app/components/legal/content.tsx"),
        rFile("src/app/components/legal/metadata.ts"),
        // Commit 15 – login view
        rFile("src/app/dashboard/components/login/LoginView.tsx", 6),
        // Commit 16 + 19 – style sweeps (dashboard)
        rFile("src/app/dashboard/DashboardRouter.tsx", 2),
        rFile("src/app/dashboard/components/ArticleCard.tsx", 2),
        rFile("src/app/dashboard/components/BackgroundParticles.tsx"),
        rFile("src/app/dashboard/components/BackgroundStars.tsx"),
        rFile("src/app/dashboard/components/DashboardDesktopSidebar.tsx"),
        rFile("src/app/dashboard/components/DashboardLoadingSurfaces.tsx"),
        rFile(
          "src/app/dashboard/components/DashboardMobileSidebarSheet.tsx",
          2,
        ),
        rFile("src/app/dashboard/components/DashboardShellSkeleton.tsx", 2),
        rFile("src/app/dashboard/components/DashboardSidebarContent.tsx"),
        rFile("src/app/dashboard/components/DashboardTopHeaderBar.tsx", 2),
        rFile("src/app/dashboard/components/DashboardTopTokenBar.tsx"),
        rFile("src/app/dashboard/components/PullToRefreshSentinel.tsx"),
        rFile("src/app/dashboard/components/feed/FeedCategory.tsx"),
        rFile("src/app/dashboard/components/feed/FeedList.tsx", 4),
        // Commit 17 – settings account
        rFile(
          "src/app/dashboard/components/settings/SettingsAccountSection.tsx",
        ),
        rFile("src/app/dashboard/components/settings/SettingsModal.tsx", 6),
        // Commit 18 – proxy rename
        rFile(
          "src/app/dashboard/components/settings/SettingsProxySection.tsx",
          19,
        ),
        rFile(
          "src/app/dashboard/components/settings/SettingsDisplaySection.tsx",
          3,
        ),
        // Commit 19 – style settings + hooks
        rFile(
          "src/app/dashboard/components/settings/SettingsCategoryAccordionItem.tsx",
          2,
        ),
        rFile("src/app/dashboard/components/settings/SettingsCategoryList.tsx"),
        rFile("src/app/dashboard/components/settings/SettingsFeedRow.tsx"),
        rFile("src/app/dashboard/hooks/types.ts"),
        rFile("src/app/dashboard/hooks/useArticleActions.ts", 2),
        rFile("src/app/dashboard/hooks/useArticleReadState.ts"),
        rFile("src/app/dashboard/hooks/useCategoryCrudActions.ts", 2),
        rFile("src/app/dashboard/hooks/useDashboardController.ts", 2),
        rFile("src/app/dashboard/hooks/useDashboardEffects.ts"),
        rFile("src/app/dashboard/hooks/useDashboardEvents.ts"),
        rFile("src/app/dashboard/hooks/useDashboardHandlers.ts"),
        rFile("src/app/dashboard/hooks/useDashboardState.ts", 2),
        rFile("src/app/dashboard/hooks/useFeedLoader.ts", 2),
        rFile("src/app/dashboard/hooks/useFeedSourceActions.ts", 2),
        rFile("src/app/dashboard/hooks/useSettingsModalState.ts", 2),
        rFile("src/app/dashboard/hooks/useDashboardCategoryTree.ts"),
        rFile("src/app/dashboard/hooks/useDashboardIntervals.ts"),
        rFile("src/app/dashboard/hooks/useFeedSurface.ts"),
        // Commit 20 – hook refactor
        rFile("src/app/dashboard/hooks/useCategoryOrderState.ts", 2),
        // Commit 21 – style imports services
        rFile("src/app/dashboard/page.tsx", 2),
        rFile("src/app/dashboard/services/article-filters.ts"),
        rFile("src/app/dashboard/services/category-display.ts"),
        rFile("src/app/dashboard/services/category-operations.ts", 2),
        rFile("src/app/dashboard/services/category-tree.ts", 2),
        rFile("src/app/dashboard/services/dashboard-view-model.ts"),
        rFile("src/app/dashboard/services/feed-batch-outcome.ts", 2),
        rFile("src/app/dashboard/services/feed-batch-resolver.ts"),
        rFile("src/app/dashboard/services/feed-batch.ts"),
        rFile("src/app/dashboard/services/feed-loader-helpers.ts"),
        rFile("src/app/dashboard/services/feed-source-operations.ts", 3),
        rFile("src/app/dashboard/services/feed-source-tree.ts"),
        rFile("src/app/dashboard/services/opml-import.ts", 2),
        rFile("src/app/dashboard/services/selection.ts"),
        rFile("src/app/layout.tsx"),
        rFile("src/components/AppThemeProvider.tsx"),
        rFile("src/lib/api/feed-service.ts", 2),
        rFile("src/lib/api/feeds/parsers.ts", 2),
        rFile("src/lib/api/article-service.ts", 5),
        // Commit 22 – proxy rename
        // (article-service.ts + feed-source-operations.ts already above)
        // Commit 23 – legal pages
        rFile("src/app/privacy/page.tsx"),
        rFile("src/app/terms/page.tsx"),
        rFile("src/app/landing/page.tsx", 4),
        rFile("src/lib/api/auth-service.ts", 2),
        // Commit 24 – account-service
        rFile("src/lib/api/account-service.ts"),
        // Commit 25 – config refactor
        rFile("src/lib/config.ts", 2),
        // Commit 26 – feed-http fix
        rFile("src/lib/core/feed-http.ts", 2),
        // Commit 27 – async refactor
        rFile("src/lib/api/http/client.ts", 2),
        rFile("src/lib/db/neon-provider.ts", 3),
        // Commit 28 – style imports lib
        rFile("src/lib/api/feeds/read.ts", 2),
        rFile("src/lib/api/feeds/repository.ts", 2),
        rFile("src/lib/api/http/request.ts"),
        rFile("src/lib/api/http/responses.ts"),
        rFile("src/lib/auth/session.ts", 2),
        rFile("src/lib/core/feed-batch-pipeline.ts"),
        rFile("src/lib/core/feed-cache.ts"),
        rFile("src/lib/core/feed-fetcher.ts", 2),
        rFile("src/lib/core/feed-refresh.ts", 2),
        rFile("src/lib/core/feed-url-validator.ts", 2),
        rFile("src/lib/core/mark-stream-read.ts", 2),
        rFile("src/lib/core/placeholder.ts"),
        rFile("src/lib/db/db.ts", 2),
        rFile("src/lib/db/node-postgres-provider.ts", 2),
        rFile("src/lib/db/query-executor.ts", 2),
        rFile("src/lib/db/types.ts"),
        rFile("src/lib/distill/distill.ts"),
        rFile("src/lib/distill/librerss.ts"),
        rFile("src/lib/extract/cache.ts"),
        // Commit 29 – services barrel
        rFile("src/lib/api/services.ts"),
        // Commit 30 – fetch rename
        rFile("src/lib/fetch/compatibility-signal.ts"),
        rFile("src/lib/fetch/index.ts"),
        rFile("src/lib/extract/upstream.ts"),
        // Commit 31 – proxy server + tests
        rFile("src/lib/utils/url.ts", 4),
        rFile("src/lib/server/proxy.ts"),
        rFile("src/lib/server/proxy-credentials.ts"),
        rFile("src/lib/server/index.ts"),
        rFile("tests/api-account-export.test.ts"),
        // Commit 32 – auth consent tests
        rFile("tests/api-auth-signup-consent.test.ts"),
        // Commit 33 – style lib
        rFile("src/lib/extract/snapshot.ts"),
        rFile("src/lib/fetch/axios-client.ts"),
        rFile("src/lib/fetch/fingerprint.ts"),
        rFile("src/lib/sanitize/cleaners.ts"),
        rFile("src/lib/sanitize/sanitize.ts"),
        rFile("src/lib/server/guards.ts"),
        rFile("src/lib/utils/opml.ts"),
        rFile("src/lib/index.ts"),
        rFile("tailwind.config.ts"),
        rFile("tests/api-feeds-batch.test.ts"),
        rFile("tests/api-feeds.test.ts"),
        rFile("src/lib/server/rate-limit.ts"),
        // Commit 34 – api-services tests
        rFile("tests/api-services.test.ts", 4),
        // Commit 35 – style tests
        rFile("tests/auth-credentials.test.ts"),
        rFile("tests/auth.test.ts"),
        rFile("tests/core-batch-pipeline.test.ts"),
        rFile("tests/dashboard-article-actions.test.ts", 2),
        rFile("tests/dashboard-article-card.test.tsx"),
        rFile("tests/dashboard-hooks.test.ts", 2),
        rFile("tests/dashboard-login-skeleton.test.tsx"),
        rFile("tests/dashboard-page-size.test.ts"),
        rFile("tests/dashboard-preview-mode.test.tsx"),
        rFile("tests/dashboard-shell-skeleton.test.tsx"),
        rFile("tests/dashboard-top-header-bar.test.tsx"),
        rFile("tests/dashboard-top-token-bar.test.tsx"),
        rFile("tests/db.test.ts"),
        // Commit 36 – e2e dashboard tests
        rFile("tests/e2e/dashboard-preview.e2e.ts"),
        rFile("tests/e2e/dashboard-preview-safety.e2e.ts"),
        rFile("tests/e2e/dashboard-explore-articles.e2e.ts"),
        rFile("tests/e2e/dashboard-interaction-coverage.e2e.ts"),
        // Commit 37 – e2e legal tests
        rFile("tests/e2e/helpers.ts"),
        rFile("tests/e2e/test.ts"),
        rFile("tests/e2e/public-legal-pages.e2e.ts"),
        // Commit 38 – style feed tests
        rFile("tests/feed-category.test.tsx"),
        rFile("tests/feed-fetcher.test.ts", 2),
        rFile("tests/feed-list.test.tsx"),
        rFile("tests/feed-parser.test.ts"),
        rFile("tests/feed-repository.test.ts"),
        // Commit 39 – feed-surface timing
        rFile("tests/feed-surface.test.tsx"),
        // Commit 40 – fetch rename tests
        rFile("tests/fetch-fingerprint.test.ts", 3),
        rFile("tests/fetch-upstream.test.ts", 4),
        rFile("tests/reading-pipeline.test.ts", 4),
        // Commit 41 – proxy tests
        rFile("tests/utils-url.test.ts"),
        rFile("tests/proxy-settings.test.ts", 8),
        // Commit 42 – tsconfig
        rFile("tsconfig.json", 3),
        // Commit 43 – style tests cleanup
        rFile("tests/fetch-helpers.test.ts"),
        rFile("tests/fetch-proxy.test.ts"),
        rFile("tests/hooks-storage.test.ts"),
        rFile("tests/proxy.test.ts"),
        rFile("tests/server-guards.test.ts"),
        rFile("tests/setup.ts"),
        rFile("tests/swipe-gesture.test.tsx"),
        rFile("tests/viewport-restore.test.tsx"),
      ];

      // Deduplicate by path (some files appear across multiple commits)
      const seen = new Set<string>();
      const uniqueFiles = allFiles.filter((f) => {
        if (seen.has(f.path)) return false;
        seen.add(f.path);
        return true;
      });

      const fileByPath = new Map(uniqueFiles.map((f) => [f.path, f]));

      /**
       * The 43-commit grouping response that the real AI produced.
       * Subjects are verbatim from the real run.  File paths are a subset of
       * uniqueFiles.  Where a file was genuinely split across two commits in
       * the real run, hunks are used to partition coverage so every hunk
       * belongs to exactly one commit (required by hasMatchingCoverage).
       * package.json (9 hunks): C0→[0..2], C1→[3..6], C4→[7,8]
       * scripts/check.ts (11 hunks): C6→[0..5], C7→[6..10]
       * src/app/api/articles/extract/route.ts (6 hunks): C10→[0..2], C11→[3..5]
       * src/app/dashboard/components/settings/SettingsDisplaySection.tsx (3 hunks):
       *   C17→[0,1], C18→[2]
       * src/lib/api/article-service.ts (5 hunks): C20→[0..2], C21→[3,4]
       * src/app/dashboard/services/feed-source-operations.ts (3 hunks): C20→[0,1], C21→[2]
       * src/lib/utils/url.ts (4 hunks): C30→[0..2], C32→[3]
       * fetch test files (varying hunks): C39 owns first portion, C42 the rest
       * tests/proxy-settings.test.ts (8 hunks): C40→[0..3], C42→[4..7]
       * tsconfig.json (3 hunks): C41→[0,1], C42→[2]
       */
      const thirtyNineFragmented = [
        // 0 – feat(e2e)  [package.json hunks 0-2]
        rCommit(
          "feat(e2e): add Playwright runner and isolated Next dev setup",
          [
            "next.config.ts",
            "playwright.config.ts",
            "package.json",
            ".gitignore",
            ".secretlintignore",
            "README.md",
          ],
          [undefined, undefined, [0, 1, 2], undefined, undefined, undefined],
        ),
        // 1 – chore(lint)  [package.json hunks 3-6]
        rCommit(
          "chore(lint): modernize ESLint flat config and remove stylelint flow",
          [
            "eslint.config.mjs",
            ".prettierignore",
            ".stylelintrc.json",
            "package.json",
            "drizzle.config.ts",
          ],
          [undefined, undefined, undefined, [3, 4, 5, 6], undefined],
        ),
        // 2 – chore(check)
        rCommit(
          "chore(check): extend quality suite with audit and e2e coverage",
          ["scripts/check.json"],
        ),
        // 3 – feat(config)
        rCommit(
          "feat(config): add legal and proxy compatibility env variables",
          [".env"],
        ),
        // 4 – chore(deps)  [package.json hunks 7-8]
        rCommit(
          "chore(deps): refresh runtime dependencies and knip metadata",
          ["knip.json", "package.json"],
          [undefined, [7, 8]],
        ),
        // 5 – feat(scripts)
        rCommit(
          "feat(scripts): add Playwright run wrapper with coverage generation",
          [
            "scripts/generate-playwright-coverage.mjs",
            "scripts/run-playwright.ts",
          ],
        ),
        // 6 – feat(check) timeout drain  [check.ts hunks 0-5]
        rCommit(
          "feat(check): improve timeout drain handling for timed-out steps",
          ["scripts/check.ts"],
          [[0, 1, 2, 3, 4, 5]],
        ),
        // 7 – fix(check)  [check.ts hunks 6-10]
        rCommit(
          "fix(check): handle suite-deadline expiry during output processing",
          ["scripts/check.ts"],
          [[6, 7, 8, 9, 10]],
        ),
        // 8 – feat(api-account)
        rCommit(
          "feat(api-account): add account export and deletion endpoints",
          [
            "src/app/api/account/export/route.ts",
            "src/app/api/account/route.ts",
          ],
        ),
        // 9 – chore(scripts)
        rCommit("chore(scripts): polish script wording and import ordering", [
          "scripts/test-pipeline-proxy.ts",
          "scripts/test-reading-pipeline-regen-results.ts",
        ]),
        // 10 – feat(proxy)  [extract/route.ts hunks 0-2]
        rCommit(
          "feat(proxy): support secure stored proxy credentials across APIs",
          [
            "src/app/api/settings/proxy/route.ts",
            "src/app/api/articles/extract/route.ts",
            "src/app/api/settings/proxy/compatibility-check/route.ts",
            "src/app/api/articles/proxy-status/route.ts",
            "src/app/api/settings/proxy/test-bot-detection/route.ts",
          ],
          [undefined, [0, 1, 2], undefined, undefined, undefined],
        ),
        // 11 – refactor(articles-extract)  [extract/route.ts hunks 3-5]
        rCommit(
          "refactor(articles-extract): clean imports and localize placeholder state",
          ["src/app/api/articles/extract/route.ts"],
          [[3, 4, 5]],
        ),
        // 12 – feat(auth-signup)
        rCommit(
          "feat(auth-signup): require legal consent version and inject deps",
          ["src/app/api/auth/signup/route.ts"],
        ),
        // 13 – feat(legal) components
        rCommit("feat(legal): add deployment-aware legal page content system", [
          "src/app/components/LegalDocumentPage.tsx",
          "src/app/components/legal/content.tsx",
          "src/app/components/legal/metadata.ts",
        ]),
        // 14 – feat(auth) login view
        rCommit(
          "feat(auth): require legal consent during signup in login view",
          ["src/app/dashboard/components/login/LoginView.tsx"],
        ),
        // 15 – style(dashboard) C16
        rCommit(
          "style(dashboard): normalize import order and minor formatting",
          [
            "src/app/dashboard/DashboardRouter.tsx",
            "src/app/dashboard/components/ArticleCard.tsx",
            "src/app/dashboard/components/BackgroundParticles.tsx",
            "src/app/dashboard/components/BackgroundStars.tsx",
            "src/app/dashboard/components/DashboardDesktopSidebar.tsx",
            "src/app/dashboard/components/DashboardLoadingSurfaces.tsx",
            "src/app/dashboard/components/DashboardMobileSidebarSheet.tsx",
            "src/app/dashboard/components/DashboardShellSkeleton.tsx",
            "src/app/dashboard/components/DashboardSidebarContent.tsx",
            "src/app/dashboard/components/DashboardTopHeaderBar.tsx",
            "src/app/dashboard/components/DashboardTopTokenBar.tsx",
            "src/app/dashboard/components/PullToRefreshSentinel.tsx",
            "src/app/dashboard/components/feed/FeedCategory.tsx",
            "src/app/dashboard/components/feed/FeedList.tsx",
          ],
        ),
        // 16 – feat(settings)
        rCommit("feat(settings): add account privacy and deletion section", [
          "src/app/dashboard/components/settings/SettingsAccountSection.tsx",
          "src/app/dashboard/components/settings/SettingsModal.tsx",
        ]),
        // 17 – refactor(settings)  [SettingsDisplaySection.tsx hunks 0-1]
        rCommit(
          "refactor(settings): rename proxy test to compatibility check",
          [
            "src/app/dashboard/components/settings/SettingsProxySection.tsx",
            "src/app/dashboard/components/settings/SettingsDisplaySection.tsx",
          ],
          [undefined, [0, 1]],
        ),
        // 18 – style(dashboard) C19  [SettingsDisplaySection.tsx hunk 2]
        rCommit(
          "style(dashboard): normalize import ordering and spacing",
          [
            "src/app/dashboard/components/settings/SettingsCategoryAccordionItem.tsx",
            "src/app/dashboard/components/settings/SettingsCategoryList.tsx",
            "src/app/dashboard/components/settings/SettingsDisplaySection.tsx",
            "src/app/dashboard/components/settings/SettingsFeedRow.tsx",
            "src/app/dashboard/hooks/types.ts",
            "src/app/dashboard/hooks/useArticleActions.ts",
            "src/app/dashboard/hooks/useArticleReadState.ts",
            "src/app/dashboard/hooks/useCategoryCrudActions.ts",
            "src/app/dashboard/hooks/useDashboardController.ts",
            "src/app/dashboard/hooks/useDashboardEffects.ts",
            "src/app/dashboard/hooks/useDashboardEvents.ts",
            "src/app/dashboard/hooks/useDashboardHandlers.ts",
            "src/app/dashboard/hooks/useDashboardState.ts",
            "src/app/dashboard/hooks/useFeedLoader.ts",
            "src/app/dashboard/hooks/useFeedSourceActions.ts",
            "src/app/dashboard/hooks/useSettingsModalState.ts",
            "src/app/dashboard/hooks/useDashboardCategoryTree.ts",
            "src/app/dashboard/hooks/useDashboardIntervals.ts",
            "src/app/dashboard/hooks/useFeedSurface.ts",
          ],
          // SettingsDisplaySection.tsx is at index 2, hunk 2 only
          [
            undefined,
            undefined,
            [2],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
          ],
        ),
        // 19 – refactor(dashboard-hooks) C20
        rCommit(
          "refactor(dashboard-hooks): use explicit undefined in empty catches",
          ["src/app/dashboard/hooks/useCategoryOrderState.ts"],
        ),
        // 20 – style(imports) C21  [article-service.ts hunks 0-2, feed-source-operations.ts hunks 0-1]
        rCommit(
          "style(imports): normalize import ordering across app and services",
          [
            "src/app/dashboard/page.tsx",
            "src/app/dashboard/services/article-filters.ts",
            "src/app/dashboard/services/category-display.ts",
            "src/app/dashboard/services/category-operations.ts",
            "src/app/dashboard/services/category-tree.ts",
            "src/app/dashboard/services/dashboard-view-model.ts",
            "src/app/dashboard/services/feed-batch-outcome.ts",
            "src/app/dashboard/services/feed-batch-resolver.ts",
            "src/app/dashboard/services/feed-batch.ts",
            "src/app/dashboard/services/feed-loader-helpers.ts",
            "src/app/dashboard/services/feed-source-operations.ts",
            "src/app/dashboard/services/feed-source-tree.ts",
            "src/app/dashboard/services/opml-import.ts",
            "src/app/dashboard/services/selection.ts",
            "src/app/layout.tsx",
            "src/components/AppThemeProvider.tsx",
            "src/lib/api/feed-service.ts",
            "src/lib/api/feeds/parsers.ts",
            "src/lib/api/article-service.ts",
          ],
          [
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [0, 1],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [0, 1, 2],
          ],
        ),
        // 21 – refactor(proxy) C22  [article-service.ts hunks 3-4, feed-source-operations.ts hunk 2]
        rCommit(
          "refactor(proxy): rename compatibility API and user-facing labels",
          [
            "src/lib/api/article-service.ts",
            "src/app/dashboard/services/feed-source-operations.ts",
          ],
          [[3, 4], [2]],
        ),
        // 22 – feat(legal) pages C23  [auth-service.ts is unique here]
        rCommit("feat(legal): add policy pages and wire consent/version UX", [
          "src/app/privacy/page.tsx",
          "src/app/terms/page.tsx",
          "src/app/landing/page.tsx",
          "src/lib/api/auth-service.ts",
        ]),
        // 23 – feat(account-api) C24
        rCommit("feat(account-api): add client for account delete and export", [
          "src/lib/api/account-service.ts",
        ]),
        // 24 – refactor(config) C25
        rCommit(
          "refactor(config): rename proxy compatibility rate limit keys",
          ["src/lib/config.ts"],
        ),
        // 25 – fix(feed-http) C26
        rCommit("fix(feed-http): clarify DataDome 403 error message", [
          "src/lib/core/feed-http.ts",
        ]),
        // 26 – refactor(async) C27
        rCommit(
          "refactor(async): return explicit undefined in no-op disposers",
          ["src/lib/api/http/client.ts", "src/lib/db/neon-provider.ts"],
        ),
        // 27 – style(imports) C28
        rCommit("style(imports): normalize import grouping and ordering", [
          "src/lib/api/feeds/read.ts",
          "src/lib/api/feeds/repository.ts",
          "src/lib/api/http/request.ts",
          "src/lib/api/http/responses.ts",
          "src/lib/auth/session.ts",
          "src/lib/core/feed-batch-pipeline.ts",
          "src/lib/core/feed-cache.ts",
          "src/lib/core/feed-fetcher.ts",
          "src/lib/core/feed-refresh.ts",
          "src/lib/core/feed-url-validator.ts",
          "src/lib/core/mark-stream-read.ts",
          "src/lib/core/placeholder.ts",
          "src/lib/db/db.ts",
          "src/lib/db/node-postgres-provider.ts",
          "src/lib/db/query-executor.ts",
          "src/lib/db/types.ts",
          "src/lib/distill/distill.ts",
          "src/lib/distill/librerss.ts",
          "src/lib/extract/cache.ts",
        ]),
        // 28 – feat(api-services) C29
        rCommit(
          "feat(api-services): export AccountService from service barrel",
          ["src/lib/api/services.ts"],
        ),
        // 29 – refactor(fetch) C30
        rCommit(
          "refactor(fetch): rename bot detection to compatibility signals",
          [
            "src/lib/fetch/compatibility-signal.ts",
            "src/lib/fetch/index.ts",
            "src/lib/extract/upstream.ts",
          ],
        ),
        // 30 – feat(server) C31  [url.ts hunks 0-2]
        rCommit(
          "feat(server): secure proxy credential handling and URL sanitization",
          [
            "src/lib/utils/url.ts",
            "src/lib/server/proxy.ts",
            "src/lib/server/proxy-credentials.ts",
            "src/lib/server/index.ts",
            "tests/api-account-export.test.ts",
          ],
          [[0, 1, 2], undefined, undefined, undefined, undefined],
        ),
        // 31 – test(auth) C32
        rCommit("test(auth): add signup legal consent route coverage", [
          "tests/api-auth-signup-consent.test.ts",
        ]),
        // 32 – style(lib) C33  [url.ts hunk 3]
        rCommit(
          "style(lib): normalize import ordering and minor wording cleanup",
          [
            "src/lib/extract/snapshot.ts",
            "src/lib/fetch/axios-client.ts",
            "src/lib/fetch/fingerprint.ts",
            "src/lib/sanitize/cleaners.ts",
            "src/lib/sanitize/sanitize.ts",
            "src/lib/server/guards.ts",
            "src/lib/utils/opml.ts",
            "src/lib/index.ts",
            "tailwind.config.ts",
            "tests/api-feeds-batch.test.ts",
            "tests/api-feeds.test.ts",
            "src/lib/utils/url.ts",
            "src/lib/server/rate-limit.ts",
          ],
          [
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [3],
            undefined,
          ],
        ),
        // 33 – test(api-services) C34
        rCommit(
          "test(api-services): align auth and proxy API service expectations",
          ["tests/api-services.test.ts"],
        ),
        // 34 – style(tests) C35
        rCommit(
          "style(tests): normalize import ordering and spacing in test files",
          [
            "tests/auth-credentials.test.ts",
            "tests/auth.test.ts",
            "tests/core-batch-pipeline.test.ts",
            "tests/dashboard-article-actions.test.ts",
            "tests/dashboard-article-card.test.tsx",
            "tests/dashboard-hooks.test.ts",
            "tests/dashboard-login-skeleton.test.tsx",
            "tests/dashboard-page-size.test.ts",
            "tests/dashboard-preview-mode.test.tsx",
            "tests/dashboard-shell-skeleton.test.tsx",
            "tests/dashboard-top-header-bar.test.tsx",
            "tests/dashboard-top-token-bar.test.tsx",
            "tests/db.test.ts",
          ],
        ),
        // 35 – test(e2e-dashboard) C36
        rCommit(
          "test(e2e-dashboard): add comprehensive preview and interaction coverage",
          [
            "tests/e2e/dashboard-preview.e2e.ts",
            "tests/e2e/dashboard-preview-safety.e2e.ts",
            "tests/e2e/dashboard-explore-articles.e2e.ts",
            "tests/e2e/dashboard-interaction-coverage.e2e.ts",
          ],
        ),
        // 36 – test(e2e) C37
        rCommit(
          "test(e2e): add shared Playwright base and legal page coverage",
          [
            "tests/e2e/helpers.ts",
            "tests/e2e/test.ts",
            "tests/e2e/public-legal-pages.e2e.ts",
          ],
        ),
        // 37 – style(tests) C38
        rCommit(
          "style(tests): normalize import ordering and spacing in feed tests",
          [
            "tests/feed-category.test.tsx",
            "tests/feed-fetcher.test.ts",
            "tests/feed-list.test.tsx",
            "tests/feed-parser.test.ts",
            "tests/feed-repository.test.ts",
          ],
        ),
        // 38 – test(feed-surface) C39
        rCommit(
          "test(feed-surface): stabilize async timing with deterministic timers",
          ["tests/feed-surface.test.tsx"],
        ),
        // 39 – test(fetch) C40  [fetch-fingerprint hunks 0-1, fetch-upstream hunks 0-2, reading-pipeline hunks 0-2]
        rCommit(
          "test(fetch): rename bot-detection wording to compatibility signal",
          [
            "tests/fetch-fingerprint.test.ts",
            "tests/fetch-upstream.test.ts",
            "tests/reading-pipeline.test.ts",
          ],
          [
            [0, 1],
            [0, 1, 2],
            [0, 1, 2],
          ],
        ),
        // 40 – test(proxy) C41  [proxy-settings hunks 0-3]
        rCommit(
          "test(proxy): cover credential migration and password encryption",
          ["tests/utils-url.test.ts", "tests/proxy-settings.test.ts"],
          [undefined, [0, 1, 2, 3]],
        ),
        // 41 – chore(tsconfig) C42  [tsconfig hunks 0-1]
        rCommit(
          "chore(tsconfig): include .next-playwright generated type files",
          ["tsconfig.json"],
          [[0, 1]],
        ),
        // 42 – style(tests) C43  [fetch-fingerprint hunk 2, fetch-upstream hunk 3, reading-pipeline hunk 3, proxy-settings hunks 4-7, tsconfig hunk 2]
        rCommit(
          "style(tests): apply formatting and import ordering cleanup",
          [
            "tests/fetch-fingerprint.test.ts",
            "tests/fetch-helpers.test.ts",
            "tests/fetch-proxy.test.ts",
            "tests/fetch-upstream.test.ts",
            "tests/hooks-storage.test.ts",
            "tests/proxy-settings.test.ts",
            "tests/proxy.test.ts",
            "tests/reading-pipeline.test.ts",
            "tests/server-guards.test.ts",
            "tests/setup.ts",
            "tests/swipe-gesture.test.tsx",
            "tests/viewport-restore.test.tsx",
            "tsconfig.json",
          ],
          [
            [2],
            undefined,
            undefined,
            [3],
            undefined,
            [4, 5, 6, 7],
            undefined,
            [3],
            undefined,
            undefined,
            undefined,
            undefined,
            [2],
          ],
        ),
      ];
      // Must be 43 items
      expect(thirtyNineFragmented).toHaveLength(43);

      // ── Validate all file paths in the mock response are in uniqueFiles ────
      for (const commit of thirtyNineFragmented) {
        for (const f of commit.files) {
          expect(
            fileByPath.has(f.path),
            `Path "${f.path}" from mock not in uniqueFiles`,
          ).toBe(true);
        }
      }

      // ── Phase 0 pre-merge (deterministic, no AI call) ─────────────────────
      // Pre-merge collapses subjects with the same type and ≥50% significant-
      // word overlap.  From the real run:
      //   • All 8 style commits merge to 1 ("normalize import ordering" family)
      //   • Related feat commits also merge: account-export group (8,16,23,28),
      //     proxy-or-server (10,30), legal-consent (12,14)
      //   • Related refactor commits: rename-proxy (17,24), explicit-undefined (19,26)
      //   • Related test commits: legal-consent-coverage (31,36)
      // Total saves: style(7) + feat(3+1+1) + refactor(1+1) + test(1) = 15
      // → 43 - 15 = 28 commits after pre-merge.  28 ≥ CLUSTERING_THRESHOLD=10.

      // ── Phase 1 cluster response ───────────────────────────────────────────
      // The cluster call receives 28 commits (indices 0-27).
      // We provide 5 pairs of small consecutive indices → 5 merged + 18 singletons
      // = 23 clusters per pass.  All pair indices are within 0-27.
      // Pass 1: 28 → 23.  Pass 2: 23 → 18.  Pass 3: 18 → 13.
      // MAX_CLUSTER_PASSES=3 reached → done.
      // consolidation fires, no mock → throws → caught as null → break.
      // Final result: 13 items (well below regressed 43).
      const clusterPairs: number[][] = [
        [0, 1],
        [2, 3],
        [4, 5],
        [6, 7],
        [8, 9],
      ];

      const calls = installOpenAiMock({
        chatQueue: [
          // Cluster pass 1 (28 → 23)
          { choices: [{ message: { content: JSON.stringify(clusterPairs) } }] },
          // Cluster pass 2 (23 → 18)
          { choices: [{ message: { content: JSON.stringify(clusterPairs) } }] },
          // Cluster pass 3 (18 → 13)
          { choices: [{ message: { content: JSON.stringify(clusterPairs) } }] },
          { choices: [{ message: { content: JSON.stringify(clusterPairs) } }] },
          { choices: [{ message: { content: JSON.stringify(clusterPairs) } }] },
          { choices: [{ message: { content: JSON.stringify(clusterPairs) } }] },
          { choices: [{ message: { content: JSON.stringify(clusterPairs) } }] },
          { choices: [{ message: { content: JSON.stringify(clusterPairs) } }] },
        ],
      });

      // Import grouping module fresh so it picks up the mocked openai module.
      const { finalizePlannedGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/index.js?librerss-regression-${Math.random()}`,
          import.meta.url,
        ).href
      );

      const result = (await finalizePlannedGroups(
        uniqueFiles,
        thirtyNineFragmented,
      )) as { message: string }[];

      // ── Assertions ─────────────────────────────────────────────────────────
      // At least 1 cluster call fired (28 post-pre-merge commits ≥ threshold=10).
      // Consolidation may also fire (if it does, the queue runs out → throws →
      // caught as null → break).  We assert a range rather than a fixed count
      // to keep the test stable if internals change the exact pass count.
      expect(calls.chat.length).toBeGreaterThanOrEqual(1);
      expect(calls.chat.length).toBeLessThanOrEqual(10);
      // Pre-merge collapsed all 8 style commits into fewer groups.
      // After clustering they merge further, but the original 8 fragments are gone.
      const styleCommits = result.filter((c) => c.message.startsWith("style"));
      // Pre-merge ensures there cannot be 8 separate style commits in the output
      expect(styleCommits.length).toBeLessThan(8);
    });

    test("premergeBySubject collapses all 8 style sweep commits to 1 group", async () => {
      const { premergeBySubject } =
        await import("../src/commit-planning/grouping/index.js");

      // The exact 43 subjects from the real librerss run, each with a
      // placeholder file so fileByPath stays consistent.
      const STYLE_SUBJECTS = [
        "style(dashboard): normalize import order and minor formatting",
        "style(dashboard): normalize import ordering and spacing",
        "style(imports): normalize import ordering across app and services",
        "style(imports): normalize import grouping and ordering",
        "style(lib): normalize import ordering and minor wording cleanup",
        "style(tests): normalize import ordering and spacing in test files",
        "style(tests): normalize import ordering and spacing in feed tests",
        "style(tests): apply formatting and import ordering cleanup",
      ];
      const NON_STYLE_SUBJECTS = [
        "feat(e2e): add Playwright runner and isolated Next dev setup",
        "chore(lint): modernize ESLint flat config and remove stylelint flow",
        "chore(check): extend quality suite with audit and e2e coverage",
        "feat(config): add legal and proxy compatibility env variables",
        "chore(deps): refresh runtime dependencies and knip metadata",
        "feat(scripts): add Playwright run wrapper with coverage generation",
        "feat(check): improve timeout drain handling for timed-out steps",
        "fix(check): handle suite-deadline expiry during output processing",
        "feat(api-account): add account export and deletion endpoints",
        "chore(scripts): polish script wording and import ordering",
        "feat(proxy): support secure stored proxy credentials across APIs",
        "refactor(articles-extract): clean imports and localize placeholder state",
        "feat(auth-signup): require legal consent version and inject deps",
        "feat(legal): add deployment-aware legal page content system",
        "feat(auth): require legal consent during signup in login view",
        "feat(settings): add account privacy and deletion section",
        "refactor(settings): rename proxy test to compatibility check",
        "refactor(dashboard-hooks): use explicit undefined in empty catches",
        "refactor(proxy): rename compatibility API and user-facing labels",
        "feat(legal): add policy pages and wire consent/version UX",
        "feat(account-api): add client for account delete and export",
        "refactor(config): rename proxy compatibility rate limit keys",
        "fix(feed-http): clarify DataDome 403 error message",
        "refactor(async): return explicit undefined in no-op disposers",
        "feat(api-services): export AccountService from service barrel",
        "refactor(fetch): rename bot detection to compatibility signals",
        "feat(server): secure proxy credential handling and URL sanitization",
        "test(auth): add signup legal consent route coverage",
        "test(api-services): align auth and proxy API service expectations",
        "test(e2e-dashboard): add comprehensive preview and interaction coverage",
        "test(e2e): add shared Playwright base and legal page coverage",
        "test(feed-surface): stabilize async timing with deterministic timers",
        "test(fetch): rename bot-detection wording to compatibility signal",
        "test(proxy): cover credential migration and password encryption",
        "chore(tsconfig): include .next-playwright generated type files",
      ];

      // Build minimal fixture: one file per commit
      const allSubjects = [...STYLE_SUBJECTS, ...NON_STYLE_SUBJECTS];
      expect(allSubjects).toHaveLength(43);

      const groups = allSubjects.map((subject, i) => ({
        files: [{ path: `file-${String(i)}.ts` }],
        message: commitMessage(subject),
      }));
      const fileByPath = new Map(
        groups.map((g) => [g.files[0].path, makeFile(g.files[0].path)]),
      );

      interface CommitFixture {
        files: { path: string }[];
        message: string;
      }
      const result = (
        premergeBySubject as (
          groups: CommitFixture[],
          fileByPath: Map<string, FileDiff>,
        ) => CommitFixture[]
      )(groups, fileByPath);

      // Pre-merge collapses multiple groups due to word overlap.
      // style(8→1) + feat groups + refactor groups + test groups → 15 saves.
      // 43 - 15 = 28 commits after pre-merge.
      expect(result).toHaveLength(28);

      // All 8 style commits collapsed into 1 merged group.
      const styleGroups = result.filter((c: CommitFixture) =>
        c.message.startsWith("style"),
      );
      expect(styleGroups).toHaveLength(1);
    });

    test("finalizePlannedGroups splits prompt rules from prompt module organization", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("prompt-rules-vs-module"),
          model: "gpt-5.3-codex",
        },
      });
      const calls = installOpenAiMock({ chatQueue: [] });
      const { finalizePlannedGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/index.js?prompt-rules-vs-module-${Math.random()}`,
          import.meta.url,
        ).href
      );

      // Simulate Grouping batch 4: prompt rules added, prompt module reorganized.
      // These should NOT merge into one planner-wide umbrella despite shared vocabulary.
      const groups = [
        {
          files: [
            { path: "src/commit-planning/prompts/rules/commit/generation.ts" },
            { path: "src/commit-planning/prompts/rules/commit/index.ts" },
            { path: "src/commit-planning/prompts/rules/commit/message.ts" },
            { path: "src/commit-planning/prompts/rules/formatting.ts" },
            { path: "src/commit-planning/prompts/rules/hunk-grouping.ts" },
            { path: "src/commit-planning/prompts/rules/index.ts" },
          ],
          message: commitMessage(
            "feat(commit-planning): add reusable prompt rule builders",
            "- Extract shared commit-message, grouping, and consolidation guidance into dedicated rule modules with runtime breaking-mode support.",
            "- Add stage prompt builders for commit generation, hunk grouping, cluster merge, and plan consolidation that compose those rules.",
          ),
        },
        {
          files: [
            {
              path: "src/commit-planning/prompt-builders/cluster-prompts.ts",
            },
            {
              path: "src/commit-planning/prompt-builders/commit-format.ts",
            },
            {
              path: "src/commit-planning/prompt-builders/consolidation-prompts.ts",
            },
            {
              path: "src/commit-planning/prompt-builders/generation-prompts.ts",
            },
            {
              path: "src/commit-planning/prompt-builders/grouping-prompts.ts",
            },
            { path: "src/commit-planning/prompts/context/diff-context.ts" },
            { path: "src/commit-planning/prompts/index.ts" },
          ],
          message: commitMessage(
            "refactor(prompts): move planner prompts under the prompts module",
            "- Replace the prompt-builders entrypoints with the new prompts module surface and re-export stage builders from a centralized index.",
            "- Relocate shared diff-context helpers under prompts/context and update import paths so prompt code shares one directory structure.",
          ),
        },
      ];
      const allFiles = groups.flatMap((group) =>
        group.files.map((file) => makeFile(file.path)),
      );

      const result = await finalizePlannedGroups(allFiles, groups);

      // These are distinct rollouts: one adds rules, one reorganizes existing builders.
      // They must stay separate despite both touching prompt modules.
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(calls.chat).toHaveLength(0);
    });

    test("finalizePlannedGroups splits grouping internals from path and export changes", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("grouping-vs-path-export"),
          model: "gpt-5.3-codex",
        },
      });
      // Allow consolidation pass that should keep them separate
      const calls = installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "src/commit-planning/grouping/ownership.ts" },
                        {
                          path: "src/commit-planning/grouping/style-splitting/area-splitting.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/style-splitting/index.ts",
                        },
                        { path: "src/commit-planning/grouping/repartition.ts" },
                      ],
                      message: commitMessage(
                        "fix(grouping): split broad consolidations by owner and style area",
                        "- Add path ownership helpers so large implementation clusters can be broken apart by dominant source subtree instead of staying over-merged.",
                        "- Preserve standalone support and style work more carefully by attaching only support groups with strong signals and keeping broad style-only areas split.",
                      ),
                    },
                    {
                      files: [
                        { path: "src/commit-planning/path-resolver.ts" },
                        { path: "src/commit-planning/path/aliases.ts" },
                        { path: "src/commit-planning/path/index.ts" },
                        { path: "src/commit-planning/path/resolver.ts" },
                      ],
                      message: commitMessage(
                        "feat(path): resolve flattened and aliased planner file paths",
                        "- Replace the single path-resolver module with a dedicated path package that separates alias generation from canonical-path resolution.",
                        "- Add project, absolute, and virtual nested-path aliases so planner output can match files referenced through flattened feature file names.",
                      ),
                    },
                    {
                      files: [
                        { path: "src/commit-planning/index.ts" },
                        { path: "src/commit-planning/openai-client.ts" },
                      ],
                      message: commitMessage(
                        "refactor(commit-planning): narrow public exports and lazy-load OpenAI",
                        "- Replace broad barrel re-exports with explicit commit-planning exports so downstream imports expose only supported planning APIs and types.",
                        "- Lazy-load the OpenAI client at call time and make client creation async to avoid eager runtime dependency initialization.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "src/cli/execution-flow.ts" },
                        { path: "src/cli/index.ts" },
                        { path: "src/cli/main.ts" },
                        { path: "src/cli/options.ts" },
                      ],
                      message: commitMessage(
                        "feat(cli): add resumable plan execution and parsed command routing",
                        "- Keep the CLI flow changes together.",
                      ),
                    },
                    {
                      files: [
                        { path: "README.md" },
                        { path: "src/application/config/schema.ts" },
                      ],
                      message: commitMessage(
                        "docs(readme): document saved plan bundles and new defaults",
                        "- Keep docs and schema defaults separate from the CLI flow changes.",
                      ),
                    },
                    {
                      files: [{ path: "tests/config.test.ts" }],
                      message: commitMessage(
                        "test(config): cover resume help, config defaults, and saved-plan bundles",
                        "- Keep config coverage separate after the support split.",
                      ),
                    },
                    {
                      files: [{ path: "tests/cli.test.ts" }],
                      message: commitMessage(
                        "test(cli): cover resume help, config defaults, and saved-plan bundles",
                        "- Keep CLI coverage separate after the support split.",
                      ),
                    },
                    {
                      files: [{ path: "tests/zz-cli-coverage.test.ts" }],
                      message: commitMessage(
                        "test(zz-cli): cover resume help, config defaults, and saved-plan bundles",
                        "- Keep saved-plan coverage separate after the support split.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/index.js?grouping-vs-path-export-${Math.random()}`,
          import.meta.url,
        ).href
      );

      // Simulate the unrelated commit-planning families that should not collapse:
      // - Grouping boundary reorganization (repartition, ownership, style-splitting)
      // - Path resolution feature (aliases, resolver)
      // - Export narrowing (index.ts tightening, lazy-load OpenAI)
      const groups = [
        {
          files: [
            { path: "src/commit-planning/grouping/ownership.ts" },
            {
              path: "src/commit-planning/grouping/style-splitting/area-splitting.ts",
            },
            {
              path: "src/commit-planning/grouping/style-splitting/index.ts",
            },
            { path: "src/commit-planning/grouping/repartition.ts" },
          ],
          message: commitMessage(
            "fix(grouping): split broad consolidations by owner and style area",
            "- Add path ownership helpers so large implementation clusters can be broken apart by dominant source subtree instead of staying over-merged.",
            "- Preserve standalone support and style work more carefully by attaching only support groups with strong signals and keeping broad style-only areas split.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/path-resolver.ts" },
            { path: "src/commit-planning/path/aliases.ts" },
            { path: "src/commit-planning/path/index.ts" },
            { path: "src/commit-planning/path/resolver.ts" },
          ],
          message: commitMessage(
            "feat(path): resolve flattened and aliased planner file paths",
            "- Replace the single path-resolver module with a dedicated path package that separates alias generation from canonical-path resolution.",
            "- Add project, absolute, and virtual nested-path aliases so planner output can match files referenced through flattened feature file names.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/index.ts" },
            { path: "src/commit-planning/openai-client.ts" },
          ],
          message: commitMessage(
            "refactor(commit-planning): narrow public exports and lazy-load OpenAI",
            "- Replace broad barrel re-exports with explicit commit-planning exports so downstream imports expose only supported planning APIs and types.",
            "- Lazy-load the OpenAI client at call time and make client creation async to avoid eager runtime dependency initialization.",
          ),
        },
      ];
      const allFiles = groups.flatMap((group) =>
        group.files.map((file) => makeFile(file.path)),
      );

      const result = await finalizePlannedGroups(allFiles, groups);

      // These are distinct ownership areas with different responsibilities.
      // They must stay separate despite all being commit-planning boundary work.
      expect(result.length).toBeGreaterThanOrEqual(3);
    });

    test("finalizePlannedGroups rejects the prompt regrouping umbrella that mixes prompts, grouping, exports, and ai tests", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("reject-prompt-regrouping-umbrella"),
          model: "gpt-5.3-codex",
        },
      });
      const calls = installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        {
                          path: "src/commit-planning/prompt-builders/cluster-prompts.ts",
                        },
                        {
                          path: "src/commit-planning/prompts/index.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/intent/index.ts",
                        },
                        { path: "src/commit-planning/openai-client.ts" },
                        { path: "src/commit-planning/index.ts" },
                        { path: "tests/ai.test.ts" },
                      ],
                      message: commitMessage(
                        "refactor(commit-planning): centralize reusable planning modules",
                        "- Combine prompt stage recomposition, grouping module reorganization, export narrowing, and lazy OpenAI loading in one planner-wide sweep.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/index.js?reject-prompt-regrouping-umbrella-${Math.random()}`,
          import.meta.url,
        ).href
      );

      const groups = [
        {
          files: [
            { path: "src/commit-planning/prompt-builders/cluster-prompts.ts" },
            { path: "src/commit-planning/prompts/index.ts" },
          ],
          message: commitMessage(
            "refactor(prompts): move planner prompts under the prompts module",
            "- Replace prompt-builder entrypoints with the prompts surface and centralized stage exports.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/grouping/intent/index.ts" }],
          message: commitMessage(
            "refactor(grouping): isolate intent scoring exports",
            "- Move intent helpers behind a dedicated grouping namespace.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/openai-client.ts" },
            { path: "src/commit-planning/index.ts" },
          ],
          message: commitMessage(
            "refactor(commit-planning): narrow public exports and lazy-load OpenAI",
            "- Keep the public planning surface explicit while avoiding eager client construction.",
          ),
        },
        {
          files: [{ path: "tests/ai.test.ts" }],
          message: commitMessage(
            "test(prompts): follow prompt module import relocation",
            "- Retarget prompt coverage to the new prompts entrypoint.",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(calls.chat).toHaveLength(1);
      expect(result.length).toBeGreaterThanOrEqual(4);
      const umbrellaCommit = result.find(
        (group: PlannedCommit) =>
          group.files.some((file) =>
            file.path.includes("prompt-builders/cluster-prompts"),
          ) &&
          group.files.some((file) => file.path.includes("grouping/intent/")) &&
          group.files.some(
            (file) => file.path === "src/commit-planning/openai-client.ts",
          ) &&
          group.files.some((file) => file.path === "tests/ai.test.ts"),
      );
      expect(umbrellaCommit).toBeUndefined();
    });

    test("finalizePlannedGroups rejects planner mega-rollout umbrella spanning rules, path, grouping, and prompts", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("planner-mega-rollout"),
          model: "gpt-5.3-codex",
        },
      });
      // Allow consolidation passes that should keep these separate
      const calls = installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        {
                          path: "src/commit-planning/prompts/rules/commit/generation.ts",
                        },
                        {
                          path: "src/commit-planning/prompts/rules/commit/index.ts",
                        },
                        {
                          path: "src/commit-planning/prompts/rules/commit/message.ts",
                        },
                      ],
                      message: commitMessage(
                        "feat(commit-planning): add prompt rule builders for commit generation",
                        "- Extract commit-message guidance into dedicated rule modules.",
                      ),
                    },
                    {
                      files: [
                        { path: "src/commit-planning/path/aliases.ts" },
                        { path: "src/commit-planning/path/resolver.ts" },
                      ],
                      message: commitMessage(
                        "feat(path): add path alias and resolution helpers",
                        "- Support flattened and aliased planner file paths.",
                      ),
                    },
                    {
                      files: [
                        {
                          path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/support-attachment/scoring.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/support-attachment/selection.ts",
                        },
                      ],
                      message: commitMessage(
                        "feat(grouping): attach support commits to implementation owners",
                        "- Add a support-attachment module that scores ownership using coverage, dependency, scope, path, and subject-word signals.",
                      ),
                    },
                    {
                      files: [
                        {
                          path: "src/commit-planning/grouping/intent/scoring.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/merge-heuristics.ts",
                        },
                      ],
                      message: commitMessage(
                        "refactor(grouping): extract intent and merge heuristics modules",
                        "- Move intent scoring helpers into the dedicated intent namespace.",
                      ),
                    },
                    {
                      files: [
                        { path: "src/commit-planning/plan-bundles/index.ts" },
                        { path: "src/commit-planning/planned-commit-clone.ts" },
                      ],
                      message: commitMessage(
                        "feat(planning): persist reusable staged plan bundles",
                        "- Add a repo-scoped plan bundle store keyed by HEAD, repo root, staged patch, and cloned planned commits.",
                      ),
                    },
                    {
                      files: [{ path: "tests/ai-coverage.test.ts" }],
                      message: commitMessage(
                        "test(grouping): validate normalized plans without live API calls",
                        "- Import grouping response validation directly so cross-file hunk tests exercise the same normalization path used in production.",
                      ),
                    },
                    {
                      files: [{ path: "tests/ai.test.ts" }],
                      message: commitMessage(
                        "test(grouping): cover deterministic pre-merge ownership heuristics",
                        "- Add regression cases for merging deletion-heavy refactors, renamed identifier follow-ups, and prompt refactors with small test attachments.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        {
                          path: "src/commit-planning/prompts/rules/commit/generation.ts",
                        },
                        {
                          path: "src/commit-planning/prompts/rules/commit/index.ts",
                        },
                        {
                          path: "src/commit-planning/prompts/rules/commit/message.ts",
                        },
                      ],
                      message: commitMessage(
                        "feat(commit-planning): add prompt rule builders for commit generation",
                        "- Extract commit-message guidance into dedicated rule modules.",
                      ),
                    },
                    {
                      files: [
                        { path: "src/commit-planning/path/aliases.ts" },
                        { path: "src/commit-planning/path/resolver.ts" },
                      ],
                      message: commitMessage(
                        "feat(path): add path alias and resolution helpers",
                        "- Support flattened and aliased planner file paths.",
                      ),
                    },
                    {
                      files: [
                        {
                          path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/support-attachment/scoring.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/support-attachment/selection.ts",
                        },
                      ],
                      message: commitMessage(
                        "feat(grouping): attach support commits to implementation owners",
                        "- Add a support-attachment module that scores ownership using coverage, dependency, scope, path, and subject-word signals.",
                      ),
                    },
                    {
                      files: [
                        {
                          path: "src/commit-planning/grouping/intent/scoring.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/merge-heuristics.ts",
                        },
                      ],
                      message: commitMessage(
                        "refactor(grouping): extract intent and merge heuristics modules",
                        "- Move intent scoring helpers into the dedicated intent namespace.",
                      ),
                    },
                    {
                      files: [
                        { path: "src/commit-planning/plan-bundles/index.ts" },
                        {
                          path: "src/commit-planning/planned-commit-clone.ts",
                        },
                      ],
                      message: commitMessage(
                        "feat(planning): persist reusable staged plan bundles",
                        "- Add a repo-scoped plan bundle store keyed by HEAD, repo root, staged patch, and cloned planned commits.",
                      ),
                    },
                    {
                      files: [{ path: "tests/ai-coverage.test.ts" }],
                      message: commitMessage(
                        "test(grouping): validate normalized plans without live API calls",
                        "- Import grouping response validation directly so cross-file hunk tests exercise the same normalization path used in production.",
                      ),
                    },
                    {
                      files: [{ path: "tests/ai.test.ts" }],
                      message: commitMessage(
                        "test(grouping): cover deterministic pre-merge ownership heuristics",
                        "- Add regression cases for merging deletion-heavy refactors, renamed identifier follow-ups, and prompt refactors with small test attachments.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/index.js?planner-mega-rollout-${Math.random()}`,
          import.meta.url,
        ).href
      );

      // Simulate final Commit 21 shape: mega umbrella spanning unrelated planner work.
      // This represents the worst-case umbrella that the planner must reject.
      const groups = [
        {
          files: [
            { path: "src/commit-planning/prompts/rules/commit/generation.ts" },
            { path: "src/commit-planning/prompts/rules/commit/index.ts" },
            { path: "src/commit-planning/prompts/rules/commit/message.ts" },
          ],
          message: commitMessage(
            "feat(commit-planning): add prompt rule builders for commit generation",
            "- Extract commit-message guidance into dedicated rule modules.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/path/aliases.ts" },
            { path: "src/commit-planning/path/resolver.ts" },
          ],
          message: commitMessage(
            "feat(path): add path alias and resolution helpers",
            "- Support flattened and aliased planner file paths.",
          ),
        },
        {
          files: [
            {
              path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
            },
            {
              path: "src/commit-planning/grouping/support-attachment/scoring.ts",
            },
            {
              path: "src/commit-planning/grouping/support-attachment/selection.ts",
            },
          ],
          message: commitMessage(
            "feat(grouping): attach support commits to implementation owners",
            "- Add a support-attachment module that scores ownership using coverage, dependency, scope, path, and subject-word signals.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/grouping/intent/scoring.ts" },
            { path: "src/commit-planning/grouping/merge-heuristics.ts" },
          ],
          message: commitMessage(
            "refactor(grouping): extract intent and merge heuristics modules",
            "- Move intent scoring helpers into the dedicated intent namespace.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/plan-bundles/index.ts" },
            { path: "src/commit-planning/planned-commit-clone.ts" },
          ],
          message: commitMessage(
            "feat(planning): persist reusable staged plan bundles",
            "- Add a repo-scoped plan bundle store keyed by HEAD, repo root, staged patch, and cloned planned commits.",
          ),
        },
        {
          files: [{ path: "tests/ai-coverage.test.ts" }],
          message: commitMessage(
            "test(grouping): validate normalized plans without live API calls",
            "- Import grouping response validation directly so cross-file hunk tests exercise the same normalization path used in production.",
          ),
        },
        {
          files: [{ path: "tests/ai.test.ts" }],
          message: commitMessage(
            "test(grouping): cover deterministic pre-merge ownership heuristics",
            "- Add regression cases for merging deletion-heavy refactors, renamed identifier follow-ups, and prompt refactors with small test attachments.",
          ),
        },
      ];
      const allFiles = groups.flatMap((group) =>
        group.files.map((file) => makeFile(file.path)),
      );

      const result = await finalizePlannedGroups(allFiles, groups);

      // The planner must reject this mega-rollout umbrella.
      // Result should have at least 4-5 distinct commits, not 1 umbrella.
      expect(result.length).toBeGreaterThanOrEqual(4);
      const subjectLines = result.map(
        (group: PlannedCommit) => group.message.split("\n")[0],
      );

      // No single commit should contain all these unrelated families.
      const megaCommit = result.find(
        (group: PlannedCommit) =>
          group.files.some((f) =>
            f.path.includes("prompts/rules/commit/generation"),
          ) &&
          group.files.some((f) => f.path.includes("path/aliases")) &&
          group.files.some((f) =>
            f.path.includes("support-attachment/component"),
          ) &&
          group.files.some((f) => f.path.includes("plan-bundles")),
      );
      expect(megaCommit).toBeUndefined();
    });

    test("finalizePlannedGroups rejects the severe planner-stability umbrella spanning grouping, cache, validation, estimation, and coverage", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("reject-planner-stability-umbrella"),
          model: "gpt-5.3-codex",
        },
      });
      const calls = installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        {
                          path: "src/commit-planning/grouping/group/finalization.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/group/message-harmonization.ts",
                        },
                        { path: "src/commit-planning/result-cache.ts" },
                        { path: "src/commit-planning/token-estimation.ts" },
                        { path: "src/commit-planning/response-validation.ts" },
                        { path: "tests/ai-coverage.test.ts" },
                      ],
                      message: commitMessage(
                        "fix(commit-planning): stabilize planner finalization and validation",
                        "- Combine grouping stabilization, message harmonization, cache partitioning, token budgeting, normalization, and coverage into one planner-wide repair.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/index.js?reject-planner-stability-umbrella-${Math.random()}`,
          import.meta.url,
        ).href
      );

      const groups = [
        {
          files: [
            { path: "src/commit-planning/grouping/group/finalization.ts" },
            {
              path: "src/commit-planning/grouping/group/message-harmonization.ts",
            },
          ],
          message: commitMessage(
            "fix(grouping): rescope harmonized messages after consolidation",
            "- Rebuild split commit messages from covered source groups only.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/result-cache.ts" }],
          message: commitMessage(
            "fix(commit-planning): partition AI caches by prompt mode",
            "- Keep incompatible prompt-mode results from reusing stale cache entries.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/token-estimation.ts" }],
          message: commitMessage(
            "fix(planning): include prompt context in estimate follow-ups",
            "- Keep token estimates aligned with the prompts the planner actually sends.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/response-validation.ts" }],
          message: commitMessage(
            "fix(commit-planning): strip breaking metadata when runs disable it",
            "- Normalize grouped commit messages against the active prompt mode before validation.",
          ),
        },
        {
          files: [{ path: "tests/ai-coverage.test.ts" }],
          message: commitMessage(
            "test(grouping): cover planner stability regressions",
            "- Lock grouping stabilization, cache partitioning, prompt-mode validation, and budgeting boundaries with direct regressions.",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(calls.chat).toHaveLength(1);
      expect(result.length).toBeGreaterThanOrEqual(4);
      const umbrellaCommit = result.find(
        (group: PlannedCommit) =>
          group.files.some(
            (file) =>
              file.path ===
              "src/commit-planning/grouping/group/finalization.ts",
          ) &&
          group.files.some(
            (file) => file.path === "src/commit-planning/result-cache.ts",
          ) &&
          group.files.some(
            (file) => file.path === "src/commit-planning/token-estimation.ts",
          ) &&
          group.files.some(
            (file) =>
              file.path === "src/commit-planning/response-validation.ts",
          ) &&
          group.files.some((file) => file.path === "tests/ai-coverage.test.ts"),
      );
      expect(umbrellaCommit).toBeUndefined();
    });

    test("finalizePlannedGroups splits a same-subtree grouping umbrella by structural child surfaces", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("split-same-subtree-grouping-umbrella"),
          model: "gpt-5.3-codex",
        },
      });
      const calls = installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        {
                          path: "src/commit-planning/grouping/repartition.ts",
                        },
                        { path: "src/commit-planning/grouping/ownership.ts" },
                        {
                          path: "src/commit-planning/grouping/group/finalization.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/group/message-harmonization.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/support-attachment/scoring.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/style-splitting/service.ts",
                        },
                      ],
                      message: commitMessage(
                        "fix(grouping): preserve true rollout slices over umbrella merges",
                        "- Repartition broad grouping work by structural ownership boundaries instead of keeping one umbrella.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/index.js?split-same-subtree-grouping-umbrella-${Math.random()}`,
          import.meta.url,
        ).href
      );

      const groups = [
        {
          files: [
            { path: "src/commit-planning/grouping/repartition.ts" },
            { path: "src/commit-planning/grouping/ownership.ts" },
          ],
          message: commitMessage(
            "fix(grouping): repartition broad implementation groups",
            "- Rebuild broad grouping results from structural ownership signals.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/grouping/group/finalization.ts" },
            {
              path: "src/commit-planning/grouping/group/message-harmonization.ts",
            },
          ],
          message: commitMessage(
            "fix(grouping): rescope harmonized messages after consolidation",
            "- Rebuild split messages from covered source groups only.",
          ),
        },
        {
          files: [
            {
              path: "src/commit-planning/grouping/support-attachment/scoring.ts",
            },
          ],
          message: commitMessage(
            "fix(grouping): tighten support attachment scoring",
            "- Require stronger structural anchors before support work attaches to one owner.",
          ),
        },
        {
          files: [
            {
              path: "src/commit-planning/grouping/style-splitting/service.ts",
            },
          ],
          message: commitMessage(
            "fix(grouping): keep broad style sweeps split by area",
            "- Preserve ownership-aware style buckets during repartition.",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(calls.chat).toHaveLength(1);
      expect(result.length).toBeGreaterThanOrEqual(3);
      expect(
        result.some(
          (group: PlannedCommit) =>
            group.files.some(
              (file: PlannedCommit["files"][number]) =>
                file.path ===
                "src/commit-planning/grouping/group/finalization.ts",
            ) &&
            group.files.some(
              (file: PlannedCommit["files"][number]) =>
                file.path ===
                "src/commit-planning/grouping/support-attachment/scoring.ts",
            ),
        ),
      ).toBe(false);
    });

    test("finalizePlannedGroups keeps path alias rollout separate from resume export workflow umbrellas", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("split-path-alias-from-resume-exports"),
          model: "gpt-5.3-codex",
        },
      });
      const calls = installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "src/commit-planning/path-resolver.ts" },
                        { path: "src/commit-planning/orchestration.ts" },
                        { path: "src/commit-planning/output-text.ts" },
                        { path: "src/commit-planning/overlap-resolution.ts" },
                        { path: "src/commit-planning/index.ts" },
                        { path: "src/commit-planning/planned-commit-clone.ts" },
                        { path: "src/commit-planning/planning-workflow.ts" },
                      ],
                      message: commitMessage(
                        "feat(commit-planning): broaden planner file-path alias resolution",
                        "- Fold path alias resolution, orchestration exports, breaking-mode planning flow, and resume bundle finalization into one umbrella rollout.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/index.js?split-path-alias-from-resume-exports-${Math.random()}`,
          import.meta.url,
        ).href
      );

      const groups = [
        {
          files: [{ path: "src/commit-planning/path-resolver.ts" }],
          message: commitMessage(
            "feat(path): broaden planner file-path alias resolution",
            "- Keep top-level path resolver migration aligned with the dedicated path package rollout.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/orchestration.ts" },
            { path: "src/commit-planning/output-text.ts" },
            { path: "src/commit-planning/overlap-resolution.ts" },
          ],
          message: commitMessage(
            "feat(planning): thread breaking-change mode through generation paths",
            "- Carry breaking-mode prompt context through orchestration, overlap resolution, and planning output paths.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/index.ts" }],
          message: commitMessage(
            "feat(commit-planning): expose granular planner and cache exports",
            "- Keep top-level commit-planning exports explicit while publishing supported planner helpers.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/planned-commit-clone.ts" },
            { path: "src/commit-planning/planning-workflow.ts" },
          ],
          message: commitMessage(
            "feat(planning): persist resumable plan bundles with integrity checks",
            "- Keep saved-plan bundle finalization and replay state aligned with the planning workflow.",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(calls.chat).toHaveLength(1);
      expect(result.length).toBeGreaterThan(1);
      expect(
        result.some(
          (group: PlannedCommit) =>
            group.files.some(
              (file) => file.path === "src/commit-planning/path-resolver.ts",
            ) &&
            group.files.some(
              (file) => file.path === "src/commit-planning/orchestration.ts",
            ) &&
            group.files.some(
              (file) =>
                file.path === "src/commit-planning/planned-commit-clone.ts",
            ),
        ),
      ).toBe(false);
    });

    test("premergeBySubject does not merge unrelated planner families on vocabulary alone", async () => {
      const { premergeBySubject } = await import(
        new URL(
          `../src/commit-planning/grouping/subject/premerge/index.js?premerge-planner-vocab-${Math.random()}`,
          import.meta.url,
        ).href
      );

      // Simulate high word overlap planner subjects that should NOT premerge
      // because they lack a real owner or scope anchor.
      const groups = [
        {
          files: [
            { path: "src/commit-planning/prompts/rules/commit/generation.ts" },
          ],
          message: commitMessage(
            "feat(commit-planning): add prompt rule builders",
            "- Extract reusable prompt rules for commit generation.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/path/resolver.ts" }],
          message: commitMessage(
            "feat(commit-planning): add path resolution helpers",
            "- Support flattened planner file paths.",
          ),
        },
        {
          files: [
            {
              path: "src/commit-planning/grouping/support-attachment/scoring.ts",
            },
          ],
          message: commitMessage(
            "feat(commit-planning): add support attachment scoring",
            "- Score ownership for support commit attachment.",
          ),
        },
      ];
      const fileByPath = new Map(
        groups.map((g) => [g.files[0].path, makeFile(g.files[0].path)]),
      );

      const result = premergeBySubject(groups, fileByPath);

      // These should NOT merge despite all being "feat(commit-planning)" with shared
      // vocabulary like "add", "planner", "commit", etc.
      // They have different ownership roots: prompts/rules, path, grouping/support-attachment.
      expect(result).toHaveLength(3);
    });

    test("premergeBySubject merges same-scope planner work with high word overlap", async () => {
      const { premergeBySubject } = await import(
        new URL(
          `../src/commit-planning/grouping/subject/premerge/index.js?premerge-same-scope-${Math.random()}`,
          import.meta.url,
        ).href
      );

      // Same scope + high word overlap = safe premerge.
      const groups = [
        {
          files: [
            { path: "src/commit-planning/prompts/rules/commit/generation.ts" },
          ],
          message: commitMessage(
            "feat(prompts): add commit generation rules",
            "- Extract reusable commit-message guidance.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/prompts/rules/commit/index.ts" },
          ],
          message: commitMessage(
            "feat(prompts): export commit generation rules",
            "- Re-export commit-message guidance from rules index.",
          ),
        },
      ];
      const fileByPath = new Map(
        groups.map((g) => [g.files[0].path, makeFile(g.files[0].path)]),
      );

      const result = premergeBySubject(groups, fileByPath);

      // These should merge: same scope (prompts), high word overlap, same owner.
      expect(result).toHaveLength(1);
    });

    test("harmonizeConsolidatedMessages does not leak umbrella body text into narrowed CLI exports", async () => {
      const { harmonizeConsolidatedMessages } = await import(
        new URL(
          `../src/commit-planning/grouping/group/message-harmonization.js?harmony-cli-exports-${Math.random()}`,
          import.meta.url,
        ).href
      );

      // Simulate the full flow:
      // 1. Original groups: config-service, application-exports, cli-exports
      // 2. Consolidation merges all three into one umbrella
      // 3. Repartition splits CLI exports back out
      // 4. Harmonization should rebuild CLI message from original CLI group only,
      //    dropping config-service vocabulary like "validation helpers"
      const originalGroups = [
        {
          files: [{ path: "src/application/config/service.ts" }],
          message: commitMessage(
            "feat(config): add layered config loading and cached initialization",
            "- Load and validate layered config sources through the config service.",
            "- Cache loaded config to avoid redundant file system reads.",
          ),
        },
        {
          files: [{ path: "src/application/index.ts" }],
          message: commitMessage(
            "refactor(application): narrow public exports",
            "- Replace wildcard exports with explicit application surface symbols.",
          ),
        },
        {
          files: [{ path: "src/cli/main.ts" }, { path: "src/cli/options.ts" }],
          message: commitMessage(
            "refactor(cli): narrow public exports",
            "- Replace wildcard exports with explicit CLI surface symbols.",
          ),
        },
      ];

      // After repartition splits CLI back out: [config+app group, cli-only group]
      // The CLI group still has the umbrella message from consolidation,
      // but harmonization should rebuild it from the original CLI group only.
      const consolidatedGroups = [
        {
          files: [
            { path: "src/application/config/service.ts" },
            { path: "src/application/index.ts" },
          ],
          message: commitMessage(
            "refactor(exports): narrow public entrypoint re-exports",
            "- Add a dedicated config service module with cached loading, layered merges, and validation helpers behind the application surface.",
            "- Replace wildcard barrel exports with explicit symbols so consumers only see the intended config, CLI, constant, and error APIs.",
          ),
        },
        {
          files: [{ path: "src/cli/main.ts" }, { path: "src/cli/options.ts" }],
          message: commitMessage(
            "refactor(exports): narrow public entrypoint re-exports",
            "- Add a dedicated config service module with cached loading, layered merges, and validation helpers behind the application surface.",
            "- Replace wildcard barrel exports with explicit symbols so consumers only see the intended config, CLI, constant, and error APIs.",
          ),
        },
      ];

      const fileByPath = new Map(
        [
          "src/application/config/service.ts",
          "src/application/index.ts",
          "src/cli/main.ts",
          "src/cli/options.ts",
        ].map((path) => [path, makeFile(path)]),
      );

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        fileByPath,
      );

      // Result should have two groups: config+app, and CLI
      expect(result).toHaveLength(2);

      const cliGroup = result.find((g: PlannedCommit) =>
        g.files.some((f) => f.path === "src/cli/main.ts"),
      );
      expect(cliGroup).toBeDefined();
      const harmonizedMessage = cliGroup!.message;

      // The CLI group subject should be rebuilt from the original CLI group
      expect(harmonizedMessage).toContain("refactor(cli)");

      // Body should be rebuilt from covered CLI group only, NOT config-service internals
      expect(harmonizedMessage).not.toContain("layered config sources");
      expect(harmonizedMessage).not.toContain("cached initialization");
      expect(harmonizedMessage).not.toContain("validation helpers");
      expect(harmonizedMessage).not.toContain("config service");

      // Should contain CLI-specific export wording
      expect(harmonizedMessage).toContain("CLI");
    });

    test("rescopeGroupMessageToCoveredGroups rebuilds prompt body from covered prompt groups only", async () => {
      const { rescopeGroupMessageToCoveredGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/group/message-harmonization.js?rescope-prompt-${Math.random()}`,
          import.meta.url,
        ).href
      );

      // Simulate repartition splitting a broad planner umbrella that covered:
      // - prompt rules
      // - path aliases
      // - grouping support-attachment
      // After split, the prompt-only slice should not inherit path or grouping body text.
      const sourceGroups = [
        {
          files: [
            { path: "src/commit-planning/prompts/rules/commit/generation.ts" },
            { path: "src/commit-planning/prompts/rules/commit/index.ts" },
          ],
          message: commitMessage(
            "feat(prompts): add prompt rule builders",
            "- Extract commit-message guidance into dedicated rule modules.",
            "- Re-export prompt rules from the centralized prompts index.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/path/aliases.ts" },
            { path: "src/commit-planning/path/resolver.ts" },
          ],
          message: commitMessage(
            "feat(path): add path alias and resolution helpers",
            "- Support flattened and aliased planner file paths.",
            "- Add project, absolute, and virtual nested-path aliases.",
          ),
        },
        {
          files: [
            {
              path: "src/commit-planning/grouping/support-attachment/scoring.ts",
            },
          ],
          message: commitMessage(
            "feat(grouping): add support attachment scoring",
            "- Score ownership for support commit attachment using coverage and dependency signals.",
          ),
        },
      ];

      // The split prompt-only group after repartition
      const promptOnlyGroup = {
        files: [
          { path: "src/commit-planning/prompts/rules/commit/generation.ts" },
          { path: "src/commit-planning/prompts/rules/commit/index.ts" },
        ],
        message: commitMessage(
          "feat(commit-planning): add prompt rule builders and path resolution",
          "- Extract commit-message guidance into dedicated rule modules.",
          "- Re-export prompt rules from the centralized prompts index.",
          "- Support flattened and aliased planner file paths.",
          "- Add project, absolute, and virtual nested-path aliases.",
          "- Score ownership for support commit attachment using coverage and dependency signals.",
        ),
      };

      const fileByPath = new Map(
        [
          "src/commit-planning/prompts/rules/commit/generation.ts",
          "src/commit-planning/prompts/rules/commit/index.ts",
          "src/commit-planning/path/aliases.ts",
          "src/commit-planning/path/resolver.ts",
          "src/commit-planning/grouping/support-attachment/scoring.ts",
        ].map((path) => [path, makeFile(path)]),
      );

      const result = rescopeGroupMessageToCoveredGroups(
        promptOnlyGroup,
        sourceGroups,
        fileByPath,
      );

      // Subject should be rescoped to covered work
      const subjectLine = result.message.split("\n")[0];
      expect(subjectLine).toContain("feat(commit-planning)");

      // Body should ONLY contain prompt-related bullets, NOT path or grouping bullets
      expect(result.message).toContain("commit-message guidance");
      expect(result.message).toContain("prompt rules");

      expect(result.message).not.toContain(
        "flattened and aliased planner file paths",
      );
      expect(result.message).not.toContain("virtual nested-path aliases");
      expect(result.message).not.toContain("support attachment scoring");
      expect(result.message).not.toContain("coverage and dependency signals");
    });

    test("rescopeGroupMessageToCoveredGroups drops stale umbrella body for uncovered export splits", async () => {
      const { rescopeGroupMessageToCoveredGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/group/message-harmonization.js?rescope-uncovered-${Math.random()}`,
          import.meta.url,
        ).href
      );

      // Simulate an export-surface split that no longer covers any source group
      // after repartition has moved the real work elsewhere.
      const sourceGroups = [
        {
          files: [{ path: "src/commit-planning/orchestration.ts" }],
          message: commitMessage(
            "feat(commit-planning): add breaking-change mode threading",
            "- Thread breaking-change settings into generation, merge, fallback paths.",
            "- Suppress breaking markers before validation when mode is disabled.",
          ),
        },
      ];

      // The export-only slice after split
      const exportOnlyGroup = {
        files: [{ path: "src/commit-planning/index.ts" }],
        message: commitMessage(
          "refactor(commit-planning): narrow public exports and lazy-load OpenAI",
          "- Replace broad barrel re-exports with explicit commit-planning exports.",
          "- Thread breaking-change settings into generation, merge, fallback paths.",
          "- Suppress breaking markers before validation when mode is disabled.",
          "- Lazy-load the OpenAI client to avoid eager dependency initialization.",
        ),
      };

      const fileByPath = new Map([
        [
          "src/commit-planning/index.ts",
          makeFile("src/commit-planning/index.ts"),
        ],
        [
          "src/commit-planning/orchestration.ts",
          makeFile("src/commit-planning/orchestration.ts"),
        ],
      ]);

      const result = rescopeGroupMessageToCoveredGroups(
        exportOnlyGroup,
        sourceGroups,
        fileByPath,
      );

      // Subject should be rescoped to export-surface work
      const subjectLine = result.message.split("\n")[0];
      expect(subjectLine).toContain("refactor(commit-planning)");

      // Body should be dropped or rewritten to export-surface wording, NOT include orchestration internals
      expect(result.message).not.toContain("breaking-change settings");
      expect(result.message).not.toContain("generation, merge, fallback");
      expect(result.message).not.toContain("validation when mode is disabled");

      // Either empty body or a generic export message
      const bodyLines = result.message
        .split("\n")
        .slice(1)
        .filter((line: string) => line.trim().length > 0);
      if (bodyLines.length > 0) {
        expect(result.message).toContain("export");
      }
    });
  });

  /**
   * Commit-by-commit regression inventory for the current 41-commit trace.
   *
   * These tests are intentionally one-per-commit for the bad and ugly cases so
   * the failure surface stays explicit instead of being inferred from a smaller
   * number of umbrella assertions.
   */
  describe("41-commit bad and ugly regression inventory", () => {
    const makeFileMap = makeGroupingFileMap;
    const importFinalize = importFinalizeModule;
    const importGroupingMessageHarmonization =
      importGroupingMessageHarmonizationModule;
    const importRepartition = importRepartitionModule;
    const importFileSignals = importGroupingFileSignalsModule;

    function buildExactCliExportSurfaceFixture() {
      const files = [
        "src/cli/terminal/columns.ts",
        "src/cli/terminal/index.ts",
        "src/cli/terminal/line-wrapping.ts",
        "src/cli/token/index.ts",
        "src/cli/token/splitting.ts",
        "src/cli/verbose-rendering/block-render.ts",
        "src/cli/verbose-rendering/event-stats.ts",
        "src/cli/verbose-rendering/index.ts",
        "src/cli/verbose-rendering/json-trace.ts",
        "src/cli/output-presentation.ts",
        "src/cli/planner-notices.ts",
        "src/cli/session-display.ts",
        "src/cli/staging-guard.ts",
        "src/cli/verbose-output.ts",
        "src/cli/viewport.ts",
      ];

      const groups = [
        {
          files: [
            { path: "src/cli/terminal/columns.ts" },
            { path: "src/cli/terminal/index.ts" },
            { path: "src/cli/terminal/line-wrapping.ts" },
          ],
          message: commitMessage(
            "refactor(cli): tighten terminal module exports and formatting",
            "- Replace wildcard terminal exports with explicit symbols.",
          ),
        },
        {
          files: [
            { path: "src/cli/token/index.ts" },
            { path: "src/cli/token/splitting.ts" },
          ],
          message: commitMessage(
            "refactor(token): tighten terminal module exports and formatting",
            "- Replace wildcard token exports with explicit symbols.",
          ),
        },
        {
          files: [
            { path: "src/cli/verbose-rendering/block-render.ts" },
            { path: "src/cli/verbose-rendering/event-stats.ts" },
            { path: "src/cli/verbose-rendering/index.ts" },
            { path: "src/cli/verbose-rendering/json-trace.ts" },
          ],
          message: commitMessage(
            "refactor(verbose-rendering): tighten terminal module exports and formatting",
            "- Replace wildcard verbose-rendering exports with explicit symbols.",
          ),
        },
        {
          files: [
            { path: "src/cli/output-presentation.ts" },
            { path: "src/cli/planner-notices.ts" },
            { path: "src/cli/session-display.ts" },
            { path: "src/cli/staging-guard.ts" },
            { path: "src/cli/verbose-output.ts" },
            { path: "src/cli/viewport.ts" },
          ],
          message: commitMessage(
            "refactor(cli): tighten terminal module exports and formatting",
            "- Keep display and verbose-output helpers on the same explicit CLI surface.",
          ),
        },
      ];

      return { files, groups };
    }

    async function finalizeExactCliExportSurface(tag: string) {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey(tag),
          model: "gpt-5.3-codex",
        },
      });
      const { files } = buildExactCliExportSurfaceFixture();
      installOpenAiMock({
        chatQueue: Array.from({ length: 6 }, () => ({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: files.map((path) => ({ path })),
                    message: commitMessage(
                      "refactor(cli): narrow terminal and verbose rendering exports",
                      "- Replace wildcard terminal, token, verbose-rendering, and display-helper exports with one explicit CLI surface.",
                    ),
                  },
                ]),
              },
            },
          ],
        })),
      });
      const { finalizePlannedGroups } = await importFinalize(tag);
      const { groups } = buildExactCliExportSurfaceFixture();

      return finalizePlannedGroups(
        files.map((path) => makeFile(path)),
        groups,
      );
    }

    test("Commit 1 keeps terminal export cleanup with the exact CLI export-surface rollout", async () => {
      const result = await finalizeExactCliExportSurface("commit-1-terminal");

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/terminal/columns.ts",
      });
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/output-presentation.ts",
      });
    });

    test("Commit 7 keeps token export cleanup with the exact CLI export-surface rollout", async () => {
      const result = await finalizeExactCliExportSurface("commit-7-token");

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/token/index.ts",
      });
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/verbose-output.ts",
      });
    });

    test("Commit 9 keeps verbose-rendering export cleanup with the exact CLI export-surface rollout", async () => {
      const result = await finalizeExactCliExportSurface("commit-9-rendering");

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/verbose-rendering/block-render.ts",
      });
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/session-display.ts",
      });
    });

    test("Commit 37 keeps display-helper export cleanup with the exact CLI export-surface rollout", async () => {
      const result = await finalizeExactCliExportSurface("commit-37-display");

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/planner-notices.ts",
      });
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/terminal/index.ts",
      });
    });

    test("Commit 3 keeps tsconfig support attached to the breaking-mode CLI coverage it enables", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-3-tsconfig");

      const originalGroups = [
        {
          files: [{ path: "tests/zz-cli-coverage.test.ts" }],
          message: commitMessage(
            "test(cli): cover single-commit breaking-mode execution",
            "- Add CLI coverage for single-commit runs that allow breaking metadata without forcing a footer.",
          ),
        },
        {
          files: [{ path: "tsconfig.json" }],
          message: commitMessage(
            "test(cli): cover single-commit breaking-mode execution",
            "- Add the Bun type support needed for the new execution-flow coverage to compile.",
          ),
        },
      ];

      const consolidatedGroups = [
        {
          files: [
            { path: "tests/zz-cli-coverage.test.ts" },
            { path: "tsconfig.json" },
          ],
          message: commitMessage(
            "test(cli): cover single-commit breaking-mode execution",
            "- Add CLI coverage for single-commit runs that allow breaking metadata without forcing a footer.",
            "- Add the Bun type support needed for the new execution-flow coverage to compile.",
          ),
        },
      ];

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(["tests/zz-cli-coverage.test.ts", "tsconfig.json"]),
      );

      expect(result[0]?.message).toContain(
        "single-commit breaking-mode execution",
      );
      expect(result[0]?.message).toContain("Bun type support");
    });

    async function importGroupRolloutPreservation(tag: string) {
      const moduleHref = new URL(
        `../src/commit-planning/grouping/group/rollout-preservation.js?${tag}-${Math.random()}`,
        import.meta.url,
      ).href;

      return import(moduleHref);
    }

    function buildConfigExportRolloutGroup(): PlannedCommit {
      return {
        files: [
          { path: "src/application/config/service.ts" },
          { path: "src/application/config/index.ts" },
          { path: "src/application/index.ts" },
        ],
        message: commitMessage(
          "feat(application-config): expose config entrypoints directly",
          "- Add a dedicated config service and keep config and application entrypoints aligned behind explicit exports.",
        ),
      };
    }

    test("Commit 12 keeps config service introduction with the surrounding export rollout", async () => {
      const { shouldPreserveFeatureSurfaceRollout } =
        await importGroupRolloutPreservation("commit-12-config-service");
      const mergedGroup = buildConfigExportRolloutGroup();

      expect(shouldPreserveFeatureSurfaceRollout(mergedGroup)).toBe(true);
      expect(mergedGroup.files).toContainEqual({
        path: "src/application/config/service.ts",
      });
    });

    test("Commit 13 keeps config index reshaping with the surrounding export rollout", async () => {
      const { shouldPreserveFeatureSurfaceRollout } =
        await importGroupRolloutPreservation("commit-13-config-index");
      const mergedGroup = buildConfigExportRolloutGroup();

      expect(shouldPreserveFeatureSurfaceRollout(mergedGroup)).toBe(true);
      expect(mergedGroup.files).toContainEqual({
        path: "src/application/config/index.ts",
      });
    });

    test("Commit 14 keeps application export narrowing with the surrounding export rollout", async () => {
      const { shouldPreserveFeatureSurfaceRollout } =
        await importGroupRolloutPreservation("commit-14-app-index");
      const mergedGroup = buildConfigExportRolloutGroup();

      expect(shouldPreserveFeatureSurfaceRollout(mergedGroup)).toBe(true);
      expect(mergedGroup.files).toContainEqual({
        path: "src/application/index.ts",
      });
    });

    test("normalizeMixedRootImplementationGroups emits a planner decision event when a mixed-root split is preserved as one rollout", async () => {
      const observer = await import("../src/commit-planning/openai-client.js");
      const events: { content: string; kind?: string; stage: string }[] = [];
      observer.setAiOutputObserver((event: (typeof events)[number]) => {
        events.push(event);
      });
      const { normalizeMixedRootImplementationGroups } = await import(
        new URL(
          `../src/commit-planning/grouping/group/normalization.js?mixed-root-preserve-trace-${Math.random()}`,
          import.meta.url,
        ).href
      );
      const mergedGroup = {
        files: [
          { path: "src/cli/command-line-interface.ts" },
          { path: "src/cli/counts.ts" },
          { path: "src/application/config/service.ts" },
          { path: "src/application/cache-paths.ts" },
          { path: "src/application/config/index.ts" },
          { path: "src/application/config/schema.ts" },
          { path: "src/application/index.ts" },
        ],
        message: commitMessage(
          "refactor(entrypoints): keep config and public export rollout together",
          "- Keep the CLI entrypoint split, config service extraction, cache-path updates, and narrowed application exports on one rollout.",
        ),
      };
      const allFiles = mergedGroup.files.map((file) => makeFile(file.path));

      const result = normalizeMixedRootImplementationGroups(
        [mergedGroup],
        [mergedGroup],
        new Map(allFiles.map((file) => [file.path, file])),
      );

      expect(result).toEqual([mergedGroup]);
      expect(
        events.some(
          (event) =>
            event.kind === "planner-decision" &&
            event.stage === "consolidate" &&
            event.content.includes('"decision":"normalization-preserve"') &&
            event.content.includes(
              '"normalizationKind":"mixed-root-implementation"',
            ) &&
            event.content.includes('"reason":"feature-surface-rollout"'),
        ),
      ).toBe(true);
      observer.setAiOutputObserver(null);
    });

    test("Commit 17 does not let a mixed git and commit-planning style sweep keep a git-only scope", async () => {
      const { splitWeakConsolidations } = await importRepartition(
        "commit-17-style-scope",
      );
      const { buildFileChangeSignals } = await importFileSignals(
        "commit-17-style-scope",
      );

      const paths = [
        "src/git/chunks.ts",
        "src/git/diff.ts",
        "src/git/parser.ts",
        "src/commit-planning/usage-tracking.ts",
        "src/commit-planning/planning-workflow.ts",
        "src/commit-planning/planner-heuristics.ts",
        "src/commit-planning/output-text.ts",
        "src/commit-planning/overlap-resolution.ts",
      ];
      const allFiles = paths.map((path) => makeFile(path));
      const result = splitWeakConsolidations(
        [
          {
            files: paths.map((path) => ({ path })),
            message: commitMessage(
              "style(git): consolidate formatting cleanup across git helpers",
              "- Wrap long expressions and signatures across nearby helpers.",
            ),
          },
        ],
        [
          {
            files: paths.map((path) => ({ path })),
            message: commitMessage(
              "style(git): consolidate formatting cleanup across git helpers",
              "- Wrap long expressions and signatures across nearby helpers.",
            ),
          },
        ],
        new Map(allFiles.map((file) => [file.path, file])),
        buildFileChangeSignals(allFiles),
      );

      const mixedGitAndPlanningGroup = result.find(
        (group: PlannedCommit) =>
          group.files.some((file) => file.path.startsWith("src/git/")) &&
          group.files.some(
            (file) => file.path === "src/commit-planning/usage-tracking.ts",
          ),
      );
      expect(mixedGitAndPlanningGroup).toBeUndefined();
    });

    test("Commit 24 keeps git integration hardening separate from git helper extraction", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("commit-24-git-refactor"),
          model: "gpt-5.3-codex",
        },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "src/git/commit-input-validation.ts" },
                        { path: "src/git/failures.ts" },
                        { path: "src/git/path-validation.ts" },
                        { path: "src/git/output-sanitization.ts" },
                        { path: "src/git/process-environment.ts" },
                        { path: "src/git/operations.ts" },
                        { path: "src/git/operation-support.ts" },
                        { path: "tests/diff.test.ts" },
                        { path: "tests/git-coverage.test.ts" },
                      ],
                      message: commitMessage(
                        "refactor(git): split command helpers into focused modules",
                        "- Extract git command helpers while also hardening temporary Git repo initialization in integration coverage.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "src/cli/execution-flow.ts" },
                        { path: "src/cli/index.ts" },
                        { path: "src/cli/main.ts" },
                        { path: "src/cli/options.ts" },
                      ],
                      message: commitMessage(
                        "feat(cli): add resumable plan execution and parsed command routing",
                        "- Keep the CLI flow changes together.",
                      ),
                    },
                    {
                      files: [
                        { path: "README.md" },
                        { path: "src/application/config/schema.ts" },
                      ],
                      message: commitMessage(
                        "docs(readme): document saved plan bundles and new defaults",
                        "- Keep docs and schema defaults separate from the CLI flow changes.",
                      ),
                    },
                    {
                      files: [
                        { path: "tests/config.test.ts" },
                        { path: "tests/cli.test.ts" },
                        { path: "tests/zz-cli-coverage.test.ts" },
                      ],
                      message: commitMessage(
                        "test(cli): cover resume help, config defaults, and saved-plan bundles",
                        "- Keep CLI and config coverage grouped as a support update.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await importFinalize(
        "commit-24-git-refactor",
      );

      const groups = [
        {
          files: [
            { path: "src/git/commit-input-validation.ts" },
            { path: "src/git/failures.ts" },
            { path: "src/git/path-validation.ts" },
            { path: "src/git/output-sanitization.ts" },
            { path: "src/git/process-environment.ts" },
            { path: "src/git/operations.ts" },
            { path: "src/git/operation-support.ts" },
          ],
          message: commitMessage(
            "refactor(git): split command helpers into focused modules",
            "- Extract commit validation, failure shaping, output sanitization, and process-environment setup into focused helpers.",
          ),
        },
        {
          files: [
            { path: "tests/diff.test.ts" },
            { path: "tests/git-coverage.test.ts" },
          ],
          message: commitMessage(
            "test(git): isolate integration repos from global git settings",
            "- Disable signing and local hooks in temporary Git repositories used by integration coverage.",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        [
          makeFile("src/git/commit-input-validation.ts"),
          makeFile("src/git/failures.ts"),
          makeFile("src/git/path-validation.ts"),
          makeFile("src/git/output-sanitization.ts"),
          makeFile("src/git/process-environment.ts"),
          makeFile("src/git/operations.ts"),
          makeFile("src/git/operation-support.ts"),
          makeFile("tests/diff.test.ts"),
          makeFile("tests/git-coverage.test.ts"),
        ],
        groups,
      );

      expect(
        result.some(
          (group: PlannedCommit) =>
            group.files.some(
              (file) => file.path === "src/git/commit-input-validation.ts",
            ) && group.files.some((file) => file.path === "tests/diff.test.ts"),
        ),
      ).toBe(false);
    });

    test("Commit 39 keeps EOF confirmation changes separate from resume rename restaging", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("commit-39-rename-eof"),
          model: "gpt-5.3-codex",
        },
      });
      installOpenAiMock({ chatQueue: [] });
      const { finalizePlannedGroups } = await importFinalize(
        "commit-39-rename-eof",
      );

      const groups = [
        {
          files: [
            { path: "src/cli/commit/group-staging.ts" },
            { path: "src/cli/execution-flow.ts" },
            { path: "src/cli/commit/plan-display.ts" },
          ],
          message: commitMessage(
            "fix(commit): make saved plans resumable after split renames",
            "- Restage renamed hunks against the current index path and show saved bundle identifiers after planning.",
          ),
        },
        {
          files: [
            { path: "src/cli/interactive-prompt.ts" },
            { path: "src/cli/token/confirmation.ts" },
          ],
          message: commitMessage(
            "fix(token): abort commit confirmation on stdin EOF",
            "- Use a safe false default when commit confirmation input closes unexpectedly.",
          ),
        },
        {
          files: [{ path: "tests/staging.test.ts" }],
          message: commitMessage(
            "test(staging): cover renamed files across split hunk commits",
            "- Verify a later hunk restages as a plain modification after an earlier rename commit.",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        [
          makeFile("src/cli/commit/group-staging.ts"),
          makeFile("src/cli/execution-flow.ts"),
          makeFile("src/cli/commit/plan-display.ts"),
          makeFile("src/cli/interactive-prompt.ts"),
          makeFile("src/cli/token/confirmation.ts"),
          makeFile("tests/staging.test.ts"),
        ],
        groups,
      );

      expect(
        result.some(
          (group: PlannedCommit) =>
            group.files.some(
              (file) => file.path === "src/cli/interactive-prompt.ts",
            ) &&
            group.files.some(
              (file) => file.path === "src/cli/commit/group-staging.ts",
            ),
        ),
      ).toBe(false);
    });

    test("Commit 8 restores the path alias rollout subject instead of prompt-builder wording", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-8-path-subject");

      const originalGroups = [
        {
          files: [
            { path: "src/commit-planning/path/aliases.ts" },
            { path: "src/commit-planning/path/index.ts" },
            { path: "src/commit-planning/path/resolver.ts" },
          ],
          message: commitMessage(
            "feat(path): resolve flattened and virtual file path aliases",
            "- Normalize workspace-relative, absolute, and legacy flattened planner file references.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/prompts/rules/index.ts" }],
          message: commitMessage(
            "feat(commit-planning-prompt-builders): centralize reusable prompt rule builders",
            "- Extract shared prompt rules into dedicated modules.",
          ),
        },
      ];

      const consolidatedGroups = [
        {
          files: [
            { path: "src/commit-planning/path/aliases.ts" },
            { path: "src/commit-planning/path/index.ts" },
            { path: "src/commit-planning/path/resolver.ts" },
          ],
          message: commitMessage(
            "feat(commit-planning-prompt-builders): centralize reusable prompt rule builders",
            "- Extract shared prompt rules into dedicated modules.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/prompts/rules/index.ts" }],
          message: commitMessage(
            "feat(commit-planning-prompt-builders): centralize reusable prompt rule builders",
            "- Extract shared prompt rules into dedicated modules.",
          ),
        },
      ];

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap([
          "src/commit-planning/path/aliases.ts",
          "src/commit-planning/path/index.ts",
          "src/commit-planning/path/resolver.ts",
          "src/commit-planning/prompts/rules/index.ts",
        ]),
      );

      expect(result[0]?.message).toContain(
        "feat(path): resolve flattened and virtual file path aliases",
      );
      expect(result[0]?.message).not.toContain(
        "centralize reusable prompt rule builders",
      );
    });

    test("Commit 28 does not leave prompt-builder wording on the grouping premerge and support-attachment rollout", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-28-grouping-subject");

      const originalGroups = [
        {
          files: [
            {
              path: "src/commit-planning/grouping/subject/premerge/follow-ups.ts",
            },
            { path: "src/commit-planning/grouping/subject/premerge/index.ts" },
            {
              path: "src/commit-planning/grouping/subject/premerge/service.ts",
            },
            {
              path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
            },
          ],
          message: commitMessage(
            "feat(grouping): premerge obviously related subject clusters",
            "- Add deterministic subject premerge before AI clustering.",
          ),
        },
        {
          files: [
            {
              path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
            },
            {
              path: "src/commit-planning/grouping/support-attachment/index.ts",
            },
            {
              path: "src/commit-planning/grouping/support-attachment/scoring.ts",
            },
            {
              path: "src/commit-planning/grouping/support-attachment/selection.ts",
            },
            {
              path: "src/commit-planning/grouping/support-attachment/single-owner-anchor.ts",
            },
            {
              path: "src/commit-planning/grouping/support-attachment/test-ownership.ts",
            },
          ],
          message: commitMessage(
            "feat(grouping): score decisive support attachments by ownership",
            "- Require a concrete attachment anchor before broad support work merges into one owner.",
          ),
        },
      ];

      const consolidatedGroups = [
        {
          files: originalGroups.flatMap((group) => group.files),
          message: commitMessage(
            "feat(commit-planning-grouping): centralize reusable prompt rule builders",
            "- Combine premerge heuristics and support-attachment scoring under one prompt-builder umbrella.",
          ),
        },
      ];

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain("feat(grouping):");
      expect(result[0]?.message).toContain("deterministic subject premerge");
      expect(result[0]?.message).toContain("concrete attachment anchor");
      expect(result[0]?.message).not.toContain(
        "centralize reusable prompt rule builders",
      );
    });

    test("Commit 29 does not leave prompt-splitting wording on grouping infrastructure reorganization", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-29-grouping-infra");

      const originalGroups = [
        {
          files: [
            { path: "src/commit-planning/grouping/dependency/index.ts" },
            { path: "src/commit-planning/grouping/dependency/ordering.ts" },
            { path: "src/commit-planning/grouping/dependency/rules.ts" },
            { path: "src/commit-planning/grouping/file/extraction.ts" },
            { path: "src/commit-planning/grouping/file/index.ts" },
            { path: "src/commit-planning/grouping/file/signals.ts" },
          ],
          message: commitMessage(
            "refactor(grouping): reorganize dependency and file-signal helpers",
            "- Route dependency ordering and file-signal extraction through focused grouping modules.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/grouping/intent/index.ts" },
            { path: "src/commit-planning/grouping/intent/scoring.ts" },
            { path: "src/commit-planning/grouping/intent/word-scoring.ts" },
            { path: "src/commit-planning/grouping/subject/index.ts" },
            { path: "src/commit-planning/grouping/subject/path-areas.ts" },
            { path: "src/commit-planning/grouping/subject/premerge.ts" },
          ],
          message: commitMessage(
            "refactor(grouping): tighten merge-signal exports and overlap checks",
            "- Keep intent, subject, and overlap helpers under grouping-focused boundaries instead of prompt surfaces.",
          ),
        },
      ];

      const consolidatedGroups = [
        {
          files: originalGroups.flatMap((group) => group.files),
          message: commitMessage(
            "refactor(commit-planning-grouping): split planning prompts into staged rule modules",
            "- Reframe grouping infrastructure work as prompt-stage splitting.",
          ),
        },
      ];

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain("refactor(grouping):");
      expect(result[0]?.message).toContain("dependency ordering");
      expect(result[0]?.message).toContain(
        "intent, subject, and overlap helpers",
      );
      expect(result[0]?.message).not.toContain(
        "split planning prompts into staged rule modules",
      );
    });

    test("Commit 31 restores planner-support module wording when prompt-splitting text leaks in", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-31-support-modules");

      const originalGroups = [
        {
          files: [
            { path: "src/commit-planning/ai-file-paths.ts" },
            { path: "src/commit-planning/client-contracts.ts" },
            { path: "src/commit-planning/entry-normalization.ts" },
            { path: "src/commit-planning/file-batching.ts" },
          ],
          message: commitMessage(
            "refactor(commit-planning): reorganize planner support modules",
            "- Move path parsing, client contracts, batching, and entry normalization behind clearer planner support boundaries.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/estimation-planner.ts" },
            { path: "src/commit-planning/planning-workflow.ts" },
          ],
          message: commitMessage(
            "refactor(commit-planning): reorganize planner support modules",
            "- Keep estimation and planning-workflow support aligned with the reorganized planner helper surface.",
          ),
        },
      ];

      const consolidatedGroups = [
        {
          files: originalGroups.flatMap((group) => group.files),
          message: commitMessage(
            "refactor(commit-planning): split planning prompts into staged rule modules",
            "- Reframe planner support module work as prompt-stage splitting.",
          ),
        },
      ];

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain(
        "refactor(commit-planning): reorganize planner support modules",
      );
      expect(result[0]?.message).toContain("entry normalization");
      expect(result[0]?.message).not.toContain(
        "split planning prompts into staged rule modules",
      );
    });

    test("Commit 32 restores orchestration rollout wording when prompt-builder text leaks in", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-32-orchestration");

      const originalGroups = [
        {
          files: [
            { path: "src/commit-planning/orchestration.ts" },
            { path: "src/commit-planning/index.ts" },
          ],
          message: commitMessage(
            "feat(orchestration): thread breaking-change mode through planning",
            "- Carry breaking-mode prompt context through orchestration and public exports.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/planned-commit-clone.ts" },
            { path: "src/commit-planning/planning-workflow.ts" },
          ],
          message: commitMessage(
            "feat(orchestration): thread breaking-change mode through planning",
            "- Carry breaking-mode prompt context through cloned plan state and planning workflow finalization.",
          ),
        },
      ];

      const consolidatedGroups = [
        {
          files: originalGroups.flatMap((group) => group.files),
          message: commitMessage(
            "feat(commit-planning): centralize reusable prompt rule builders",
            "- Reframe orchestration and plan-bundle wiring as prompt-builder work.",
          ),
        },
      ];

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain(
        "feat(orchestration): thread breaking-change mode through planning",
      );
      expect(result[0]?.message).toContain("planning workflow finalization");
      expect(result[0]?.message).not.toContain(
        "centralize reusable prompt rule builders",
      );
    });

    test("Commit 33 rewrites source formatting slices that inherit tests-only style wording", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-33-style-src");

      const originalGroups = [
        {
          files: [
            {
              path: "src/commit-planning/grouping/group/adjacent-absorption.ts",
            },
            { path: "src/commit-planning/grouping/group/finalization.ts" },
            { path: "src/commit-planning/grouping/group/group-stability.ts" },
            { path: "src/commit-planning/grouping/group/merge.ts" },
          ],
          message: commitMessage(
            "style(grouping): normalize formatting in group helpers",
            "- Reflow helper imports and wrapped calls without changing grouping behavior.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/planner-heuristics.ts" },
            { path: "src/commit-planning/planning-workflow.ts" },
          ],
          message: commitMessage(
            "style(planning): reflow planner helpers for consistent formatting",
            "- Normalize planner helper wrapping without changing cache-context or parsing logic.",
          ),
        },
      ];

      const consolidatedGroups = [
        {
          files: originalGroups.flatMap((group) => group.files),
          message: commitMessage(
            "style(src): normalize test formatting and file endings",
            "- Reflow long test assertions and file endings across the batch.",
          ),
        },
      ];

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).not.toContain(
        "normalize test formatting and file endings",
      );
      expect(result[0]?.message).toContain("style(grouping)");
    });

    test("Commit 34 rejects the planner-stability umbrella spanning grouping, cache, validation, estimation, and coverage", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("commit-34-severe-umbrella"),
          model: "gpt-5.3-codex",
        },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        {
                          path: "src/commit-planning/grouping/group/finalization.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/group/message-harmonization.ts",
                        },
                        { path: "src/commit-planning/result-cache.ts" },
                        { path: "src/commit-planning/token-estimation.ts" },
                        { path: "src/commit-planning/response-validation.ts" },
                        { path: "tests/ai-coverage.test.ts" },
                      ],
                      message: commitMessage(
                        "fix(commit-planning-grouping): split mixed-owner groups before final commit output",
                        "- Combine grouping stabilization, cache partitioning, token estimation, response validation, and coverage into one planner-wide repair.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await importFinalize(
        "commit-34-severe-umbrella",
      );

      const groups = [
        {
          files: [
            { path: "src/commit-planning/grouping/group/finalization.ts" },
            {
              path: "src/commit-planning/grouping/group/message-harmonization.ts",
            },
          ],
          message: commitMessage(
            "fix(grouping): rescope harmonized messages after consolidation",
            "- Rebuild split commit messages from covered source groups only.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/result-cache.ts" }],
          message: commitMessage(
            "fix(commit-planning): separate cache keys by prompt mode",
            "- Keep incompatible prompt-mode results from reusing stale cache entries.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/token-estimation.ts" }],
          message: commitMessage(
            "fix(planning): include prompt context in estimate follow-ups",
            "- Keep token estimates aligned with the prompts the planner actually sends.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/response-validation.ts" }],
          message: commitMessage(
            "fix(commit-planning): strip breaking metadata when disabled",
            "- Normalize grouped commit messages against the active prompt mode before validation.",
          ),
        },
        {
          files: [{ path: "tests/ai-coverage.test.ts" }],
          message: commitMessage(
            "test(grouping): cover planner stability regressions",
            "- Lock the umbrella-merge, cache, validation, and budgeting boundaries with direct regressions.",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(result.length).toBeGreaterThanOrEqual(4);
      expect(
        result.some(
          (group: PlannedCommit) =>
            group.files.some(
              (file) =>
                file.path ===
                "src/commit-planning/grouping/group/finalization.ts",
            ) &&
            group.files.some(
              (file) => file.path === "src/commit-planning/result-cache.ts",
            ) &&
            group.files.some(
              (file) => file.path === "src/commit-planning/token-estimation.ts",
            ) &&
            group.files.some(
              (file) =>
                file.path === "src/commit-planning/response-validation.ts",
            ) &&
            group.files.some(
              (file) => file.path === "tests/ai-coverage.test.ts",
            ),
        ),
      ).toBe(false);
    });

    test("Commit 36 restores plan-bundle rollout wording when prompt-builder text leaks onto implementation and tests", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-36-plan-bundles");

      const originalGroups = [
        {
          files: [
            { path: "src/commit-planning/plan-bundles/hashes.ts" },
            { path: "src/commit-planning/plan-bundles/index.ts" },
            { path: "src/commit-planning/plan-bundles/schemas.ts" },
            { path: "src/commit-planning/plan-bundles/service.ts" },
            { path: "src/commit-planning/plan-bundles/storage.ts" },
          ],
          message: commitMessage(
            "feat(plan-bundles): persist resumable plans with hash validation",
            "- Save staged patches, repository identity, and hash-backed bundle metadata for resumable plans.",
          ),
        },
        {
          files: [{ path: "tests/plan-bundles.test.ts" }],
          message: commitMessage(
            "test(plan-bundles): cover persisted resume bundle safeguards",
            "- Verify repository identity, HEAD matching, staged-patch integrity, and cache-home placement.",
          ),
        },
      ];

      const consolidatedGroups = [
        {
          files: originalGroups.flatMap((group) => group.files),
          message: commitMessage(
            "feat(commit-planning-plan-bundles): centralize reusable prompt rule builders",
            "- Reframe plan-bundle implementation and coverage as prompt rule builder work.",
          ),
        },
      ];

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain(
        "feat(plan-bundles): persist resumable plans with hash validation",
      );
      expect(result[0]?.message).toContain("HEAD matching");
      expect(result[0]?.message).not.toContain(
        "centralize reusable prompt rule builders",
      );
    });
  });

  describe("48-commit bad and ugly regression inventory", () => {
    const makeFileMap = makeGroupingFileMap;
    const importFinalize = importFinalizeModule;
    const importGroupingMessageHarmonization =
      importGroupingMessageHarmonizationModule;
    const importRepartition = importRepartitionModule;
    const importFileSignals = importGroupingFileSignalsModule;

    async function finalizeStableEntrypointRollout(tag: string) {
      const groups = [
        {
          files: [{ path: "src/cli/command-line-interface.ts" }],
          message: commitMessage(
            "feat(cli): expose configuration services from stable entrypoints",
            "- Move the old CLI entry surface onto stable module exports.",
          ),
        },
        {
          files: [{ path: "src/application/config/service.ts" }],
          message: commitMessage(
            "feat(config): expose configuration services from stable entrypoints",
            "- Add the dedicated config service behind stable entrypoint exports.",
          ),
        },
        {
          files: [{ path: "src/application/index.ts" }],
          message: commitMessage(
            "feat(application): update public exports",
            "- Re-export configuration APIs from the application entrypoint.",
          ),
        },
      ];

      writeLocalConfig({
        openai: { apiKey: validApiKey(tag), model: "gpt-5.3-codex" },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: groups.flatMap((group) => group.files),
                      message: commitMessage(
                        "feat(entrypoints): expose configuration services from stable module exports",
                        "- Keep the CLI entrypoint migration, config service extraction, and public export rollout together.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });

      const { finalizePlannedGroups } = await importFinalize(tag);
      return finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );
    }

    async function finalizeTracePersistenceRollout(tag: string) {
      const groups = [
        {
          files: [
            { path: "src/cli/terminal/output-ui.ts" },
            { path: "src/cli/terminal/index.ts" },
          ],
          message: commitMessage(
            "feat(trace): persist rendered trace output to cache logs",
            "- Capture rendered terminal trace lines at the output surface.",
          ),
        },
        {
          files: [
            { path: "src/cli/trace-persistence.ts" },
            { path: "src/cli/session-display.ts" },
          ],
          message: commitMessage(
            "feat(trace): persist rendered trace output to cache logs",
            "- Persist trace transcript lines under the CLI cache directory.",
          ),
        },
      ];

      writeLocalConfig({
        openai: { apiKey: validApiKey(tag), model: "gpt-5.3-codex" },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: groups.flatMap((group) => group.files),
                      message: commitMessage(
                        "feat(trace): persist rendered trace output to cache logs",
                        "- Keep the output observer, trace persistence service, and session display wiring together.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });

      const { finalizePlannedGroups } = await importFinalize(tag);
      return finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );
    }

    async function finalizePromptSurfaceRollout(tag: string) {
      const groups = [
        {
          files: [
            { path: "src/commit-planning/prompts/context/diff-context.ts" },
            { path: "src/commit-planning/prompts/index.ts" },
          ],
          message: commitMessage(
            "refactor(prompts): centralize reusable planning prompt rules",
            "- Move shared diff-context wiring under the prompts surface.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/prompts/rules/cluster-merge.ts" },
            { path: "src/commit-planning/prompts/rules/commit/generation.ts" },
            { path: "src/commit-planning/prompts/rules/commit/index.ts" },
            { path: "src/commit-planning/prompts/rules/commit/message.ts" },
            { path: "src/commit-planning/prompts/rules/formatting.ts" },
            { path: "src/commit-planning/prompts/rules/hunk-grouping.ts" },
            { path: "src/commit-planning/prompts/rules/index.ts" },
            { path: "src/commit-planning/prompts/rules/plan-consolidation.ts" },
            { path: "src/commit-planning/prompts/rules/semantic-planning.ts" },
          ],
          message: commitMessage(
            "refactor(commit-planning): centralize reusable prompt rules",
            "- Extract reusable planning rule modules from prompt builders and stages.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
            { path: "src/commit-planning/prompts/stages/commit-generation.ts" },
            { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
            { path: "src/commit-planning/prompts/stages/index.ts" },
            {
              path: "src/commit-planning/prompts/stages/plan-consolidation.ts",
            },
          ],
          message: commitMessage(
            "refactor(prompts): centralize reusable planning prompt rules",
            "- Keep the staged prompt builders aligned with the rule extraction rollout.",
          ),
        },
      ];

      writeLocalConfig({
        openai: { apiKey: validApiKey(tag), model: "gpt-5.3-codex" },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: groups.flatMap((group) => group.files),
                      message: commitMessage(
                        "refactor(prompts): centralize reusable planning prompt rules",
                        "- Keep prompt context, rule modules, and stage builders on one coherent prompt-surface rollout.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });

      const { finalizePlannedGroups } = await importFinalize(tag);
      return finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );
    }

    async function finalizeCliFixtureRefreshRollout(tag: string) {
      const groups = [
        {
          files: [{ path: "tests/plan-display.test.ts" }],
          message: commitMessage(
            "test(planning): refresh fixtures for renamed paths and config updates",
            "- Refresh plan display fixtures for renamed paths.",
          ),
        },
        {
          files: [{ path: "tests/planner-notices.test.ts" }],
          message: commitMessage(
            "test(planning): refresh fixtures for renamed paths and config updates",
            "- Refresh planner notice fixtures for renamed paths.",
          ),
        },
        {
          files: [{ path: "tests/terminal-line-wrapping.test.ts" }],
          message: commitMessage(
            "test(cli): align wrapped path expectations with main entrypoint",
            "- Update terminal wrapping expectations to the current CLI entrypoint path.",
          ),
        },
      ];

      writeLocalConfig({
        openai: { apiKey: validApiKey(tag), model: "gpt-5.3-codex" },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: groups.flatMap((group) => group.files),
                      message: commitMessage(
                        "test(planning): refresh fixtures for renamed paths and current CLI entrypoints",
                        "- Keep the renamed-path and CLI fixture updates on one coherent verification sweep.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });

      const { finalizePlannedGroups } = await importFinalize(tag);
      return finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );
    }

    test("Commit 1 keeps the CLI stable-entrypoint migration with the broader config export rollout", async () => {
      const result = await finalizeStableEntrypointRollout(
        "commit-1-entrypoint",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/command-line-interface.ts",
      });
    });

    test("Commit 4 keeps tsconfig support attached to resume-selection and trace-persistence CLI coverage", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-4-tsconfig");

      const originalGroups = [
        {
          files: [{ path: "tests/zz-cli-coverage.test.ts" }],
          message: commitMessage(
            "test(cli): cover resume selection and trace persistence",
            "- Exercise resume selection and trace persistence coverage from the CLI surface.",
          ),
        },
        {
          files: [{ path: "tsconfig.json" }],
          message: commitMessage(
            "test(cli): cover resume selection and trace persistence",
            "- Add the Node type declarations needed by the expanded filesystem-based tests.",
          ),
        },
      ];

      const consolidatedGroups = [
        {
          files: [
            { path: "tests/zz-cli-coverage.test.ts" },
            { path: "tsconfig.json" },
          ],
          message: commitMessage(
            "test(cli): cover resume selection and trace persistence",
            "- Exercise resume selection and trace persistence coverage from the CLI surface.",
            "- Add the Node type declarations needed by the expanded filesystem-based tests.",
          ),
        },
      ];

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(["tests/zz-cli-coverage.test.ts", "tsconfig.json"]),
      );

      expect(result[0]?.message).toContain(
        "resume selection and trace persistence",
      );
      expect(result[0]?.message).toContain("Node type declarations");
    });

    test("Commit 6 keeps terminal output hooks with the trace persistence rollout", async () => {
      const result = await finalizeTracePersistenceRollout("commit-6-trace-ui");

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/terminal/output-ui.ts",
      });
    });

    test("Commit 7 keeps verbose-rendering export cleanup with the surrounding token prompt rollout", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("commit-7-verbose-rendering-export"),
          model: "gpt-5.3-codex",
        },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "src/cli/token/confirmation.ts" },
                        { path: "src/cli/token/index.ts" },
                        { path: "src/cli/verbose-output.ts" },
                        { path: "src/cli/verbose-rendering/index.ts" },
                      ],
                      message: commitMessage(
                        "fix(cli): tighten token prompts and explicit module exports",
                        "- Keep token confirmation, verbose output, and verbose-rendering exports on one explicit module-surface fix.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await importFinalize(
        "commit-7-verbose-rendering-export",
      );
      const groups = [
        {
          files: [
            { path: "src/cli/token/confirmation.ts" },
            { path: "src/cli/token/index.ts" },
            { path: "src/cli/verbose-output.ts" },
          ],
          message: commitMessage(
            "fix(cli): tighten token prompts and explicit module exports",
          ),
        },
        {
          files: [{ path: "src/cli/verbose-rendering/index.ts" }],
          message: commitMessage(
            "fix(verbose-rendering): update public exports",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/verbose-rendering/index.ts",
      });
    });

    test("Commit 9 keeps planner-notices fixture refresh with the broader renamed-path test sweep", async () => {
      const result = await finalizeCliFixtureRefreshRollout(
        "commit-9-planner-notices",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "tests/planner-notices.test.ts",
      });
    });

    test("Commit 10 keeps terminal wrapping fixtures with the renamed-path test sweep", async () => {
      const result = await finalizeCliFixtureRefreshRollout(
        "commit-10-terminal-wrap",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "tests/terminal-line-wrapping.test.ts",
      });
    });

    test("Commit 11 keeps config service introduction with the stable-entrypoint export rollout", async () => {
      const result = await finalizeStableEntrypointRollout(
        "commit-11-config-service",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/application/config/service.ts",
      });
    });

    test("Commit 12 keeps application export narrowing with the stable-entrypoint export rollout", async () => {
      const result = await finalizeStableEntrypointRollout(
        "commit-12-app-exports",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/application/index.ts",
      });
    });

    test("Commit 16 keeps plan-display fixture refresh with the renamed-path test sweep", async () => {
      const result = await finalizeCliFixtureRefreshRollout(
        "commit-16-plan-display",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "tests/plan-display.test.ts",
      });
    });

    test("Commit 17 keeps git integration hardening separate from git helper extraction", async () => {
      const { buildFileChangeSignals } = await import(
        new URL(
          "../src/commit-planning/grouping/file/index.js",
          import.meta.url,
        ).href
      );
      const { chooseSupportAttachment } = await import(
        new URL(
          "../src/commit-planning/grouping/support-attachment/index.js",
          import.meta.url,
        ).href
      );

      const groups = [
        {
          files: [
            { path: "src/git/commit-input-validation.ts" },
            { path: "src/git/failures.ts" },
            { path: "src/git/path-validation.ts" },
            { path: "src/git/output-sanitization.ts" },
            { path: "src/git/process-environment.ts" },
            { path: "src/git/repository-state.ts" },
            { path: "src/git/operation-support.ts" },
            { path: "src/git/operations.ts" },
            { path: "src/git/index.ts" },
          ],
          message: commitMessage(
            "refactor(git): split command helpers into focused modules",
            "- Extract focused git helper modules from the command execution layer.",
          ),
        },
        {
          files: [{ path: "tests/git-coverage.test.ts" }],
          message: commitMessage(
            "test(git): isolate integration repos from global git settings",
            "- Harden git coverage fixtures against inherited global repository state.",
          ),
        },
      ];
      const allFiles = groups.flatMap((group) =>
        group.files.map((file) => makeFile(file.path)),
      );
      const fileSignals = buildFileChangeSignals(allFiles);

      const attachment = chooseSupportAttachment(
        groups[1] as PlannedCommit,
        groups as PlannedCommit[],
        [[0]],
        fileSignals,
      );

      expect(attachment).toBe(-1);
    });

    test("Commit 18 does not let git style cleanup absorb commit-planning or diff coverage formatting", async () => {
      const { splitWeakConsolidations } = await importRepartition(
        "commit-18-style-git",
      );
      const { buildFileChangeSignals } = await importFileSignals(
        "commit-18-style-git",
      );
      const paths = [
        "src/commit-planning/usage-tracking.ts",
        "src/git/chunks.ts",
        "src/git/diff.ts",
        "src/git/formatting.ts",
        "src/git/header.ts",
        "src/git/models.ts",
        "src/git/parser.ts",
        "src/git/patches.ts",
        "tests/diff.test.ts",
      ];
      const allFiles = paths.map((path) => makeFile(path));

      const result = splitWeakConsolidations(
        [
          {
            files: paths.map((path) => ({ path })),
            message: commitMessage(
              "style(git): reflow formatting across diff utilities",
              "- Apply line wrapping and newline cleanup across git parsing and nearby helpers.",
            ),
          },
        ],
        [
          {
            files: paths.map((path) => ({ path })),
            message: commitMessage(
              "style(git): reflow formatting across diff utilities",
              "- Apply line wrapping and newline cleanup across git parsing and nearby helpers.",
            ),
          },
        ],
        new Map(allFiles.map((file) => [file.path, file])),
        buildFileChangeSignals(allFiles),
      );

      expect(
        result.some(
          (group: PlannedCommit) =>
            group.files.some((file) => file.path.startsWith("src/git/")) &&
            group.files.some(
              (file) => file.path === "src/commit-planning/usage-tracking.ts",
            ),
        ),
      ).toBe(false);
      expect(
        result.some(
          (group: PlannedCommit) =>
            group.files.some((file) => file.path.startsWith("src/git/")) &&
            group.files.some((file) => file.path === "tests/diff.test.ts"),
        ),
      ).toBe(false);
    });

    test("Commit 19 keeps commit-coverage path migration with the surrounding renamed-module rollout", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("commit-19-commit-coverage"),
          model: "gpt-5.3-codex",
        },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "src/commit-planning/ai-file-paths.ts" },
                        { path: "src/commit-planning/entry-normalization.ts" },
                        { path: "src/commit-planning/file-batching.ts" },
                        {
                          path: "src/commit-planning/grouping/commit-coverage.ts",
                        },
                      ],
                      message: commitMessage(
                        "refactor(commit-planning): align renamed module paths and formatting",
                        "- Keep the renamed helper modules and commit coverage path migration together.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await importFinalize(
        "commit-19-commit-coverage",
      );
      const groups = [
        {
          files: [
            { path: "src/commit-planning/ai-file-paths.ts" },
            { path: "src/commit-planning/entry-normalization.ts" },
            { path: "src/commit-planning/file-batching.ts" },
          ],
          message: commitMessage(
            "refactor(commit-planning): align renamed module paths and formatting",
          ),
        },
        {
          files: [{ path: "src/commit-planning/grouping/commit-coverage.ts" }],
          message: commitMessage(
            "refactor(commit-planning-grouping): align renamed module paths and formatting",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/commit-planning/grouping/commit-coverage.ts",
      });
    });

    test("Commit 20 restores file-signal module wording instead of prompt-rule umbrella text", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-20-file-signals");
      const originalGroups = [
        {
          files: [
            { path: "src/commit-planning/grouping/file/extraction.ts" },
            { path: "src/commit-planning/grouping/file/index.ts" },
            { path: "src/commit-planning/grouping/file/signals.ts" },
          ],
          message: commitMessage(
            "refactor(grouping): split dependency and file signal modules",
            "- Move file signal helpers into focused grouping/file modules.",
          ),
        },
      ];
      const consolidatedGroups = [
        {
          files: originalGroups[0]!.files,
          message: commitMessage(
            "refactor(grouping-file): centralize reusable prompt rules",
            "- Reframe file-signal helpers as prompt rule plumbing.",
          ),
        },
      ];
      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain("file signal modules");
      expect(result[0]?.message).not.toContain("prompt rules");
    });

    test("Commit 21 restores subject module wording instead of prompt-rule umbrella text", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-21-subject-modules");
      const originalGroups = [
        {
          files: [
            { path: "src/commit-planning/grouping/subject/analysis.ts" },
            { path: "src/commit-planning/grouping/subject/index.ts" },
            { path: "src/commit-planning/grouping/subject/path-areas.ts" },
            { path: "src/commit-planning/grouping/subject/premerge.ts" },
          ],
          message: commitMessage(
            "refactor(grouping): tighten subject module boundaries",
            "- Rework subject analysis and path-area boundaries without prompt-rule coupling.",
          ),
        },
      ];
      const consolidatedGroups = [
        {
          files: originalGroups[0]!.files,
          message: commitMessage(
            "refactor(grouping-subject): centralize reusable prompt rules",
            "- Reframe subject helpers as prompt-rule extraction.",
          ),
        },
      ];
      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain("subject module boundaries");
      expect(result[0]?.message).not.toContain("prompt rules");
    });

    test("Commit 22 restores grouping index/type wording instead of prompt-rule umbrella text", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-22-grouping-index");
      const originalGroups = [
        {
          files: [
            { path: "src/commit-planning/grouping/grouping-types.ts" },
            { path: "src/commit-planning/grouping/index.ts" },
          ],
          message: commitMessage(
            "refactor(grouping): route premerge export through module index",
            "- Keep grouping index exports aligned with the new directory-based layout.",
          ),
        },
      ];
      const consolidatedGroups = [
        {
          files: originalGroups[0]!.files,
          message: commitMessage(
            "refactor(commit-planning-grouping): centralize reusable prompt rules",
            "- Reframe grouping index exports as prompt-rule centralization.",
          ),
        },
      ];
      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain("module index");
      expect(result[0]?.message).not.toContain("prompt rules");
    });

    test("Commit 23 restores intent-scoring wording instead of prompt-rule umbrella text", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-23-intent-scoring");
      const originalGroups = [
        {
          files: [
            { path: "src/commit-planning/grouping/intent/index.ts" },
            { path: "src/commit-planning/grouping/intent/scoring.ts" },
            { path: "src/commit-planning/grouping/intent/word-scoring.ts" },
          ],
          message: commitMessage(
            "refactor(grouping): extract intent scoring into dedicated module",
            "- Move intent scoring behind its own grouping/intent boundary.",
          ),
        },
      ];
      const consolidatedGroups = [
        {
          files: originalGroups[0]!.files,
          message: commitMessage(
            "refactor(grouping-intent): centralize reusable prompt rules",
            "- Reframe intent scoring as prompt-rule centralization.",
          ),
        },
      ];
      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain("intent scoring");
      expect(result[0]?.message).not.toContain("prompt rules");
    });

    test("Commit 24 restores dependency-module wording instead of prompt-rule umbrella text", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization(
          "commit-24-dependency-modules",
        );
      const originalGroups = [
        {
          files: [
            { path: "src/commit-planning/grouping/dependency/index.ts" },
            { path: "src/commit-planning/grouping/dependency/ordering.ts" },
            { path: "src/commit-planning/grouping/dependency/rules.ts" },
          ],
          message: commitMessage(
            "refactor(grouping): split dependency and file signal modules",
            "- Keep dependency ordering and rules under focused dependency modules.",
          ),
        },
      ];
      const consolidatedGroups = [
        {
          files: originalGroups[0]!.files,
          message: commitMessage(
            "refactor(grouping-dependency): centralize reusable prompt rules",
            "- Reframe dependency helpers as prompt-rule centralization.",
          ),
        },
      ];
      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain("dependency");
      expect(result[0]?.message).not.toContain("prompt rules");
    });

    test("Commit 25 keeps prompt diff-context wiring with the broader prompt-surface rollout", async () => {
      const result = await finalizePromptSurfaceRollout(
        "commit-25-diff-context",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/commit-planning/prompts/context/diff-context.ts",
      });
    });

    test("Commit 29 keeps prompt rules with the broader prompt-surface rollout", async () => {
      const result = await finalizePromptSurfaceRollout(
        "commit-29-prompt-rules",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/commit-planning/prompts/rules/index.ts",
      });
    });

    test("Commit 30 keeps prompt index exports with the broader prompt-surface rollout", async () => {
      const result = await finalizePromptSurfaceRollout(
        "commit-30-prompts-index",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/commit-planning/prompts/index.ts",
      });
    });

    test("Commit 33 keeps prompt stage exports with the broader prompt-surface rollout", async () => {
      const result = await finalizePromptSurfaceRollout(
        "commit-33-prompt-stages",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/commit-planning/prompts/stages/index.ts",
      });
    });

    test("Commit 34 rejects the path-alias, plan-bundle, orchestration, and support-attachment umbrella", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("commit-34-mega-umbrella"),
          model: "gpt-5.3-codex",
        },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "src/commit-planning/path/aliases.ts" },
                        { path: "src/commit-planning/path/index.ts" },
                        { path: "src/commit-planning/path/resolver.ts" },
                        { path: "src/commit-planning/plan-bundles/hashes.ts" },
                        { path: "src/commit-planning/plan-bundles/index.ts" },
                        { path: "src/commit-planning/plan-bundles/schemas.ts" },
                        { path: "src/commit-planning/plan-bundles/service.ts" },
                        { path: "src/commit-planning/plan-bundles/storage.ts" },
                        { path: "src/commit-planning/orchestration.ts" },
                        { path: "src/commit-planning/overlap-resolution.ts" },
                        {
                          path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
                        },
                        { path: "tests/plan-bundles.test.ts" },
                      ],
                      message: commitMessage(
                        "feat(commit-planning): centralize reusable prompt rule builders",
                        "- Fold path aliasing, plan bundles, orchestration, support attachment, and coverage under one umbrella rollout.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await importFinalize(
        "commit-34-mega-umbrella",
      );
      const groups = [
        {
          files: [
            { path: "src/commit-planning/path/aliases.ts" },
            { path: "src/commit-planning/path/index.ts" },
            { path: "src/commit-planning/path/resolver.ts" },
          ],
          message: commitMessage(
            "feat(grouping): resolve flattened paths and virtual file aliases",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/plan-bundles/hashes.ts" },
            { path: "src/commit-planning/plan-bundles/index.ts" },
            { path: "src/commit-planning/plan-bundles/schemas.ts" },
            { path: "src/commit-planning/plan-bundles/service.ts" },
            { path: "src/commit-planning/plan-bundles/storage.ts" },
          ],
          message: commitMessage(
            "feat(plan-bundles): persist resumable plans with content integrity",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/orchestration.ts" },
            { path: "src/commit-planning/overlap-resolution.ts" },
            {
              path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
            },
          ],
          message: commitMessage(
            "feat(commit-planning): add support-attachment grouping workflow",
          ),
        },
        {
          files: [{ path: "tests/plan-bundles.test.ts" }],
          message: commitMessage(
            "test(plan-bundles): cover persisted resume bundle safeguards",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(result.length).toBeGreaterThanOrEqual(3);
      expect(
        result.some(
          (group: PlannedCommit) =>
            group.files.some(
              (file) => file.path === "src/commit-planning/path/aliases.ts",
            ) &&
            group.files.some(
              (file) =>
                file.path === "src/commit-planning/plan-bundles/hashes.ts",
            ) &&
            group.files.some(
              (file) => file.path === "src/commit-planning/orchestration.ts",
            ),
        ),
      ).toBe(false);
    });

    test("Commit 36 restores grouping helper wording instead of prompt-rule umbrella text", async () => {
      const { harmonizeConsolidatedMessages } =
        await importGroupingMessageHarmonization("commit-36-group-helpers");
      const originalGroups = [
        {
          files: [
            {
              path: "src/commit-planning/grouping/group/harmonization-transforms.ts",
            },
            { path: "src/commit-planning/grouping/group/finalization.ts" },
            { path: "src/commit-planning/grouping/group/index.ts" },
            { path: "src/commit-planning/grouping/group/merge.ts" },
            { path: "src/commit-planning/grouping/group/stage.ts" },
          ],
          message: commitMessage(
            "refactor(grouping): expose harmonization helpers for message repair",
            "- Keep grouping helper exports aligned with message repair ownership.",
          ),
        },
      ];
      const consolidatedGroups = [
        {
          files: originalGroups[0]!.files,
          message: commitMessage(
            "refactor(grouping-group): centralize reusable prompt rules",
            "- Reframe grouping helpers as prompt-rule centralization.",
          ),
        },
      ];
      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        makeFileMap(
          originalGroups.flatMap((group) =>
            group.files.map((file) => file.path),
          ),
        ),
      );

      expect(result[0]?.message).toContain("harmonization helpers");
      expect(result[0]?.message).not.toContain("prompt rules");
    });

    test("Commit 37 keeps CLI breaking-metadata coverage attached to the commit-message feature rollout", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("commit-37-cli-breaking-tests"),
          model: "gpt-5.3-codex",
        },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        {
                          path: "src/commit-messages/breaking-change-footers.ts",
                        },
                        {
                          path: "src/commit-messages/commit-message-bullets.ts",
                        },
                        { path: "src/commit-messages/formatting.ts" },
                        { path: "src/commit-messages/index.ts" },
                        { path: "tests/cli.test.ts" },
                      ],
                      message: commitMessage(
                        "feat(commit-messages): enforce breaking footer metadata",
                        "- Keep CLI breaking metadata coverage with the commit-message implementation rollout.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await importFinalize(
        "commit-37-cli-breaking-tests",
      );
      const groups = [
        {
          files: [
            { path: "src/commit-messages/breaking-change-footers.ts" },
            { path: "src/commit-messages/commit-message-bullets.ts" },
            { path: "src/commit-messages/formatting.ts" },
            { path: "src/commit-messages/index.ts" },
          ],
          message: commitMessage(
            "feat(commit-messages): enforce breaking footer metadata",
          ),
        },
        {
          files: [{ path: "tests/cli.test.ts" }],
          message: commitMessage(
            "test(cli): cover breaking metadata authoring rules",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({ path: "tests/cli.test.ts" });
    });

    test("Commit 38 keeps the CLI codex-default test hunk with the broader config-default rollout", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("commit-38-codex-default-tests"),
          model: "gpt-5.3-codex",
        },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "tests/cli.test.ts" },
                        { path: "tests/config.test.ts" },
                      ],
                      message: commitMessage(
                        "test(config): update defaults for the Codex model rollout",
                        "- Keep CLI and config default assertions aligned on the Codex rollout.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await importFinalize(
        "commit-38-codex-default-tests",
      );
      const groups = [
        {
          files: [{ path: "tests/cli.test.ts" }],
          message: commitMessage(
            "test(cli): update defaults for the Codex model rollout",
          ),
        },
        {
          files: [{ path: "tests/config.test.ts" }],
          message: commitMessage(
            "test(config): update defaults for the Codex model rollout",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({ path: "tests/cli.test.ts" });
      expect(result[0]?.files).toContainEqual({ path: "tests/config.test.ts" });
    });

    test("Commit 44 keeps trace persistence storage with the rendered trace rollout", async () => {
      const result = await finalizeTracePersistenceRollout(
        "commit-44-trace-storage",
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/trace-persistence.ts",
      });
      expect(result[0]?.files).toContainEqual({
        path: "src/cli/session-display.ts",
      });
    });

    test("Commit 46 rejects the grouping mega-umbrella spanning heuristics, validation, cache, estimation, and coverage", async () => {
      writeLocalConfig({
        openai: {
          apiKey: validApiKey("commit-46-grouping-mega-umbrella"),
          model: "gpt-5.3-codex",
        },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "src/commit-planning/estimation-planner.ts" },
                        { path: "src/commit-planning/response-validation.ts" },
                        { path: "src/commit-planning/result-cache.ts" },
                        { path: "src/commit-planning/token-estimation.ts" },
                        {
                          path: "src/commit-planning/grouping/group/adjacent-absorption.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/group/finalization.ts",
                        },
                        {
                          path: "src/commit-planning/grouping/group/message-harmonization.ts",
                        },
                        { path: "src/commit-planning/grouping/repartition.ts" },
                        { path: "tests/ai-coverage.test.ts" },
                        { path: "tests/group-finalization.test.ts" },
                      ],
                      message: commitMessage(
                        "fix(commit-planning-grouping): block umbrella merges across unrelated ownership roots",
                        "- Fold grouping heuristics, validation, cache, estimation, and coverage into one planner-wide stability umbrella.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
        ],
      });
      const { finalizePlannedGroups } = await importFinalize(
        "commit-46-grouping-mega-umbrella",
      );

      const groups = [
        {
          files: [
            {
              path: "src/commit-planning/grouping/group/adjacent-absorption.ts",
            },
            { path: "src/commit-planning/grouping/group/finalization.ts" },
            {
              path: "src/commit-planning/grouping/group/message-harmonization.ts",
            },
            { path: "src/commit-planning/grouping/repartition.ts" },
          ],
          message: commitMessage(
            "fix(grouping): tighten ownership boundaries and message repair",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/result-cache.ts" },
            { path: "src/commit-planning/token-estimation.ts" },
            { path: "src/commit-planning/estimation-planner.ts" },
            { path: "src/commit-planning/response-validation.ts" },
          ],
          message: commitMessage(
            "fix(commit-planning): keep cache, estimation, and validation aligned with prompt context",
          ),
        },
        {
          files: [
            { path: "tests/ai-coverage.test.ts" },
            { path: "tests/group-finalization.test.ts" },
          ],
          message: commitMessage(
            "test(grouping): cover planner stability and finalization boundaries",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(
        result.some(
          (group: PlannedCommit) =>
            group.files.some(
              (file) =>
                file.path === "src/commit-planning/grouping/repartition.ts",
            ) &&
            group.files.some(
              (file) => file.path === "src/commit-planning/result-cache.ts",
            ) &&
            group.files.some(
              (file) => file.path === "tests/ai-coverage.test.ts",
            ),
        ),
      ).toBe(false);
    });

    test("Commit 47 does not collapse resume execution, README, schema defaults, and config tests into one CLI umbrella", async () => {
      const stabilizedResponses = Array.from({ length: 5 }, () => ({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  files: [
                    { path: "src/cli/execution-flow.ts" },
                    { path: "src/cli/index.ts" },
                    { path: "src/cli/main.ts" },
                    { path: "src/cli/options.ts" },
                  ],
                  message: commitMessage(
                    "feat(cli): add resumable plan execution and parsed command routing",
                    "- Keep the CLI flow changes together.",
                  ),
                },
                {
                  files: [
                    { path: "README.md" },
                    { path: "src/application/config/schema.ts" },
                  ],
                  message: commitMessage(
                    "docs(readme): document saved plan bundles and new defaults",
                    "- Keep docs and schema defaults separate from the CLI flow changes.",
                  ),
                },
                {
                  files: [{ path: "tests/config.test.ts" }],
                  message: commitMessage(
                    "test(config): cover resume help, config defaults, and saved-plan bundles",
                    "- Keep config coverage separate after the support split.",
                  ),
                },
                {
                  files: [{ path: "tests/cli.test.ts" }],
                  message: commitMessage(
                    "test(cli): cover resume help, config defaults, and saved-plan bundles",
                    "- Keep CLI coverage separate after the support split.",
                  ),
                },
                {
                  files: [{ path: "tests/zz-cli-coverage.test.ts" }],
                  message: commitMessage(
                    "test(zz-cli): cover resume help, config defaults, and saved-plan bundles",
                    "- Keep saved-plan coverage separate after the support split.",
                  ),
                },
              ]),
            },
          },
        ],
      }));

      writeLocalConfig({
        openai: {
          apiKey: validApiKey("commit-47-cli-resume-umbrella"),
          model: "gpt-5.3-codex",
        },
      });
      installOpenAiMock({
        chatQueue: [
          {
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      files: [
                        { path: "README.md" },
                        { path: "src/application/config/schema.ts" },
                        { path: "src/cli/execution-flow.ts" },
                        { path: "src/cli/index.ts" },
                        { path: "src/cli/main.ts" },
                        { path: "src/cli/options.ts" },
                        { path: "tests/cli.test.ts" },
                        { path: "tests/config.test.ts" },
                        { path: "tests/zz-cli-coverage.test.ts" },
                      ],
                      message: commitMessage(
                        "feat(cli): add resumable plan execution and parsed command routing",
                        "- Fold resume execution, docs, schema defaults, and CLI/config coverage into one umbrella rollout.",
                      ),
                    },
                  ]),
                },
              },
            ],
          },
          ...stabilizedResponses,
        ],
      });
      const { finalizePlannedGroups } = await importFinalize(
        "commit-47-cli-resume-umbrella",
      );
      const groups = [
        {
          files: [
            { path: "src/cli/execution-flow.ts" },
            { path: "src/cli/index.ts" },
            { path: "src/cli/main.ts" },
            { path: "src/cli/options.ts" },
          ],
          message: commitMessage(
            "feat(cli): add resumable plan execution and parsed command routing",
          ),
        },
        {
          files: [
            { path: "README.md" },
            { path: "src/application/config/schema.ts" },
          ],
          message: commitMessage(
            "docs(readme): document saved plan bundles and new defaults",
          ),
        },
        {
          files: [
            { path: "tests/config.test.ts" },
            { path: "tests/cli.test.ts" },
            { path: "tests/zz-cli-coverage.test.ts" },
          ],
          message: commitMessage(
            "test(cli): cover resume help, config defaults, and saved-plan bundles",
          ),
        },
      ];

      const result = await finalizePlannedGroups(
        groups.flatMap((group) =>
          group.files.map((file) => makeFile(file.path)),
        ),
        groups,
      );

      expect(
        result.some(
          (group: PlannedCommit) =>
            group.files.some(
              (file) => file.path === "src/cli/execution-flow.ts",
            ) &&
            group.files.some((file) => file.path === "README.md") &&
            group.files.some((file) => file.path === "tests/config.test.ts"),
        ),
      ).toBe(false);
    });
  });
});
