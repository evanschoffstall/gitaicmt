/** Consolidation system and user prompt builders. */
import { formatScalar } from "../../commit-messages/formatting.js";
import {
  buildConsolidationPreviewLines,
  buildFileAliases,
  getFileAlias,
  getRepeatedPlanPaths,
  shouldIncludeConsolidationPreview,
} from "./file-context.js";

type FileDiff = import("../../git/diff.js").FileDiff;
type PlannedCommit = import("../types.js").PlannedCommit;

/** Returns the system prompt for the AI consolidation pass. */
export function buildConsolidationSystemPrompt(): string {
  return [
    "You are reviewing an AI-generated commit plan and deciding which commits should be merged.",
    "Reduce fragmentation by merging commits that are clearly part of the same overarching change.",
    "Keep merging until no meaningful merge opportunity remains.",
    "Reduce fragmentation, but preserve distinct implementation whys even when that costs one extra commit.",
    "- You MAY merge any commits, including non-adjacent ones, when they clearly belong together.",
    "- You MUST NOT split commits.",
    "- You MUST NOT drop, duplicate, or invent files/hunks.",
    "- You MUST keep separate commits separate when they represent different reasons for change, even if they sit in the same subsystem or rollout.",
    "- If you cannot justify the merged result with one clear why-oriented sentence, do not merge those commits.",
    "- If the best merged subject naturally wants to say X and Y as two separate reasons, keep those commits separate.",
    "- Do NOT merge multiple implementation commits into one umbrella commit just because they touch the same subsystem, rollout, or planner stage.",
    "- Absorb narrow style, import-order, formatting, rename-only, docs, test, config, and helper-script follow-up commits into the neighboring owning feature/refactor when they exist to support that same rollout.",
    "- Prefer support-into-owner merges over owner-to-owner umbrella merges; tests, docs, config, and cleanup should collapse into the implementation they support, not into broad multi-reason rollups.",
    "- A new helper, parser, utility, or shared abstraction should stay separate when later commits build on it as a distinct enabling step; only merge it when it has no meaningful standalone why beyond the owning change.",
    "- When merging a support commit into an implementation commit, keep the implementation or workflow subject and move support details into body bullets.",
    "- If a merged plan would likely need to be split back into mostly the same commits to explain ownership clearly, keep those commits separate now.",
    "- Every returned message MUST be a full commit message: subject line, blank line, then one or more body bullet lines.",
    "- Standalone style/import-order/formatting commits should be rare and kept only when they are broad independent sweeps across otherwise unrelated files.",
    "- Collapse ALL style, import-order, formatting, and whitespace-only sweep commits into as few commits as possible regardless of their position in the plan. Multiple style-sweep commits should reduce to 1-2 commits maximum.",
    "- If two commits modify different hunks of the SAME file, treat that as a merge cue only when the result still reads as one clear reason for change; keep them separate when the hunks support independent features or workflows.",
    "- Consolidate tooling/workflow/config sweeps when they are one cohesive rollout.",
    "- Consolidate package.json, config files, helper scripts, docs, and tests into the same commit when they enable, describe, or verify the same feature or workflow.",
    "- When one merged commit covers a broad rollout, write an umbrella subject that names the rollout or affected area.",
    "- Do NOT cram multiple implementation details into the subject with comma-separated lists; move those details into body bullets.",
    "- In every returned file entry, path MUST be the repository file path only; never return alias labels like F2 or prefixed forms like F2: package.json.",
    "- When a commit owns all hunks of a file, omit the hunks field entirely; never use \"all\" as a hunks value.",
    "- When no merge is warranted, return the plan unchanged.",
    "Output raw JSON only.",
    'Return an array of commit objects: [{"files":[{"path":"file.ts","hunks":[0]}],"message":"type(scope): subject\\n\\n- Body bullet"}]',
  ].join("\n");
}

/** Returns the user prompt for the AI consolidation pass. */
export function buildConsolidationUserPrompt(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
): string {
  const fileByPath = new Map(allFiles.map((file) => [file.path, file]));
  const fileAliases = buildFileAliases(allFiles);
  const parts = [
    ...buildConsolidationPromptIntro(allFiles, groups.length),
    ...buildConsolidationLegend(allFiles, fileAliases),
    ...buildChangedFileLines(allFiles, fileAliases),
    "",
    "Proposed commits:",
  ];
  const repeatedPaths = getRepeatedPlanPaths(groups);

  for (let index = 0; index < groups.length; index++) {
    parts.push(
      ...buildConsolidationCommitSection(
        groups[index],
        index,
        repeatedPaths,
        fileByPath,
        fileAliases,
      ),
    );
  }

  parts.push(
    "Return the final commit plan as JSON using the same file/hunk coverage with every warranted merge already applied.",
  );
  return parts.join("\n");
}

function buildChangedFileLines(
  allFiles: FileDiff[],
  fileAliases: ReturnType<typeof buildFileAliases>,
): string[] {
  return [
    "",
    "Changed files:",
    ...allFiles.map((file) => {
      const hunkDescriptor =
        file.hunks.length === 0
          ? "file-level change"
          : `${formatScalar(file.hunks.length)} hunk(s)`;
      return `- ${getFileAlias(fileAliases, file.path)} (${hunkDescriptor})`;
    }),
  ];
}

function buildConsolidationCommitSection(
  group: PlannedCommit,
  index: number,
  repeatedPaths: Set<string>,
  fileByPath: Map<string, FileDiff>,
  fileAliases: ReturnType<typeof buildFileAliases>,
): string[] {
  return [
    `Commit ${formatScalar(index + 1)}:`,
    `Message: ${group.message}`,
    "Files:",
    ...group.files.map((file) => formatConsolidationCommitFile(file, fileAliases)),
    ...buildConsolidationPreviewSection(
      group,
      repeatedPaths,
      fileByPath,
      fileAliases,
    ),
    "",
  ];
}

function buildConsolidationLegend(
  allFiles: FileDiff[],
  fileAliases: ReturnType<typeof buildFileAliases>,
): string[] {
  return [
    "",
    "File legend:",
    ...allFiles.map(
      (file) => `${getFileAlias(fileAliases, file.path)} = ${file.path}`,
    ),
  ];
}

function buildConsolidationPreviewSection(
  group: PlannedCommit,
  repeatedPaths: Set<string>,
  fileByPath: Map<string, FileDiff>,
  fileAliases: ReturnType<typeof buildFileAliases>,
): string[] {
  if (!shouldIncludeConsolidationPreview(group, repeatedPaths)) {
    return ["Selected diff preview: omitted for low-ambiguity commit."];
  }

  return [
    "Selected diff preview:",
    ...buildConsolidationPreviewLines(group, fileByPath, fileAliases),
  ];
}

function buildConsolidationPromptIntro(
  allFiles: FileDiff[],
  groupCount: number,
): string[] {
  return [
    `Review ${formatScalar(groupCount)} planned commit(s) covering ${formatScalar(allFiles.length)} changed file(s).`,
    "Merge any commits that clearly belong to the same overarching change, including non-adjacent ones.",
    "Prefer fewer commits only when the merged result still preserves distinct implementation whys.",
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

function formatConsolidationCommitFile(
  file: PlannedCommit["files"][number],
  fileAliases: ReturnType<typeof buildFileAliases>,
): string {
  return file.hunks && file.hunks.length > 0
    ? `- ${getFileAlias(fileAliases, file.path)} [hunks ${file.hunks.join(", ")}]`
    : `- ${getFileAlias(fileAliases, file.path)} [all hunks]`;
}
