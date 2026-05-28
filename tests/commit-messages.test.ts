import {
  loadConfig,
  resetConfigCache,
} from "../src/application/config/index.js";
import { ValidationError } from "../src/application/errors.js";
import {
  markCommitMessageBreaking,
  suppressCommitMessageBreaking,
  validateCommitMessage,
} from "../src/commit-messages/formatting.js";
import { parseConventionalSubject } from "../src/commit-messages/subject-parser.js";
import {
  breakingChangeFooterRules,
  breakingSensitivityModeRules,
  commitMessageAuthoringRules,
  conventionalCommitTypeRules,
  releaseImpactCompatibilityRules,
  releaseImpactMetadataDisabledRules,
} from "../src/commit-planning/prompts/rules/commit/index.js";

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
    expect(parsed.isBreaking).toBe(false);
    expect(parsed.description).toBe("add endpoint");
  });

  test("parses ! suffixed prefixes as breaking conventional subjects", () => {
    const parsed = parseConventionalSubject("feat!: remove legacy endpoint");
    expect(parsed.type).toBe("feat");
    expect(parsed.scope).toBe("");
    expect(parsed.isBreaking).toBe(true);
    expect(parsed.description).toBe("remove legacy endpoint");
  });

  test("parses ! suffixed scoped prefixes as breaking conventional subjects", () => {
    const parsed = parseConventionalSubject(
      "refactor(config)!: rename configFile to configPath",
    );
    expect(parsed.type).toBe("refactor");
    expect(parsed.scope).toBe("config");
    expect(parsed.isBreaking).toBe(true);
    expect(parsed.description).toBe("rename configFile to configPath");
  });

  test("returns a plain subject for an unrecognised prefix", () => {
    const parsed = parseConventionalSubject("update some stuff");
    expect(parsed.type).toBe("");
    expect(parsed.scope).toBe("");
    expect(parsed.isBreaking).toBe(false);
    expect(parsed.description).toBe("update some stuff");
  });

  test("parses a fix subject without a breaking marker", () => {
    const parsed = parseConventionalSubject("fix(core): correct null guard");
    expect(parsed.type).toBe("fix");
    expect(parsed.scope).toBe("core");
    expect(parsed.isBreaking).toBe(false);
    expect(parsed.description).toBe("correct null guard");
  });

  test("parses semantic-release compatible hyphenated scopes", () => {
    const parsed = parseConventionalSubject(
      "feat(commit-messages)!: preserve breaking syntax",
    );
    expect(parsed.type).toBe("feat");
    expect(parsed.scope).toBe("commit-messages");
    expect(parsed.isBreaking).toBe(true);
    expect(parsed.description).toBe("preserve breaking syntax");
  });

  test("normalizes path-like scopes to path-free identifiers", () => {
    const parsed = parseConventionalSubject(
      "feat(src/commit-planning/prompts): add staged prompt builders",
    );
    expect(parsed.type).toBe("feat");
    expect(parsed.scope).toBe("commit-planning-prompts");
    expect(parsed.isBreaking).toBe(false);
    expect(parsed.description).toBe("add staged prompt builders");
  });
});

// ─── markCommitMessageBreaking ──────────────────────────────────────────────

