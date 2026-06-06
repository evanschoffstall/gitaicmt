import { loadConfig } from "../../../../application/config/index.js";
import { formatScalar } from "../../../../commit-messages/formatting.js";

/** Runtime options that tailor commit-message rules to the active CLI mode. */
export type BreakingChangeMode = "disabled" | "normal" | "sensitive";

export interface CommitMessageRuleOptions {
  breakingMode?: BreakingChangeMode;
}

/** Returns the required footer-quality rules for any genuinely breaking commit. */
export function breakingChangeFooterRules(): string[] {
  return [
    "A BREAKING CHANGE: footer is the most important release-note field for commits that are genuinely breaking: make it longer, more specific, and more actionable than the body bullets, with enough context for a downstream maintainer to migrate without reading the diff.",
    "If the body says a flag, validator, parser, exported helper, config key, CLI path, output shape, or release automation contract changed, decide whether that creates an actual consumer migration obligation before adding !; if it does, the footer must name that exact obligation before upgrade.",
    "The BREAKING CHANGE: footer must be a release-note-quality migration paragraph, not a short summary; write 2-4 substantive sentences when the impact is non-trivial.",
    "The BREAKING CHANGE: footer must explain the compatibility impact, required migration, changed contract, removed tolerance, new required metadata, or changed automation expectation in concrete reader-facing terms.",
    "Infer the BREAKING CHANGE: footer from everything provided: file paths, exported names, validation rules, CLI flags, config keys, API shapes, tests, removed behavior, renamed behavior, and downstream automation that would fail after upgrade.",
    "Write the BREAKING CHANGE: footer for the release-note reader: name who is affected, what no longer works, and what they must change before upgrading.",
    "Use exact identifiers in the BREAKING CHANGE: footer when they are present in the diff: CLI flags, option/property names, config keys, exported functions, footer tokens, command names, and validation error surfaces should appear exactly as downstream users see them.",
    "For CLI or library changes, explicitly identify whether scripts, generated commit messages, manually supplied messages, config files, public exports, or CI/release automation must be updated.",
    "For validation changes, explicitly name the old input that used to pass, the new required input shape, and the practical migration step.",
    "Do not build the BREAKING CHANGE: footer by restating the subject or copying the first body bullet; synthesize the migration impact that semantic-release should publish.",
    "When adding a BREAKING CHANGE: footer, keep the bullet body first, insert a blank line, then write the footer as prose rather than another bullet.",
  ];
}

/** Returns the additional bias applied when the caller explicitly asks for --breaking sensitivity. */
export function breakingSensitivityModeRules(): string[] {
  return [
    "BREAKING SENSITIVITY MODE: the user passed --breaking, so inspect public contracts more aggressively and prefer explicit breaking metadata when the selected files plausibly require migration.",
    "In breaking sensitivity mode, scrutinize CLI flags, config parsing, validation rules, package exports, output formats, cache or automation contracts, and documented workflows for consumer migration impact instead of treating behavior changes as internal by default.",
    "Do not let sensitivity mode become forced-major mode: style, test, docs, chore, ci, formatting, README-only, prompt-only, and internal cleanup commits stay non-breaking unless their own diff changes a supported public contract.",
  ];
}

/**
 * Returns the universal commit-message authoring rules shared by prompt builders
 * that ask the model to write or rewrite a commit message.
 */
