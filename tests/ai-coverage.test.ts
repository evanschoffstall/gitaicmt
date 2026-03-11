import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULTS, resetConfigCache } from "../src/config.js";
import {
  OpenAIError,
  OpenAITimeoutError,
  ValidationError,
} from "../src/errors.js";

declare const afterEach: typeof import("bun:test").afterEach;
declare const beforeEach: typeof import("bun:test").beforeEach;
declare const describe: typeof import("bun:test").describe;
declare const expect: typeof import("bun:test").expect;
declare const test: typeof import("bun:test").test;

type DiffChunk = import("../src/diff.js").DiffChunk;
type DiffStats = import("../src/diff.js").DiffStats;
type FileDiff = import("../src/diff.js").FileDiff;

const { mock, setSystemTime } = await import("bun:test");

type MockResult = Error | unknown;

const originalCwd = process.cwd();
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

let sandboxDir = "";
let xdgConfigHome = "";

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS)) as typeof DEFAULTS;
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
        { choices: [{ message: { content: "feat(core): add cache" } }] },
        { choices: [{ message: { content: "feat(core): refresh cache" } }] },
      ],
    });
    const ai = await importFreshAi("cache");
    const chunk = makeChunk(1, ["src/cache.ts"], "+cache hit");

    setSystemTime(0);
    expect(await ai.generateForChunk(chunk)).toBe("feat(core): add cache");
    expect(await ai.generateForChunk(chunk)).toBe("feat(core): add cache");

    setSystemTime(2_000);
    expect(await ai.generateForChunk(chunk)).toBe("feat(core): refresh cache");
    expect(calls.chat).toHaveLength(2);
  });

  test("generateForChunks uses sequential chunk processing when parallel is disabled", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("sequential"), model: "gpt-4o-mini" },
      performance: { parallel: false },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        { choices: [{ message: { content: "feat(core): part one" } }] },
        { choices: [{ message: { content: "feat(core): part two" } }] },
        { choices: [{ message: { content: "feat(core): merged" } }] },
      ],
    });
    const ai = await importFreshAi("sequential");

    const result = await ai.generateForChunks(
      [makeChunk(1, ["src/a.ts"], "+a"), makeChunk(2, ["src/b.ts"], "+b")],
      makeStats(),
    );

    expect(result).toBe("feat(core): merged");
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
      responseQueue: [{ output_text: "fix(ai): use responses fallback" }],
    });
    const ai = await importFreshAi("responses-fallback");

    const result = await ai.generateForChunk(
      makeChunk(1, ["src/ai.ts"], "+fallback"),
    );

    expect(result).toBe("fix(ai): use responses fallback");
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

  test("buildGroupingSystemPrompt respects non-conventional subject-only config", async () => {
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
    expect(prompt).toContain("Produce only the subject line, no body.");
    expect(prompt).not.toContain("Include a scope in parentheses");
  });

  test("planCommits skips grouping for a single file with one hunk", async () => {
    writeLocalConfig({
      openai: { apiKey: validApiKey("single-file"), model: "gpt-4o-mini" },
    });
    const calls = installOpenAiMock({
      chatQueue: [
        { choices: [{ message: { content: "feat(app): update app" } }] },
      ],
    });
    const ai = await importFreshAi("single-file");
    const file = makeFile("src/app.ts");

    const result = await ai.planCommits([file], formatFileDiff);

    expect(result).toEqual([
      { files: [{ path: "src/app.ts" }], message: "feat(app): update app" },
    ]);
    expect(calls.chat).toHaveLength(1);
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
    installOpenAiMock({
      chatQueue: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    files: [{ hunks: [0], path: "src/app.ts" }],
                    message: "feat(app): update first hunk",
                  },
                ]),
              },
            },
          ],
        },
        { choices: [{ message: { content: "fix(app): cover second hunk" } }] },
      ],
    });
    const ai = await importFreshAi("missed-hunks");

    const result = await ai.planCommits(
      [makeFile("src/app.ts", 2)],
      formatFileDiff,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      files: [{ hunks: [0], path: "src/app.ts" }],
      message: "feat(app): update first hunk",
    });
    expect(result[1]).toEqual({
      files: [{ hunks: [1], path: "src/app.ts" }],
      message: "fix(app): cover second hunk",
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
          choices: [{ message: { content: "chore(core): fallback grouping" } }],
        },
      ],
    });
    const ai = await importFreshAi("invalid-grouping-json");
    const files = [makeFile("src/a.ts"), makeFile("src/b.ts")];

    const result = await ai.planCommits(files, formatFileDiff);

    expect(result).toEqual([
      {
        files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        message: "chore(core): fallback grouping",
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
        { choices: [{ message: { content: "chore(core): collapse groups" } }] },
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
        message: "chore(core): collapse groups",
      },
    ]);
  });
});
