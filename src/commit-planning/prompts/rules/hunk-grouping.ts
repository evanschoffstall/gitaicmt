import { formatScalar } from "../../../commit-messages/formatting.js";
import { summarizeFileAreas } from "../context/diff-context.js";
import {
  type BreakingChangeMode,
  breakingSensitivityModeRules,
  releaseImpactCompatibilityRules,
  releaseImpactMetadataDisabledRules,
  resolveBreakingChangeMode,
} from "./commit/index.js";

export interface HunkGroupingRuleContext {
  allFiles?: FileDiff[];
  batchCount?: number;
  batchIndex?: number;
  breakingMode?: BreakingChangeMode;
  deferFinalization?: boolean;
}

type FileDiff = import("../../../git/diff.js").FileDiff;

/** Returns whole-changeset context rules for batched hunk-grouping prompts. */
export function hunkGroupingBatchContextRules(
  allFiles: FileDiff[],
  batchFileCount: number,
  context?: HunkGroupingRuleContext,
): string[] {
  if (allFiles.length === batchFileCount && (context?.batchCount ?? 1) <= 1) {
    return [];
  }

  const batchNumber = (context?.batchIndex ?? 0) + 1;
  const batchCount = context?.batchCount ?? 1;
  return [
    "",
    "Overall changeset context:",
    `  This prompt covers batch ${formatScalar(batchNumber)} of ${formatScalar(batchCount)} from an overall ${formatScalar(allFiles.length)}-file changeset.`,
    "  Plan commits for this batch with the whole changeset in mind.",
    "  Avoid creating narrow cleanup-only commits when the batch appears to be one part of a broader sweep across the overall file map.",
    "",
    "Overall file map:",
    ...summarizeFileAreas(allFiles),
  ];
}

/** Returns release-impact authoring rules for grouping user prompts. */
export function hunkGroupingBreakingAuthoringRules(
  context?: HunkGroupingRuleContext,
): string[] {
  const breakingMode = resolveBreakingChangeMode(context);
  if (breakingMode === "disabled") {
    return [
      "",
      ...releaseImpactMetadataDisabledRules().map((rule) => `  ${rule}`),
    ];
  }

  const rules = [
    "",
    "Breaking-change authoring is available when selected files truly require downstream consumers or automation to migrate before upgrading.",
    ...releaseImpactCompatibilityRules().map((rule) => `  ${rule}`),
    "  Use ! and an authored BREAKING CHANGE: footer when a commit's selected files require downstream consumers or automation to migrate before upgrading.",
    "  For commits that are genuinely breaking, infer the downstream migration from the diff, tests, docs, public exports, validation rules, CLI flags, and changed automation expectations.",
    "  Do not rely on later tooling to append the footer; when you choose breaking metadata, your JSON message should already contain the release-note-quality breaking-change text.",
  ];

  if (breakingMode !== "sensitive") {
    return rules;
  }

  return [
    ...rules,
    "  Breaking sensitivity mode is enabled for this run because the user explicitly passed --breaking.",
    ...breakingSensitivityModeRules().map((rule) => `  ${rule}`),
  ];
}

/** Returns the JSON response contract for grouped commit plans. */
export function hunkGroupingOutputRules(): string[] {
  return [
    "OUTPUT FORMAT — respond with ONLY valid JSON, an array of commit objects:",
    '  [{ "files": [{"path": "file.ts", "hunks": [0, 2]}, {"path": "other.ts"}], "message": "..." }, ...]',
    "",
    "File entry fields:",
    '  "path"  (required): the repository file path only. NEVER return alias labels like "F2" or prefixed forms like "F2: package.json".',
    '  "hunks" (optional): 0-based indices of which hunks to include. Omit only when ALL hunks in the file belong to this commit; never emit "all" as a string.',
    "",
    "FINAL CHECKLIST before outputting:",
    "  ✓ Every hunk appears in exactly one commit.",
    "  ✓ Linked hunks across different files are in the same commit with explicit hunks arrays.",
    "  ✓ Unrelated hunks in the same file are in different commits with explicit hunks arrays.",
    "  ✓ No file appears without a hunks array unless every hunk in it belongs to that commit.",
    "  ✓ Commits are ordered so dependencies come before dependents.",
    "Do NOT wrap the JSON in code fences. Output raw JSON only.",
  ];
}

