import {
  breakingChangeFooterRules,
  breakingSensitivityModeRules,
  type CommitMessageRuleOptions,
  conventionalCommitScopeRules,
  conventionalCommitTypeRules,
  releaseImpactCompatibilityRules,
  releaseImpactMetadataDisabledRules,
  resolveBreakingChangeMode,
} from "./message.js";

/** Returns the rules for merging partial commit messages into one message. */
export function partialCommitMergeRules(
  options: CommitMessageRuleOptions = {},
): string[] {
  const breakingMode = resolveBreakingChangeMode(options);
  return [
    "Preserve or reconstruct the strongest why-oriented rationale from the partials so the final message explains why the change exists, not just what files moved.",
    "If the reason is only implicit, infer it from the concrete behavior, safeguard, workflow, or product outcome described across the partials.",
    "Prefer a subject that names the motivation or outcome the commit delivers; keep raw implementation inventory in body bullets.",
    "Preserve the most concrete subsystem or workflow nouns from the strongest partial message instead of collapsing to generic wording.",
    "When one guardrail, heuristic, validation path, retry path, cache behavior, or signaling rule is the real center of gravity, name that mechanism directly instead of broad umbrella nouns like flow or pipeline.",
    "When the partials mostly change prompt or instruction wording, name the concrete guidance being added or clarified instead of meta wording.",
    "Treat source modules that define prompts, heuristics, validators, planner logic, or other runtime behavior as code changes, not docs changes, even when their edits are mostly prose or inline documentation.",
    "When runtime prompt or planner source changes a concrete rule, safeguard, or decision, avoid meta verbs if the specific rule can be named directly.",
    "If the partials mainly describe correcting misleading planner behavior, wrong decisions, or bad diagnostics, preserve that corrective framing and prefer fix over feat.",
    "If the combined change is one cohesive rollout, name that rollout in the subject instead of listing every mechanism touched.",
    "For the merged subject type, apply these Conventional Commit type-selection rules:",
    ...conventionalCommitTypeRules(),
    ...conventionalCommitScopeRules(),
    ...partialCommitMergeBreakingRules(breakingMode),
    "Do not write a comma-separated subject that enumerates three or more implementation details; put detail inventory in body bullets.",
    "Combine these into one professional Conventional Commit that reads like a careful human wrote it.",
  ];
}

function partialCommitMergeBreakingRules(
  breakingMode: ReturnType<typeof resolveBreakingChangeMode>,
): string[] {
  if (breakingMode === "disabled") {
    return [
      ...releaseImpactMetadataDisabledRules(),
      "If partial messages include release-triggering metadata or upgrade-note wording, rewrite the merged result as an ordinary commit message while preserving the concrete behavior change in body bullets.",
    ];
  }

  const rules = [
    "If any partial message already has a ! subject or BREAKING CHANGE: footer, preserve real breaking metadata in the merged message and keep the footer complete.",
    "If the merged commit truly changes a supported public compatibility contract, use ! and write a BREAKING CHANGE: footer even when --breaking was not passed.",
    ...releaseImpactCompatibilityRules(),
    ...breakingChangeFooterRules(),
  ];

  if (breakingMode !== "sensitive") {
    return rules;
  }

  return [
    ...rules,
    "Breaking sensitivity mode is enabled because the user explicitly passed --breaking: if the merged commit plausibly changes a supported public compatibility contract, keep ! on the subject and write a BREAKING CHANGE: footer as a 2-4 sentence migration paragraph.",
    ...breakingSensitivityModeRules(),
    "Do not mark the merged commit breaking merely because the run raises breaking sensitivity; semantic-release will treat that as a major-version signal.",
    "The merged BREAKING CHANGE: footer must synthesize the downstream obligation across all partials instead of copying one partial bullet or restating the subject.",
  ];
}