export function commitMessageAuthoringRules(
  options: CommitMessageRuleOptions = {},
): string[] {
  const cfg = loadConfig();
  const breakingMode = resolveBreakingChangeMode(options);
  const parts: string[] = [];
  if (cfg.commit.conventional) {
    parts.push(
      ...conventionalCommitFormatRules(),
      ...releaseImpactAuthoringRules(breakingMode),
    );
  }
  if (cfg.commit.includeScope) {
    parts.push(
      "Include a scope in parentheses reflecting the affected module/area.",
      ...conventionalCommitScopeRules(),
    );
  }
  parts.push(
    `Subject line MUST be <= ${formatScalar(cfg.commit.maxSubjectLength)} characters.`,
    `Language: ${cfg.commit.language}.`,
  );
  parts.push(
    "Write as if an involved, thoughtful senior engineer is committing premium change by hand.",
    "Center the message on why the change is being made; heavily infer the motivating bug, safeguard, product behavior, maintenance goal, or workflow need from the diff whenever it is implied.",
    "Lead with the reason, outcome, or defended behavior the commit introduces, not a flat description of edited files or implementation steps.",
    "Infer the actual subsystem, workflow, or product surface from the file paths, scopes, symbols, and diff content, and name that directly.",
    "Heavily infer from the content to surface the intent a human reviewer would care about, even when the diff mostly shows mechanics.",
    "When one commit covers a broad but cohesive rollout, the subject should name the umbrella outcome or area, not enumerate every mechanism changed.",
    "When one concrete guardrail, heuristic, validation, retry path, cache behavior, or signaling rule dominates the diff, name that dominant mechanism directly in the subject instead of falling back to vague umbrella nouns.",
    "When the diff mostly changes prompt, instruction, or guidance text, name the concrete rule introduced, banned, or clarified in the subject instead of meta wording.",
    "Treat source files that define prompts, heuristics, validators, planner logic, or other runtime behavior as code, not documentation, even when the diff mostly edits prose, examples, JSDoc, or TSDoc inside those files.",
    "Reserve docs for actual documentation artifacts such as README, markdown, or dedicated docs content, not runtime source modules that happen to contain instructional text.",
    "When runtime prompt or planner source changes a rule, safeguard, or decision, avoid meta verbs if the concrete rule being changed can be named directly.",
    "Avoid generic umbrella nouns like flow, pipeline, logic, handling, support, or behavior when the diff supports a more specific mechanism, safeguard, or decision point.",
    "Avoid comma-separated or and-linked subject lists that read like a changelog headline; move secondary details into body bullets.",
    "After the subject, add a blank line then a concise body using bullet points to summarize key changes.",
    "Prefer 2-4 bullets that capture the most important behavioral, architectural, or validation details.",
    "Use the body to justify the subject with impact, constraints, guarantees, or verification details; do not just restate the same wording.",
    "Each bullet should add concrete information beyond the subject; avoid filler, hype, and repetition.",
    "Prefer precise technical verbs and nouns over generic phrases like update, improve, changes, or stuff when the diff supports something more specific.",
    "Badly generic subjects like feat: update tests, chore: improve code, or refactor: tweak prompts are invalid when the diff supports a more exact area.",
    `Wrap body lines at ${formatScalar(cfg.commit.maxBodyLineLength)} characters.`,
    "A subject-only commit message is invalid.",
  );
  parts.push(
    "Do NOT include markdown formatting, code fences, or quotation marks around the message.",
  );
  return parts;
}

/** Returns the compact Conventional Commits prefix and type-selection rules. */
export function conventionalCommitFormatRules(): string[] {
  return [
    "Use the Conventional Commits format: <type>(<scope>): <description>",
    "Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert.",
    "Choose the most specific type that applies.",
    ...conventionalCommitTypeRules(),
  ];
}

/** Returns shared scope wording for prompts that author Conventional Commit subjects. */
export function conventionalCommitScopeRules(): string[] {
  return [
    "The scope must be a short, single-word or hyphenated identifier (e.g. auth, commit-planning, grouping) — NEVER a file path, directory path, or slash-separated string.",
    "Do not use slashes, dots, or nested path segments in the scope under any circumstances.",
  ];
}

