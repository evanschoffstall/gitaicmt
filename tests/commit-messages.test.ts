import { loadConfig, resetConfigCache } from "../src/application/config/index.js";
import { ValidationError } from "../src/application/errors.js";
import { validateCommitMessage } from "../src/commit-messages/formatting.js";
import {
  parseConventionalSubject,
} from "../src/commit-messages/subject-parser.js";
import { commitFormatInstructions } from "../src/commit-planning/prompt-builders/commit-format.js";

const { beforeEach, describe, expect, test } = await import("bun:test");

beforeEach(() => {
  resetConfigCache();
  process.env["OPENAI_API_KEY"] = "sk-test-key-for-testing";
});

// ─── helpers ────────────────────────────────────────────────────────────────

function msg(subject: string, ...bodyLines: string[]): string {
  const body = bodyLines.length > 0 ? bodyLines : ["- No-op placeholder."];
  return [subject, "", ...body].join("\n");
}

// ─── parseConventionalSubject ────────────────────────────────────────────────

describe("parseConventionalSubject", () => {
  test("parses a plain conventional subject", () => {
    const parsed = parseConventionalSubject("feat(api): add endpoint");
    expect(parsed.type).toBe("feat");
    expect(parsed.scope).toBe("api");
    expect(parsed.description).toBe("add endpoint");
  });

  test("treats ! suffixed prefixes as non-conventional subjects", () => {
    const parsed = parseConventionalSubject("feat!: remove legacy endpoint");
    expect(parsed.type).toBe("");
    expect(parsed.scope).toBe("");
    expect(parsed.description).toBe("feat!: remove legacy endpoint");
  });

  test("treats ! suffixed scoped prefixes as non-conventional subjects", () => {
    const parsed = parseConventionalSubject("refactor(config)!: rename configFile to configPath");
    expect(parsed.type).toBe("");
    expect(parsed.scope).toBe("");
    expect(parsed.description).toBe(
      "refactor(config)!: rename configFile to configPath",
    );
  });

  test("returns a plain subject for an unrecognised prefix", () => {
    const parsed = parseConventionalSubject("update some stuff");
    expect(parsed.type).toBe("");
    expect(parsed.scope).toBe("");
    expect(parsed.description).toBe("update some stuff");
  });

  test("parses a fix subject without a breaking marker", () => {
    const parsed = parseConventionalSubject("fix(core): correct null guard");
    expect(parsed.type).toBe("fix");
    expect(parsed.scope).toBe("core");
    expect(parsed.description).toBe("correct null guard");
  });
});

// ─── validateCommitMessage ───────────────────────────────────────────────────

describe("validateCommitMessage", () => {
  test("accepts a bullet-only body", () => {
    const input = [
      "feat(api): remove /v1/users endpoint",
      "",
      "- Remove deprecated /v1/users route per the v2 migration plan.",
      "- Update integration tests to target /v2/users.",
    ].join("\n");

    const result = validateCommitMessage(input);
    expect(result).toBe(input);
  });

  test("rejects BREAKING CHANGE footer lines", () => {
    const input = [
      "feat: drop Node 16 support",
      "",
      "- Remove Node 16 from CI matrix.",
      "- Bump minimum engines requirement to Node 18.",
      "",
      "BREAKING CHANGE: Node 16 is no longer supported; upgrade to Node 18.",
    ].join("\n");

    expect(() => validateCommitMessage(input)).toThrow(ValidationError);
  });

  test("rejects BREAKING-CHANGE footer lines", () => {
    const input = [
      "refactor(config): rename configFile to configPath",
      "",
      "- Rename all internal references from configFile to configPath.",
      "BREAKING-CHANGE: config.configFile is now config.configPath.",
    ].join("\n");

    expect(() => validateCommitMessage(input)).toThrow(ValidationError);
  });

  test("rejects non-bullet body lines even after valid bullets", () => {
    const input = [
      "feat: remove endpoint",
      "",
      "- Remove deprecated endpoint.",
      "This line is not a bullet.",
    ].join("\n");

    expect(() => validateCommitMessage(input)).toThrow(ValidationError);
  });
});

// ─── commitFormatInstructions ────────────────────────────────────────────────

describe("commitFormatInstructions", () => {
  test("does not include breaking change guidance when conventional commits are enabled", () => {
    const instructions = commitFormatInstructions();
    const joined = instructions.join("\n");
    expect(joined).not.toContain("BREAKING CHANGE:");
    expect(joined).not.toContain("Append ! after the type/scope prefix");
  });

  test("still includes core conventional-commit guidance when enabled", () => {
    const cfg = loadConfig();
    if (cfg.commit.conventional) {
      const instructions = commitFormatInstructions();
      expect(instructions.join("\n")).toContain(
        "Use the Conventional Commits format",
      );
    }
  });
});
