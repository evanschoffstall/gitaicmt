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
    "Bias toward the fewest commits that still preserve genuinely independent changes.",
    "- You MAY merge any commits, including non-adjacent ones, when they clearly belong together.",
    "- You MUST NOT split commits.",
    "- You MUST NOT drop, duplicate, or invent files/hunks.",
    "- You MUST keep separate commits separate when they represent different reasons for change, even if they sit in the same subsystem or rollout.",
    "- If you cannot justify the merged result with one clear why-oriented sentence, do not merge those commits.",
    "- If the best merged subject naturally wants to say X and Y as two separate reasons, keep those commits separate.",
    "- Absorb narrow style, import-order, formatting, rename-only, docs, test, config, and helper-script follow-up commits into the neighboring owning feature/refactor when they exist to support that same rollout.",
    "- A new helper, parser, utility, or shared abstraction should stay separate when later commits build on it as a distinct enabling step; only merge it when it has no meaningful standalone why beyond the owning change.",
    "- When merging a support commit into an implementation commit, keep the implementation or workflow subject and move support details into body bullets.",
    "- Standalone style/import-order/formatting commits should be rare and kept only when they are broad independent sweeps across otherwise unrelated files.",
    "- Collapse ALL style, import-order, formatting, and whitespace-only sweep commits into as few commits as possible regardless of their position in the plan. Multiple style-sweep commits should reduce to 1-2 commits maximum.",
    "- If two commits modify different hunks of the SAME file, merge them into one commit unless they are clearly independent features.",
    "- Consolidate tooling/workflow/config sweeps when they are one cohesive rollout.",
    "- Consolidate package.json, config files, helper scripts, docs, and tests into the same commit when they enable, describe, or verify the same feature or workflow.",
    "- When one merged commit covers a broad rollout, write an umbrella subject that names the rollout or affected area.",
    "- Do NOT cram multiple implementation details into the subject with comma-separated lists; move those details into body bullets.",
    "- When no merge is warranted, return the plan unchanged.",
    "Output raw JSON only.",
    'Return an array of commit objects: [{"files":[{"path":"file.ts","hunks":[0]}],"message":"..."}]',
  ].join("\n");
}

/** Returns the user prompt for the AI consolidation pass. */
export function buildConsolidationUserPrompt(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
): string {
  const fileByPath = new Map(allFiles.map((file) => [file.path, file]));
  const fileAliases = buildFileAliases(allFiles);
  const repeatedPaths = getRepeatedPlanPaths(groups);
  const parts = [
    `Review ${formatScalar(groups.length)} planned commit(s) covering ${formatScalar(allFiles.length)} changed file(s).`,
    "Merge any commits that clearly belong to the same overarching change, including non-adjacent ones.",
    "Prefer the minimum commit count that still keeps truly independent work separate.",
    "Keep separate whys separate: do not merge two commits unless the combined result still reads like one reason for change.",
    "If the combined commit would need an and-subject to explain itself cleanly, keep it split.",
    "Absorb narrow cleanup-only, import-order, docs, test, config, and helper-script commits into the neighboring owning change when they are part of the same rollout.",
    "If one commit introduces a helper/parser/utility and another commit applies it elsewhere, keep them separate unless the helper has no independent value.",
    "Collapse ALL style/import-order/formatting sweep commits across the plan into 1-2 commits maximum, regardless of their position.",
    "Preserve buildable order when related commits stay separate: enabling helpers should come before dependent refactors or features.",
    "If multiple commits modify different hunks of the SAME file, merge them unless they cover clearly independent features.",
    "Return the fully consolidated plan, not just a single merge step.",
    "",
    "File legend:",
    ...allFiles.map(
      (file) => `${getFileAlias(fileAliases, file.path)} = ${file.path}`,
    ),
    "",
    "Changed files:",
    ...allFiles.map((file) => {
      const hunkDescriptor =
        file.hunks.length === 0
          ? "file-level change"
          : `${formatScalar(file.hunks.length)} hunk(s)`;
      return `- ${getFileAlias(fileAliases, file.path)} (${hunkDescriptor})`;
    }),
    "",
    "Proposed commits:",
  ];

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    parts.push(`Commit ${formatScalar(index + 1)}:`);
    parts.push(`Message: ${group.message}`);
    parts.push("Files:");
    for (const file of group.files) {
      if (file.hunks && file.hunks.length > 0) {
        parts.push(
          `- ${getFileAlias(fileAliases, file.path)} [hunks ${file.hunks.join(", ")}]`,
        );
      } else {
        parts.push(`- ${getFileAlias(fileAliases, file.path)} [all hunks]`);
      }
    }
    if (shouldIncludeConsolidationPreview(group, repeatedPaths)) {
      parts.push("Selected diff preview:");
      parts.push(
        ...buildConsolidationPreviewLines(group, fileByPath, fileAliases),
      );
    } else {
      parts.push("Selected diff preview: omitted for low-ambiguity commit.");
    }
    parts.push("");
  }

  parts.push(
    "Return the final commit plan as JSON using the same file/hunk coverage with every warranted merge already applied.",
  );
  return parts.join("\n");
}