/** Returns the shared Conventional Commit type-selection rules for authored messages. */
export function conventionalCommitTypeRules(): string[] {
  return [
    "Choose the commit type from the externally observable reason for the change, not from the dominant file kind, edit mechanism, or amount of code movement.",
    "Use fix for any change that corrects wrong behavior, misleading output, bad classification, unsafe defaults, broken safeguards, missed validation, incorrect prompts, or user-visible/operator-visible decisions, even when the patch mostly renames internals, rewrites tests, or updates prompt text.",
    "Use feat only when the commit primarily adds a new user-facing capability, workflow, configuration option, command behavior, supported API, or documented integration point.",
    "Use refactor only when runtime behavior, generated output, validation results, release impact, and user/operator workflows are intentionally unchanged; do not use refactor for commits that stop forcing output, change planning decisions, alter prompt semantics, or modify cache identity in a way users can observe.",
    "Use docs only for documentation artifacts such as README, markdown, guides, or dedicated docs content; source files that contain prompts, validators, heuristics, or runtime instructional text are code and should use fix, feat, refactor, or test according to behavior.",
    "Use test when the commit only adds or changes test coverage, fixtures, assertions, or test scaffolding and does not change production behavior.",
    "Use style only for formatting, whitespace, import ordering, or lint-only edits that do not change behavior, tests, public contracts, or generated output.",
    "Use chore for repository maintenance that is not production behavior, tests, docs, style, build, ci, performance, or release behavior.",
    "Use build for package manager, dependency, bundling, compilation, or release build pipeline changes; use ci for CI workflow automation changes; use perf only when the primary user-observable outcome is performance.",
    "When a commit contains both behavior and supporting tests/docs/formatting, choose the behavior type and describe support work in body bullets rather than downgrading the subject to test, docs, style, chore, or refactor.",
    "When in doubt between fix and refactor, choose fix if any generated commit message, plan grouping, CLI output, validation result, cache behavior, or operator decision can change.",
  ];
}

/** Returns release-impact authoring rules for a normal commit-message prompt. */
export function releaseImpactAuthoringRules(
  breakingMode: BreakingChangeMode,
): string[] {
  if (breakingMode === "disabled") {
    return releaseImpactMetadataDisabledRules();
  }

  const rules = [
    "For changes that truly break a supported public compatibility contract, append ! after the type/scope prefix and include a BREAKING CHANGE: footer after the body.",
    ...releaseImpactCompatibilityRules(),
    "Treat breaking-change markers as rare release-impact signals: semantic-release interprets any commit with ! or a BREAKING CHANGE: footer as a major-version trigger for the release batch.",
    ...breakingChangeFooterRules(),
    "Do not use ! unless the footer can name the actual breakage and what downstream users or automation must change.",
  ];

  if (breakingMode !== "sensitive") {
    return rules;
  }

  return [
    ...rules,
    ...breakingSensitivityModeRules(),
    "In breaking sensitivity mode, use ! and write a BREAKING CHANGE: footer for commits whose own selected files require downstream consumers or automation to migrate before upgrading.",
  ];
}

/** Returns the release-impact threshold for authoring breaking Conventional Commits. */
export function releaseImpactCompatibilityRules(): string[] {
  return [
    "Classify release impact by supported public contract, not by every behavior change: mark breaking only when a documented or reasonably relied-on CLI flag behavior, config schema, package export, validation contract, output shape, persisted automation format, or release/CI integration now requires downstream migration.",
    "Do not mark accidental, internal, prompt-only, test-only, formatting-only, or refactor-only implementation behavior as breaking unless the diff deliberately changes a supported user or automation contract.",
    "If the diff fixes a flag, prompt, validator, or planner rule so it matches its intended meaning, prefer a non-breaking fix unless the old behavior was documented or clearly depended on by downstream automation.",
  ];
}

/** Returns instructions for runs where release-impact metadata must not appear. */
export function releaseImpactMetadataDisabledRules(): string[] {
  return [
    "Release-impact metadata is disabled for this run; write ordinary commit messages only.",
    "Do not use release-triggering subject markers or release-triggering footers, even if the diff changes a public compatibility contract.",
    "Describe compatibility-sensitive details as normal implementation or behavior notes, without upgrade-note language or release automation metadata.",
    "Avoid phrases like breaking change, major version, or must migrate unless they are exact code identifiers, CLI flags, option names, or file paths from the diff.",
  ];
}

export function resolveBreakingChangeMode(
  options: CommitMessageRuleOptions = {},
): BreakingChangeMode {
  return options.breakingMode ?? "normal";
}
