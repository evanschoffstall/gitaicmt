/** Consolidation system and user prompt builders. */
import { formatScalar } from "../../../commit-messages/formatting.js";
import {
  buildConsolidationPreviewLines,
  buildFileAliases,
  getFileAlias,
  getRepeatedPlanPaths,
  shouldIncludeConsolidationPreview,
} from "../context/diff-context.js";
import { type CommitMessageRuleOptions } from "../rules/commit/index.js";
import {
  planConsolidationBreakingRules,
  planConsolidationIntroRules,
  planConsolidationSystemRules,
} from "../rules/index.js";

type FileDiff = import("../../../git/diff.js").FileDiff;
type PlannedCommit = import("../../types.js").PlannedCommit;

/** Returns the system prompt for the AI consolidation pass. */
export function buildConsolidationSystemPrompt(
  options: CommitMessageRuleOptions = {},
): string {
  return planConsolidationSystemRules(options).join("\n");
}

/** Returns the user prompt for the AI consolidation pass. */
export function buildConsolidationUserPrompt(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
  options: CommitMessageRuleOptions = {},
): string {
  const fileByPath = new Map(allFiles.map((file) => [file.path, file]));
  const fileAliases = buildFileAliases(allFiles);
  const parts = [
    ...planConsolidationIntroRules(allFiles, groups.length),
    ...planConsolidationBreakingRules(options),
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
    ...group.files.map((file) =>
      formatConsolidationCommitFile(file, fileAliases),
    ),
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

function formatConsolidationCommitFile(
  file: PlannedCommit["files"][number],
  fileAliases: ReturnType<typeof buildFileAliases>,
): string {
  return file.hunks && file.hunks.length > 0
    ? `- ${getFileAlias(fileAliases, file.path)} [hunks ${file.hunks.join(", ")}]`
    : `- ${getFileAlias(fileAliases, file.path)} [all hunks]`;
}