describe("markCommitMessageBreaking", () => {
  test("adds the breaking marker and footer after an unscoped conventional type", () => {
    expect(
      markCommitMessageBreaking(
        msg("feat: remove legacy API", "- Remove the legacy API route."),
      ),
    ).toBe(
      msg(
        "feat!: remove legacy API",
        "- Remove the legacy API route.",
        "",
        "BREAKING CHANGE: Remove legacy API. Remove the legacy API route.",
      ),
    );
  });

  test("adds the breaking marker and footer after a scoped conventional prefix", () => {
    expect(
      markCommitMessageBreaking(
        msg(
          "refactor(config): rename configFile to configPath",
          "- Rename configFile consumers to configPath.",
        ),
      ),
    ).toBe(
      msg(
        "refactor(config)!: rename configFile to configPath",
        "- Rename configFile consumers to configPath.",
        "",
        "BREAKING CHANGE: Rename configFile to configPath. Rename configFile consumers to configPath.",
      ),
    );
  });

  test("preserves the original conventional prefix when adding the marker", () => {
    expect(
      markCommitMessageBreaking(
        msg(
          "feat(commit-messages): support flag",
          "- Add a flag for release-impact commits.",
        ),
      ),
    ).toBe(
      msg(
        "feat(commit-messages)!: support flag",
        "- Add a flag for release-impact commits.",
        "",
        "BREAKING CHANGE: Support flag. Add a flag for release-impact commits.",
      ),
    );
  });

  test("synthesizes a complete footer from a wrapped bullet body", () => {
    expect(
      markCommitMessageBreaking(
        msg(
          "fix(commit-messages): enforce and synthesize breaking footers",
          "- Require commits with a conventional `!` subject marker to include a",
          "  `BREAKING CHANGE:` footer and reject messages that omit it.",
          "- Add footer parsing and validation rules.",
        ),
      ),
    ).toBe(
      msg(
        "fix(commit-messages)!: enforce and synthesize breaking footers",
        "- Require commits with a conventional `!` subject marker to include a",
        "  `BREAKING CHANGE:` footer and reject messages that omit it.",
        "- Add footer parsing and validation rules.",
        "",
        "BREAKING CHANGE: Enforce and synthesize breaking footers. Require commits with a conventional `!` subject marker to include a `BREAKING CHANGE:` footer and reject messages that omit it.",
      ),
    );
  });

  test("leaves an already complete breaking message unchanged", () => {
    expect(
      markCommitMessageBreaking(
        msg(
          "feat(api)!: remove v1 routes",
          "- Remove the v1 routes from generated clients.",
          "",
          "BREAKING CHANGE: API consumers must move from v1 routes to v2 routes before upgrading.",
        ),
      ),
    ).toBe(
      msg(
        "feat(api)!: remove v1 routes",
        "- Remove the v1 routes from generated clients.",
        "",
        "BREAKING CHANGE: API consumers must move from v1 routes to v2 routes before upgrading.",
      ),
    );
  });

  test("adds a missing footer to an already breaking conventional subject", () => {
    expect(
      markCommitMessageBreaking(
        msg(
          "fix(commit-planning)!: isolate allowed breaking prompt mode",
          "- Thread allowed breaking mode through grouping and generation prompts.",
        ),
      ),
    ).toBe(
      msg(
        "fix(commit-planning)!: isolate allowed breaking prompt mode",
        "- Thread allowed breaking mode through grouping and generation prompts.",
        "",
        "BREAKING CHANGE: Isolate allowed breaking prompt mode. Thread allowed breaking mode through grouping and generation prompts.",
      ),
    );
  });

  test("does not mark cosmetic or workflow-only subjects as breaking", () => {
    const nonBreakingSubjects = [
      "style(formatting): normalize whitespace",
      "docs(readme): clarify usage",
      "test(cli): cover breaking flag",
      "ci(release): cache dependencies",
      "chore(deps): update lockfile",
    ];

    for (const subject of nonBreakingSubjects) {
      expect(markCommitMessageBreaking(msg(subject))).toBe(msg(subject));
    }
  });

  test("leaves non-conventional subjects unchanged after validation", () => {
    expect(markCommitMessageBreaking(msg("remove legacy API"))).toBe(
      msg("remove legacy API"),
    );
  });
});

// ─── suppressCommitMessageBreaking ─────────────────────────────────────────

describe("suppressCommitMessageBreaking", () => {
  test("removes release-triggering metadata and neutralizes generic breaking prose", () => {
    const result = suppressCommitMessageBreaking(
      msg(
        "feat(api)!: remove legacy config tolerance",
        "- This breaking change requires migration for public config consumers.",
        "- Keep --breaking, breakingMode, and breaking-mode identifiers unchanged.",
        "",
        "BREAKING CHANGE: Public config consumers must migrate before upgrading.",
      ),
    );

    expect(result).toBe(
      msg(
        "feat(api): remove legacy config tolerance",
        "- This compatibility-impact change requires adjustment for public config consumers.",
        "- Keep --breaking, breakingMode, and breaking-mode identifiers unchanged.",
      ),
    );
  });
});