/** Returns the system rules for converting labeled diff hunks into atomic commits. */
export function hunkGroupingSystemRules(): string[] {
  return [
    "You are an expert at analyzing git diffs and organizing them into logical, atomic commits.",
    "Given a set of file diffs with labeled hunks, your job is to group hunks into commits where each commit represents ONE coherent, complete change.",
    "STEP 1 — READ THE HUNK REFERENCE MAP FIRST.",
    "Before reading diff bodies, scan the HUNK REFERENCE MAP and ask whether each hunk is the cause or effect of another hunk.",
    "If yes, those hunks MUST go into the same commit.",
    "STEP 2 — WIRE LINKED HUNKS ACROSS FILES. THIS IS NOT OPTIONAL.",
    "When a hunk in one file is functionally linked to a hunk in another file, place both hunks in the SAME commit even if the files also contain unrelated hunks.",
    "Linked means one hunk defines, wires, migrates, configures, imports, tests, or validates behavior used by another hunk.",
    "In JSON, list EACH linked file with a hunks array whenever only some hunks from that file belong to the commit.",
    "WRONG — lumping an entire file when only one hunk is involved:",
    '    {"files": [{"path": "src/models.ts"}, {"path": "src/api.ts"}], ...}',
    "RIGHT — scalpel-precise hunk wiring:",
    '    {"files": [{"path": "src/models.ts", "hunks": [0]}, {"path": "src/api.ts", "hunks": [2]}], ...}',
    "  ANY COMBINATION IS VALID. A single commit may reference:",
    "    • hunk 0 from file A  +  hunk 2 from file B  +  hunk 1 from file C  +  all of file D",
    "    • hunk 3 from file A  +  hunk 0 from file E",
    "  There is NO restriction on which files or how many hunks appear in one commit.",
    "  The only rule: every hunk in the commit must be part of the same logical change.",
    "RULE 3 — Hunks in the SAME file that serve DIFFERENT purposes MUST be split.",
    "Reference them by index in different commits. But do NOT split out incidental formatting, import-order, rename-only, wiring, docs, test, or config hunks when they clearly support the same feature/refactor/fix.",
    "RULE 4 — Split into separate commits ONLY for genuinely independent changes:",
    "- Keep source, tests, docs, config, package changes, and helper scripts together when they ship one rollout.",
    "- Distinct features or bug fixes belong in different commits.",
    "- Standalone style/import-order/formatting commits should be RARE.",
    "- Do NOT atomize one rollout into separate source, config, docs, and test commits when those pieces only make sense together.",
    "RULE 5 — Every hunk must appear in exactly one commit. No duplicates, no omissions.",
    "EXAMPLE 1 — Whole-file grouping:",
    "  src/auth.ts, src/errors.ts, tests/auth.test.ts",
    '→ [{"files": [{"path": "src/auth.ts"}, {"path": "src/errors.ts"}, {"path": "tests/auth.test.ts"}],',
    '    "message": "feat(auth): add API key validation"}]',
    "EXAMPLE 2 — Intra-file split:",
    "  src/handler.ts: [Hunk 0] add retry logic, [Hunk 1] fix null response (unrelated), [Hunk 2] add retry counter",
    '→ [{"files": [{"path": "src/handler.ts", "hunks": [0, 2]}], "message": "feat: add retry logic"},',
    '   {"files": [{"path": "src/handler.ts", "hunks": [1]}], "message": "fix: handle null response"}]',
    "EXAMPLE 3 — Cross-file hunk wiring:",
    "  src/parser.ts: [Hunk 0] define ParseError type, [Hunk 1] unrelated whitespace fix",
    "  src/handler.ts: [Hunk 0] add import, [Hunk 1] throw ParseError (LINKED to parser.ts[0])",
    "  tests/parser.test.ts: [Hunk 0] test ParseError (LINKED to parser.ts[0])",
    '→ [{"files": [{"path": "src/parser.ts", "hunks": [0]},',
    '              {"path": "src/handler.ts", "hunks": [0, 1]},',
    '              {"path": "tests/parser.test.ts", "hunks": [0]}],',
    '    "message": "feat(parser): add ParseError type and integrate into handler"},',
    '   {"files": [{"path": "src/parser.ts", "hunks": [1]}], "message": "style(parser): clean up whitespace"}]',
    "EXAMPLE 4 — Cohesive tooling rollout:",
    "  eslint.config.js, knip.json, package.json, bun.lock, scripts/check.ts, scripts/check.json",
    '→ [{"files": [{"path": "eslint.config.js"}, {"path": "knip.json"}, {"path": "package.json"},',
    '             {"path": "bun.lock"}, {"path": "scripts/check.ts"}, {"path": "scripts/check.json"}],',
    '    "message": "chore(tooling): add lint and quality check workflow"}]',
  ];
}
