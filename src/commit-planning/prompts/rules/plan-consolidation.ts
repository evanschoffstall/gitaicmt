import { formatScalar } from "../../../commit-messages/formatting.js";
import {
  breakingChangeFooterRules,
  breakingSensitivityModeRules,
  type CommitMessageRuleOptions,
  conventionalCommitScopeRules,
  conventionalCommitTypeRules,
  releaseImpactCompatibilityRules,
  releaseImpactMetadataDisabledRules,
  resolveBreakingChangeMode,
} from "./commit/index.js";
import { prefixRules } from "./formatting.js";
import {
  sameFileMergeCueRules,
  semanticMergeBoundaryRules,
  styleSweepMergeRules,
  supportWorkMergeRules,
} from "./semantic-planning.js";

type FileDiff = import("../../../git/diff.js").FileDiff;

/** Returns release-impact consolidation rules for user prompts. */
export function planConsolidationBreakingRules(
  options: CommitMessageRuleOptions,
): string[] {
  const breakingMode = resolveBreakingChangeMode(options);
  if (breakingMode === "disabled") {
    return [
      "",
      ...releaseImpactMetadataDisabledRules().map((rule) => `  ${rule}`),
    ];
  }

  const rules = [
    "",
    "Breaking-change consolidation guidance:",
    ...releaseImpactCompatibilityRules().map((rule) => `  ${rule}`),
    "  Preserve authored BREAKING CHANGE: footers when they are good; improve them when a merge changes the consumer story.",
    "  If merging commits changes the affected consumer story, rewrite the BREAKING CHANGE: footer as 2-4 substantive release-note sentences that explain who must migrate and how.",
    "  Add ! only when the merged files truly change a public compatibility contract; semantic-release treats each breaking marker as a major-version signal.",
    "  If a returned commit has !, it must include a 2-4 sentence BREAKING CHANGE: footer that names affected consumers, exact identifiers, old behavior that no longer works, and required migration action.",
    "  Do not rely on downstream post-processing to synthesize or force the footer.",
  ];

  if (breakingMode !== "sensitive") {
    return rules;
  }

  return [
    ...rules,
    "  Breaking sensitivity consolidation is enabled because the user explicitly passed --breaking.",
    ...breakingSensitivityModeRules().map((rule) => `  ${rule}`),
  ];
}

/** Returns introductory consolidation rules for the user prompt. */
export function planConsolidationIntroRules(
  allFiles: FileDiff[],
  groupCount: number,
): string[] {
  return [
    `Review ${formatScalar(groupCount)} planned commit(s) covering ${formatScalar(allFiles.length)} changed file(s).`,
    "Merge any commits that clearly belong to the same overarching change, including non-adjacent ones.",
    "Prefer fewer commits only when the merged result still preserves distinct implementation whys.",
    ...semanticMergeBoundaryRules("commit"),
    "Keep separate whys separate: do not merge two commits unless the combined result still reads like one reason for change.",
    "If the combined commit would need an and-subject to explain itself cleanly, keep it split.",
    "Do not create umbrella implementation commits that only share a subsystem or rollout label; merge support follow-ups into their owning implementation instead.",
    "Absorb narrow cleanup-only, import-order, docs, test, config, and helper-script commits into the neighboring owning change when they are part of the same rollout.",
    "Prefer support-into-owner merges over merging multiple independent implementation commits together.",
    "If one commit introduces a helper/parser/utility and another commit applies it elsewhere, keep them separate unless the helper has no independent value.",
    "If the merged result would likely need to be split back into mostly the same commits for ownership clarity, keep it split now.",
    "Collapse ALL style/import-order/formatting sweep commits across the plan into 1-2 commits maximum, regardless of their position.",
    "Preserve buildable order when related commits stay separate: enabling helpers should come before dependent refactors or features.",
    "If multiple commits modify different hunks of the SAME file, use that as a merge cue only when they still represent one clear why; keep them split when the hunks serve clearly independent features or workflows.",
    "Every returned message must keep the full commit-message shape: subject line, blank line, then one or more body bullets.",
    "Return repository file paths only in JSON output; aliases from the legend are for reading only and must not appear in returned path fields.",
    'When all hunks of a file belong to a commit, omit the hunks field instead of returning "all".',
    "Return the fully consolidated plan, not just a single merge step.",
  ];
}

