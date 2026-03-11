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
      { files: [{ path: "src/app.ts" }], message: "feat(app): update app" },
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
              message: { content: commitMessage("fix(app): cover second hunk") },
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
              message: { content: commitMessage("chore(core): fallback grouping") },
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
              message: { content: commitMessage("chore(core): collapse groups") },
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
        message: "chore(tooling): bundle quality workflow updates",
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
        message: "chore(tooling): add lint config and check manifest",
      },
      {
        files: [{ path: "scripts/check.ts" }],
        message: "feat(scripts): add configurable bun check runner",
      },
      {
        files: [{ path: "logo.svg" }],
        message: "style(branding): refresh logo artwork",
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
                    message: "chore(tooling): add bun check workflow",
                  },
                  {
                    files: [{ path: "logo.svg" }],
                    message: "style(branding): refresh logo artwork",
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
        message: "chore(tooling): add bun check workflow",
      },
      {
        files: [{ path: "logo.svg" }],
        message: "style(branding): refresh logo artwork",
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
                    message: "chore(tooling): add baseline tooling configs",
                  },
                  {
                    files: firstBatchFiles
                      .slice(12)
                      .map((file) => ({ path: file.path })),
                    message: "chore(tooling): add extended tooling configs",
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
                    message: "chore(tooling): add reporting config set A",
                  },
                  {
                    files: secondBatchFiles
                      .slice(2)
                      .map((file) => ({ path: file.path })),
                    message: "chore(tooling): add reporting config set B",
                  },
                  {
                    files: [{ path: "logo.svg" }],
                    message: "style(branding): refresh logo artwork",
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
                    message: "chore(tooling): add batch-one quality configs",
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
                    message: "chore(tooling): add batch-two reporting configs",
                  },
                  {
                    files: [{ path: "logo.svg" }],
                    message: "style(branding): refresh logo artwork",
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
                    message: "chore(tooling): add quality workflow foundation",
                  },
                  {
                    files: [{ path: "logo.svg" }],
                    message: "style(branding): refresh logo artwork",
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
      "chore(tooling): add quality workflow foundation",
    );
    expect(result[0]?.files).toHaveLength(28);
    expect(result[1]).toEqual({
      files: [{ path: "logo.svg" }],
      message: "style(branding): refresh logo artwork",
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
        message:
          "chore(security): add secret scanning config and ignore outputs",
      },
      {
        files: [{ hunks: [0], path: ".jscpd.json" }],
        message: "chore(quality): add jscpd duplicate code detection config",
      },
      {
        files: [{ path: "bun.lock" }],
        message: "chore(deps): update bun lockfile with new linting toolchain",
      },
      {
        files: [
          { hunks: [0], path: "eslint.config.js" },
          { hunks: [0, 1], path: "package.json" },
          { hunks: [0], path: "scripts/check.json" },
        ],
        message: "chore(tooling): add ESLint and unified quality check config",
      },
      {
        files: [{ path: "scripts/check.ts" }],
        message:
          "feat(scripts): add configurable bun check orchestrator script",
      },
      {
        files: [
          { path: "tests/ai-coverage.test.ts" },
          { path: "tests/git-coverage.test.ts" },
          { path: "tests/tsconfig.json" },
        ],
        message: "test(coverage): add AI and git coverage test suites",
      },
      {
        files: [{ path: "knip.json" }],
        message: "chore(knip): add unused-code analysis configuration",
      },
      {
        files: [{ path: ".husky/pre-commit" }],
        message: "chore(husky): remove pre-commit API key guard hook",
      },
      {
        files: [{ path: "logo.svg" }],
        message: "style(branding): refresh logo artwork",
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
                    message:
                      "chore(tooling): add quality and validation workflow",
                  },
                  {
                    files: [{ path: "logo.svg" }],
                    message: "style(branding): refresh logo artwork",
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
      "chore(tooling): add quality and validation workflow",
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
      message: "style(branding): refresh logo artwork",
    });
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
        message: "style(dashboard): normalize prop and attribute ordering",
      },
      {
        files: [
          { path: "src/app/dashboard/components/settings/SettingsModal.tsx" },
        ],
        message:
          "style(settings): normalize prop ordering and JSX attribute layout",
      },
      {
        files: [{ path: "src/app/dashboard/hooks/useFeedLoader.ts" }],
        message:
          "style(dashboard-hooks): normalize hook type and object formatting\n\n- Keep behavior unchanged while improving readability.",
      },
      {
        files: [{ path: "src/app/dashboard/services/dashboard-view-model.ts" }],
        message:
          "refactor(dashboard): reorganize helper layout without changing behavior",
      },
      {
        files: [{ path: "src/lib/auth/session.ts" }],
        message: "refactor(auth): extract session cache invalidation",
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
                    message:
                      "style(dashboard): normalize dashboard formatting and layout",
                  },
                  {
                    files: [
                      {
                        path: "src/app/dashboard/services/dashboard-view-model.ts",
                      },
                    ],
                    message:
                      "refactor(dashboard): reorganize helper layout without changing behavior",
                  },
                  {
                    files: [{ path: "src/lib/auth/session.ts" }],
                    message:
                      "refactor(auth): extract session cache invalidation",
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
        files: [
          { path: "src/app/dashboard/components/Background.tsx" },
          { path: "src/app/dashboard/components/DashboardTopHeaderBar.tsx" },
          { path: "src/app/dashboard/components/settings/SettingsModal.tsx" },
          { path: "src/app/dashboard/hooks/useFeedLoader.ts" },
        ],
        message: "style(dashboard): normalize dashboard formatting and layout",
      },
      {
        files: [{ path: "src/app/dashboard/services/dashboard-view-model.ts" }],
        message:
          "refactor(dashboard): reorganize helper layout without changing behavior",
      },
      {
        files: [{ path: "src/lib/auth/session.ts" }],
        message: "refactor(auth): extract session cache invalidation",
      },
    ]);
  });
});
