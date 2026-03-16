import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULTS, resetConfigCache } from "../src/config.js";
import {
  OpenAIError,
  OpenAITimeoutError,
  ValidationError,
} from "../src/errors.js";

type DiffChunk = import("../src/diff.js").DiffChunk;
type DiffStats = import("../src/diff.js").DiffStats;
type FileDiff = import("../src/diff.js").FileDiff;

const { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } =
  await import("bun:test");

type MockResult = Error | unknown;

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

async function importFreshAi(tag: string) {
  return import(
    new URL(`../src/ai.js?${tag}-${Math.random()}`, import.meta.url).href
  );
}

async function importFreshAiClient(tag: string) {
  return import(
    new URL(`../src/ai-client.js?${tag}-${Math.random()}`, import.meta.url).href
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

  const shiftResult = (queue: MockResult[], label: string) => {
    if (queue.length === 0) {
      throw new Error(`No mocked ${label} result left`);
    }
    const next = queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };

  mock.module("openai", () => ({
    default: class FakeOpenAI {
      chat = {
        completions: {
          create: async (payload: unknown, mockOptions: unknown) => {
            calls.chat.push({ options: mockOptions, payload });
            return shiftResult(chatQueue, "chat completion");
          },
        },
      };

      responses = {
        create: async (payload: unknown, mockOptions: unknown) => {
          calls.responses.push({ options: mockOptions, payload });
          return shiftResult(responseQueue, "responses completion");
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

function makeStats(): DiffStats {
  return { additions: 3, chunks: 2, deletions: 1, filesChanged: 2 };
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
      openai: { apiKey: validApiKey("usage-chat"), model: "gpt-4o-mini" },
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

  test("generateForChunk reuses cached responses until TTL expires", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("cache"), model: "gpt-4o-mini" },
      performance: { cacheTTLSeconds: 1 },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            { message: { content: commitMessage("feat(core): add cache") } },
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
      commitMessage("feat(core): refresh cache"),
    );
    expect(calls.chat).toHaveLength(2);
  });

  test("generateForChunks uses sequential chunk processing when parallel is disabled", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("sequential"), model: "gpt-4o-mini" },
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
      makeChunk(1, ["src/ai.ts"], "+fallback"),
    );

    expect(result).toBe(commitMessage("fix(ai): use responses fallback"));
    expect(calls.chat).toHaveLength(1);
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
      openai: { apiKey: validApiKey("timeout"), model: "gpt-4o-mini" },
      performance: { timeoutMs: 25 },
    });
    const abortError = new Error("operation timeout");
    abortError.name = "AbortError";
    installOpenAiMock({ chatQueue: [abortError] });
    const ai = await importFreshAi("timeout");

    await expect(
      ai.generateForChunk(makeChunk(1, ["src/ai.ts"], "+timeout")),
    ).rejects.toBeInstanceOf(OpenAITimeoutError);
  });

  test("generateForChunk rejects empty chat responses", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("empty-chat"), model: "gpt-4o-mini" },
    });
    installOpenAiMock({
      chatQueue: [{ choices: [{ message: { content: "   " } }] }],
    });
    const ai = await importFreshAi("empty-chat");

    await expect(
      ai.generateForChunk(makeChunk(1, ["src/ai.ts"], "+empty")),
    ).rejects.toBeInstanceOf(OpenAIError);
  });

  test("generateForChunk rejects subject-only commit messages", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("subject-only"), model: "gpt-4o-mini" },
    });
    installOpenAiMock({
      chatQueue: [
        { choices: [{ message: { content: "feat(ai): missing body" } }] },
      ],
    });
    const ai = await importFreshAi("subject-only");

    await expect(
      ai.generateForChunk(makeChunk(1, ["src/ai.ts"], "+body required")),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("client validation rejects missing API keys", async () => {
    writeLocalConfig();
    const ai = await importFreshAi("missing-key");

    await expect(
      ai.generateForChunk(makeChunk(1, ["src/ai.ts"], "+missing-key")),
    ).rejects.toThrow("No OpenAI API key");
  });

  test("client validation rejects invalid API key formats", async () => {
    writeLocalConfig({
      openai: { apiKey: "invalid-key", model: "gpt-4o-mini" },
    });
    const ai = await importFreshAi("bad-key");

    await expect(
      ai.generateForChunk(makeChunk(1, ["src/ai.ts"], "+bad-key")),
    ).rejects.toThrow("Invalid OpenAI API key format");
  });

  test("client validation rejects invalid model names", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("bad-model"), model: "bad model" },
    });
    const ai = await importFreshAi("bad-model");

    await expect(
      ai.generateForChunk(makeChunk(1, ["src/ai.ts"], "+bad-model")),
    ).rejects.toThrow("Invalid characters in OpenAI model name");
  });

  test("buildGroupingSystemPrompt keeps body requirement even when config disables it", async () => {
    writeLocalConfig({
      commit: {
        conventional: false,
        includeBody: false,
        includeScope: false,
      },
      openai: { apiKey: validApiKey("prompt-config"), model: "gpt-4o-mini" },
    });
    const ai = await importFreshAi("prompt-config");

    const prompt = ai.buildGroupingSystemPrompt();

    expect(prompt).not.toContain("Use the Conventional Commits format");
    expect(prompt).toContain("body using bullet points");
    expect(prompt).toContain("A subject-only commit message is invalid.");
    expect(prompt).not.toContain("Produce only the subject line, no body.");
    expect(prompt).not.toContain("Include a scope in parentheses");
  });

  test("buildGroupingSystemPrompt keeps cohesive tooling rollouts together", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("tooling-prompt"), model: "gpt-4o-mini" },
    });
    const ai = await importFreshAi("tooling-prompt");

    const prompt = ai.buildGroupingSystemPrompt();

    expect(prompt).toContain("quality or tooling workflow");
    expect(prompt).toContain(
      "package.json, lockfiles, config files, and helper scripts",
    );
    expect(prompt).toContain("EXAMPLE 6");
  });

  test("buildGroupingSystemPrompt keeps incidental cleanup with the owning feature", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("cleanup-prompt"), model: "gpt-4o-mini" },
    });
    const ai = await importFreshAi("cleanup-prompt");

    const prompt = ai.buildGroupingSystemPrompt();

    expect(prompt).toContain(
      "do NOT split out incidental formatting, import-order, rename-only, wiring, docs, test, or config hunks",
    );
    expect(prompt).toContain(
      "Standalone style/import-order/formatting commits should be RARE",
    );
    expect(prompt).toContain("EXAMPLE 7");
  });

  test("planCommits skips grouping for a single file with one hunk", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("single-file"), model: "gpt-4o-mini" },
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

  test("planCommits does not recurse forever on an oversized single file", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("single-file-batch"),
        model: "gpt-4o-mini",
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
      openai: { apiKey: validApiKey("recursion"), model: "gpt-4o-mini" },
    });
    const ai = await importFreshAi("recursion");

    await expect(
      ai.planCommits([makeFile("src/a.ts")], formatFileDiff, 6),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("planCommits appends a commit for missed hunks", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("missed-hunks"), model: "gpt-4o-mini" },
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

  test("planCommits falls back to a single commit when grouping JSON is invalid", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("invalid-grouping"), model: "gpt-4o-mini" },
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

    const result = await ai.planCommits(files, formatFileDiff);

    expect(result).toEqual([
      {
        files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        message: commitMessage("chore(core): fallback grouping"),
      },
    ]);
  });

  test("planCommits falls back when grouping response is suspiciously large", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("too-many-groups"), model: "gpt-4o-mini" },
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
      openai: { apiKey: validApiKey("single-pass"), model: "gpt-4o-mini" },
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
      makeFile("src/ai.ts"),
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

    const result = await ai.planCommits(files, formatFileDiff);

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
      openai: { apiKey: validApiKey("adjacent-support"), model: "gpt-4o-mini" },
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
      ],
    });
    const ai = await importFreshAi("adjacent-support");

    const result = await ai.planCommits(files, formatFileDiff);

    expect(calls.chat).toHaveLength(2);
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
      openai: { apiKey: validApiKey("batched-support"), model: "gpt-4o-mini" },
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
                    files: firstBatchFiles.map((file) => ({ path: file.path })),
                    message: commitMessage(
                      "chore(eslint): configure linter scanning pipeline",
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
                    files: secondBatchFiles.map((file) => ({
                      path: file.path,
                    })),
                    message: commitMessage(
                      "chore(reporting): provision analytics and thresholds",
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

    expect(calls.chat).toHaveLength(5);
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

  test("planCommits lets AI consolidate fragmented related groups", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("workflow-rollup"), model: "gpt-4o-mini" },
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
    const calls = installOpenAiMock({
      chatQueue: [
        {
          choices: [
            { message: { content: JSON.stringify(fragmentedGrouping) } },
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
    const ai = await importFreshAi("workflow-rollup");

    const result = await ai.planCommits(files, formatFileDiff);

    expect(calls.chat).toHaveLength(2);
    expect(result).toHaveLength(2);
    expect(result[0]?.message).toBe(
      commitMessage("chore(tooling): add quality and validation workflow"),
    );
    expect(result[0]?.files.map((file: { path: string }) => file.path)).toEqual(
      [
        ".gitleaks.toml",
        ".secretlintrc",
        ".gitignore",
        ".jscpd.json",
        "bun.lock",
        "eslint.config.js",
        "package.json",
        "scripts/check.json",
        "scripts/check.ts",
        "tests/ai-coverage.test.ts",
        "tests/git-coverage.test.ts",
        "tests/tsconfig.json",
        "knip.json",
        ".husky/pre-commit",
      ],
    );
    expect(result[1]).toEqual({
      files: [{ path: "logo.svg" }],
      message: commitMessage("style(branding): refresh logo artwork"),
    });
  });

  test("planCommits repeats consolidation until the plan stabilizes", async () => {
    writeLocalConfig({
      openai: {
        apiKey: validApiKey("iterative-consolidation"),
        model: "gpt-4o-mini",
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
    const fragmentedGrouping = [
      {
        files: [
          { path: "eslint.config.js" },
          { hunks: [0], path: "package.json" },
        ],
        message: commitMessage("chore(tooling): add lint config"),
      },
      {
        files: [{ path: "scripts/check.json" }, { path: "scripts/check.ts" }],
        message: commitMessage("chore(check): add quality runner"),
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
        model: "gpt-4o-mini",
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

    expect(calls.chat).toHaveLength(3);
    expect(result).toEqual([
      {
        files: [
          { path: "src/app/dashboard/components/Background.tsx" },
          { path: "src/app/dashboard/components/DashboardTopHeaderBar.tsx" },
          { path: "src/app/dashboard/components/settings/SettingsModal.tsx" },
          { path: "src/app/dashboard/hooks/useFeedLoader.ts" },
        ],
        message: commitMessage(
          "style(dashboard): normalize dashboard formatting and layout",
        ),
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
    ]);
  });

  test("planCommits pre-merges style-sweep fragmentation deterministically", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("premerge-style"), model: "gpt-4o-mini" },
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

    // grouping + 1 consolidation = 2 calls (no cluster needed)
    expect(calls.chat).toHaveLength(2);
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
        model: "gpt-4o-mini",
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

    // grouping + consolidation = 2 calls (no clustering needed for 2 commits)
    expect(calls.chat).toHaveLength(2);
    // Pre-merge collapsed the 2 style commits despite duplicate hunk 0
    expect(result).toHaveLength(2);
  });

  test("planCommits uses AI clustering when plan exceeds threshold", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("cluster-merge"), model: "gpt-4o-mini" },
    });
    // Build enough files so the initial grouping produces >= CLUSTERING_THRESHOLD commits
    const featFiles = [
      makeFile("src/app/api/auth/signup/route.ts"),
      makeFile("src/app/components/legal/metadata.ts"),
      makeFile("src/app/components/legal/content.tsx"),
      makeFile("src/app/components/LegalDocumentPage.tsx"),
      makeFile("src/lib/api/auth-service.ts"),
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
      ],
    });

    const ai = await importFreshAi("cluster-merge");
    const result = await ai.planCommits(allFiles, formatFileDiff);

    // grouping + cluster + consolidation = 3 calls
    expect(calls.chat).toHaveLength(3);
    // Final result is 3 commits (two feat + one style sweep)
    expect(result).toHaveLength(3);
    const styleCommit = result.find(
      (c: { files: unknown[]; message: string }) => c.message.includes("style"),
    );
    expect(styleCommit?.files).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════

/**
 * Regression suite for the real librerss 177-file run that previously
 * produced 43 fragmented commits instead of ~7-10 semantic commits.
 *
 * The exact 43 commit subjects from that run are used as fixtures so this
 * suite acts as a concrete regression guard.
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
        model: "gpt-4o-mini",
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
      rFile("src/app/dashboard/components/DashboardMobileSidebarSheet.tsx", 2),
      rFile("src/app/dashboard/components/DashboardShellSkeleton.tsx", 2),
      rFile("src/app/dashboard/components/DashboardSidebarContent.tsx"),
      rFile("src/app/dashboard/components/DashboardTopHeaderBar.tsx", 2),
      rFile("src/app/dashboard/components/DashboardTopTokenBar.tsx"),
      rFile("src/app/dashboard/components/PullToRefreshSentinel.tsx"),
      rFile("src/app/dashboard/components/feed/FeedCategory.tsx"),
      rFile("src/app/dashboard/components/feed/FeedList.tsx", 4),
      // Commit 17 – settings account
      rFile("src/app/dashboard/components/settings/SettingsAccountSection.tsx"),
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
      rCommit("feat(config): add legal and proxy compatibility env variables", [
        ".env",
      ]),
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
      rCommit("feat(api-account): add account export and deletion endpoints", [
        "src/app/api/account/export/route.ts",
        "src/app/api/account/route.ts",
      ]),
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
      rCommit("feat(auth): require legal consent during signup in login view", [
        "src/app/dashboard/components/login/LoginView.tsx",
      ]),
      // 15 – style(dashboard) C16
      rCommit("style(dashboard): normalize import order and minor formatting", [
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
      ]),
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
      rCommit("refactor(config): rename proxy compatibility rate limit keys", [
        "src/lib/config.ts",
      ]),
      // 25 – fix(feed-http) C26
      rCommit("fix(feed-http): clarify DataDome 403 error message", [
        "src/lib/core/feed-http.ts",
      ]),
      // 26 – refactor(async) C27
      rCommit("refactor(async): return explicit undefined in no-op disposers", [
        "src/lib/api/http/client.ts",
        "src/lib/db/neon-provider.ts",
      ]),
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
      rCommit("feat(api-services): export AccountService from service barrel", [
        "src/lib/api/services.ts",
      ]),
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
      rCommit("test(e2e): add shared Playwright base and legal page coverage", [
        "tests/e2e/helpers.ts",
        "tests/e2e/test.ts",
        "tests/e2e/public-legal-pages.e2e.ts",
      ]),
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
        // consolidation fires but queue empty → throws → caught → break
      ],
    });

    // Import grouping module fresh so it picks up the mocked openai module.
    const { finalizePlannedGroups } = await import(
      new URL(
        `../src/ai-grouping.js?librerss-regression-${Math.random()}`,
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
    expect(calls.chat.length).toBeLessThanOrEqual(6);
    // Final count is well below the regressed 43
    expect(result.length).toBeLessThan(43);
    // Pre-merge collapsed all 8 style commits into fewer groups.
    // After clustering they merge further, but the original 8 fragments are gone.
    const styleCommits = result.filter((c) => c.message.startsWith("style"));
    // Pre-merge ensures there cannot be 8 separate style commits in the output
    expect(styleCommits.length).toBeLessThan(8);
  });

  test("premergeBySubject collapses all 8 style sweep commits to 1 group", async () => {
    const { premergeBySubject } = await import("../src/ai-grouping.js");

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
});