/** Returns the complete system-rule block for consolidation prompts. */
export function planConsolidationSystemRules(
  options: CommitMessageRuleOptions = {},
): string[] {
  const breakingMode = resolveBreakingChangeMode(options);
  return [
    "You are reviewing an AI-generated commit plan and deciding which commits should be merged.",
    "Reduce fragmentation by merging commits that are clearly part of the same overarching change.",
    "Keep merging until no meaningful merge opportunity remains.",
    ...semanticMergeBoundaryRules("commit"),
    "- You MAY merge any commits, including non-adjacent ones, when they clearly belong together.",
    "- You MUST NOT split commits.",
    "- You MUST NOT drop, duplicate, or invent files/hunks.",
    "- You MUST keep separate commits separate when they represent different reasons for change, even if they sit in the same subsystem or rollout.",
    "- If you cannot justify the merged result with one clear why-oriented sentence, do not merge those commits.",
    "- If the best merged subject naturally wants to say X and Y as two separate reasons, keep those commits separate.",
    "- Absorb narrow style, import-order, formatting, rename-only, docs, test, config, and helper-script follow-up commits into the neighboring owning feature/refactor when they exist to support that same rollout.",
    ...prefixRules(supportWorkMergeRules("commit"), "- "),
    "- A new helper, parser, utility, or shared abstraction should stay separate when later commits build on it as a distinct enabling step; only merge it when it has no meaningful standalone why beyond the owning change.",
    "- Every returned message MUST be a full commit message: subject line, blank line, then one or more body bullet lines.",
    "- When rewriting a subject during consolidation, apply these Conventional Commit type-selection rules:",
    ...conventionalCommitTypeRules().map((rule) => `- ${rule}`),
    ...prefixRules(conventionalCommitScopeRules(), "- "),
    ...planConsolidationBreakingSystemRules(breakingMode),
    ...prefixRules(styleSweepMergeRules("commit"), "- "),
    ...prefixRules(sameFileMergeCueRules("commit"), "- "),
    "- Consolidate tooling/workflow/config sweeps when they are one cohesive rollout.",
    "- Consolidate package.json, config files, helper scripts, docs, and tests into the same commit when they enable, describe, or verify the same feature or workflow.",
    "- When one merged commit covers a broad rollout, write an umbrella subject that names the rollout or affected area.",
    "- Do NOT cram multiple implementation details into the subject with comma-separated lists; move those details into body bullets.",
    "- In every returned file entry, path MUST be the repository file path only; never return alias labels like F2 or prefixed forms like F2: package.json.",
    '- When a commit owns all hunks of a file, omit the hunks field entirely; never use "all" as a hunks value.',
    "- When no merge is warranted, return the plan unchanged.",
    "Output raw JSON only.",
    'Return an array of commit objects: [{"files":[{"path":"file.ts","hunks":[0]}],"message":"type(scope): subject\\n\\n- Body bullet"}]',
  ];
}

function planConsolidationBreakingSystemRules(
  breakingMode: ReturnType<typeof resolveBreakingChangeMode>,
): string[] {
  if (breakingMode === "disabled") {
    return [
      ...releaseImpactMetadataDisabledRules().map((rule) => `- ${rule}`),
      "- If input commits include release-triggering metadata or upgrade-note wording, rewrite the consolidated result as an ordinary commit message while preserving the concrete behavior change in body bullets.",
    ];
  }

  const rules = [
    "- If any merged or unchanged commit has a ! subject or BREAKING CHANGE: footer, the returned message MUST preserve the ! marker and include a BREAKING CHANGE: footer.",
    "- If an input breaking footer is missing or weak, author a stronger one from all selected files, exact identifiers, body bullets, tests, docs, CLI flags, config keys, and public API changes.",
    "- When preserving a BREAKING CHANGE: footer during consolidation, improve it into a release-note-quality migration paragraph rather than shortening it; name affected consumers, the old input or workflow that no longer works, and the required upgrade action.",
    "- Do NOT replace a BREAKING CHANGE: footer with a copied body bullet or a subject restatement during consolidation.",
    "- NEVER return a ! subject with no footer; that is invalid output.",
    ...releaseImpactCompatibilityRules().map((rule) => `- ${rule}`),
    ...breakingChangeFooterRules().map((rule) => `- ${rule}`),
  ];

  if (breakingMode !== "sensitive") {
    return rules;
  }

  return [
    ...rules,
    "- BREAKING SENSITIVITY MODE is enabled for this consolidation pass because the user explicitly passed --breaking: preserve real breaking metadata, but do not introduce new ! markers unless the merged selected files change a supported public compatibility contract.",
    ...breakingSensitivityModeRules().map((rule) => `- ${rule}`),
  ];
}