// ─── validateCommitMessage ───────────────────────────────────────────────────

describe("validateCommitMessage", () => {
  test("normalizes path-derived conventional scopes during validation", () => {
    const input = [
      "feat(src/cli): add lazy command dispatch",
      "",
      "- Parse command options before loading runtime dependencies.",
    ].join("\n");

    expect(validateCommitMessage(input)).toBe(
      [
        "feat(cli): add lazy command dispatch",
        "",
        "- Parse command options before loading runtime dependencies.",
      ].join("\n"),
    );
  });

  test("normalizes dotted scopes during validation", () => {
    const input = [
      "fix(config.service): guard cache lookups",
      "",
      "- Recheck cache ownership before serving stale entries.",
    ].join("\n");

    expect(validateCommitMessage(input)).toBe(
      [
        "fix(config-service): guard cache lookups",
        "",
        "- Recheck cache ownership before serving stale entries.",
      ].join("\n"),
    );
  });

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

  test("accepts breaking messages with a comprehensive footer", () => {
    const input = [
      "feat!: drop Node 16 support",
      "",
      "- Remove Node 16 from CI matrix.",
      "- Bump minimum engines requirement to Node 18.",
      "",
      "BREAKING CHANGE: Node 16 is no longer supported; upgrade to Node 18.",
    ].join("\n");

    expect(validateCommitMessage(input)).toBe(input);
  });

  test("accepts BREAKING-CHANGE footer spelling used by conventional commits", () => {
    const input = [
      "refactor(config)!: rename configFile to configPath",
      "",
      "- Rename all internal references from configFile to configPath.",
      "",
      "BREAKING-CHANGE: config.configFile is now config.configPath.",
    ].join("\n");

    expect(validateCommitMessage(input)).toBe(input);
  });

  test("rejects breaking subjects without a breaking-change footer", () => {
    const input = [
      "feat!: drop Node 16 support",
      "",
      "- Remove Node 16 from CI matrix.",
      "- Bump minimum engines requirement to Node 18.",
    ].join("\n");

    expect(() => validateCommitMessage(input)).toThrow(ValidationError);
  });

  test("rejects breaking-change footers without a separating blank line", () => {
    const input = [
      "refactor(config)!: rename configFile to configPath",
      "",
      "- Rename all internal references from configFile to configPath.",
      "BREAKING CHANGE: config.configFile is now config.configPath.",
    ].join("\n");

    expect(() => validateCommitMessage(input)).toThrow(ValidationError);
  });

  test("rejects vague breaking-change footers", () => {
    const input = [
      "feat!: drop Node 16 support",
      "",
      "- Remove Node 16 from CI matrix.",
      "",
      "BREAKING CHANGE: Breaking.",
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

// ─── commitMessageAuthoringRules ─────────────────────────────────────────────

describe("commitMessageAuthoringRules", () => {
  test("defines behavior-first commit type selection", () => {
    const joined = conventionalCommitTypeRules().join("\n");

    expect(joined).toContain("externally observable reason");
    expect(joined).toContain(
      "Use fix for any change that corrects wrong behavior",
    );
    expect(joined).toContain("Use refactor only when runtime behavior");
    expect(joined).toContain("stop forcing output");
    expect(joined).toContain("When in doubt between fix and refactor");
  });

  test("defines breaking impact by supported public contracts", () => {
    const joined = releaseImpactCompatibilityRules().join("\n");

    expect(joined).toContain("supported public contract");
    expect(joined).toContain("documented or reasonably relied-on CLI flag");
    expect(joined).toContain("requires downstream migration");
    expect(joined).toContain("prompt-only");
    expect(joined).toContain("old behavior was documented");
  });

  test("defines --breaking as sensitivity instead of permission", () => {
    const joined = breakingSensitivityModeRules().join("\n");

    expect(joined).toContain("BREAKING SENSITIVITY MODE");
    expect(joined).toContain("inspect public contracts more aggressively");
    expect(joined).toContain("forced-major mode");
  });

  test("defines breaking footer quality outside sensitivity mode", () => {
    const joined = breakingChangeFooterRules().join("\n");

    expect(joined).toContain("release-note-quality migration paragraph");
    expect(joined).toContain("who is affected, what no longer works");
    expect(joined).toContain("Use exact identifiers");
    expect(joined).toContain("keep the bullet body first");
  });

  test("keeps breaking sensitivity guidance out of default prompts", () => {
    const instructions = commitMessageAuthoringRules();
    const joined = instructions.join("\n");
    expect(joined).toContain(
      "Choose the commit type from the externally observable reason",
    );
    expect(joined).toContain("Use refactor only when runtime behavior");
    expect(joined).toContain("BREAKING CHANGE:");
    expect(joined).toContain("supported public contract");
    expect(joined).toContain("release-note-quality migration paragraph");
    expect(joined).toContain(
      "Use exact identifiers in the BREAKING CHANGE: footer",
    );
    expect(joined).not.toContain("BREAKING SENSITIVITY MODE");
    expect(joined).not.toContain("--breaking");
    expect(joined).not.toContain("inspect public contracts more aggressively");
  });

  test("adds breaking sensitivity guidance when requested", () => {
    const instructions = commitMessageAuthoringRules({
      breakingMode: "sensitive",
    });
    const joined = instructions.join("\n");
    expect(joined).toContain("BREAKING SENSITIVITY MODE");
    expect(joined).toContain("the user passed --breaking");
    expect(joined).toContain("inspect public contracts more aggressively");
    expect(joined).toContain("append ! after the type/scope prefix");
    expect(joined).toContain(
      "semantic-release interprets any commit with ! or a BREAKING CHANGE: footer as a major-version trigger",
    );
    expect(joined).toContain("README-only");
    expect(joined).toContain("supported public contract");
    expect(joined).toContain("documented or reasonably relied-on CLI flag");
    expect(joined).toContain("old behavior was documented");
    expect(joined).toContain("without reading the diff");
    expect(joined).toContain("actual consumer migration obligation");
    expect(joined).toContain(
      "Infer the BREAKING CHANGE: footer from everything provided",
    );
    expect(joined).toContain("who is affected, what no longer works");
    expect(joined).toContain(
      "Use exact identifiers in the BREAKING CHANGE: footer",
    );
    expect(joined).toContain(
      "Do not build the BREAKING CHANGE: footer by restating the subject",
    );
    expect(joined).toContain("2-4 substantive sentences");
    expect(joined).toContain("old input that used to pass");
  });

  test("suppresses breaking authoring guidance when no-breaking is requested", () => {
    const instructions = commitMessageAuthoringRules({
      breakingMode: "disabled",
    });
    const joined = instructions.join("\n");

    expect(joined).toContain("Release-impact metadata is disabled");
    expect(joined).toContain("ordinary commit messages");
    expect(joined).toContain("release-triggering subject markers");
    expect(joined).not.toContain("BREAKING CHANGE:");
    expect(joined).not.toContain("BREAKING SENSITIVITY MODE");
    expect(joined).not.toContain("append ! after the type/scope prefix");
    expect(joined).not.toContain("major-version");
    expect(joined).not.toContain("migration");
  });

  test("defines no-breaking mode without release footer language", () => {
    const joined = releaseImpactMetadataDisabledRules().join("\n");

    expect(joined).toContain("Release-impact metadata is disabled");
    expect(joined).toContain("Do not use release-triggering subject markers");
    expect(joined).not.toContain("BREAKING CHANGE");
    expect(joined).not.toContain("major-version");
    expect(joined).not.toContain("migration");
  });

  test("still includes core conventional-commit guidance when enabled", () => {
    const cfg = loadConfig();
    if (cfg.commit.conventional) {
      const instructions = commitMessageAuthoringRules();
      expect(instructions.join("\n")).toContain(
        "Use the Conventional Commits format",
      );
    }
  });
});
