/** Grouping system and user prompt builders. */
import { formatScalar } from "../../../commit-messages/formatting.js";
import {
  buildFileAliases,
  formatPromptDiff,
  getFileAlias,
} from "../context/diff-context.js";
import { commitMessageAuthoringRules } from "../rules/commit/index.js";
import {
  hunkGroupingBatchContextRules,
  hunkGroupingBreakingAuthoringRules,
  hunkGroupingOutputRules,
  hunkGroupingSystemRules,
} from "../rules/index.js";

/** Context injected into the grouping user prompt when batching is active. */
export interface GroupingPromptContext {
  allFiles?: FileDiff[];
  batchCount?: number;
  batchIndex?: number;
  breakingMode?: import("../rules/commit/index.js").BreakingChangeMode;
  deferFinalization?: boolean;
}

type FileDiff = import("../../../git/diff.js").FileDiff;

/** Returns the system prompt for the AI grouping step. */
export function buildGroupingSystemPrompt(
  context?: GroupingPromptContext,
): string {
  const parts = [
    ...hunkGroupingSystemRules(),
    "For each commit, write a message following these rules:",
    ...commitMessageAuthoringRules({ breakingMode: context?.breakingMode }),
    "",
    ...hunkGroupingOutputRules(),
  ];
  return parts.join("\n");
}

/** Returns the user prompt for the AI grouping step with diff content. */
export function buildGroupingUserPrompt(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
  context?: GroupingPromptContext,
): string {
  const allFiles = context?.allFiles ?? files;
  const fileAliases = buildFileAliases(files);

  const parts: string[] = [
    `Analyzing ${formatScalar(files.length)} changed file(s). Organize into logical, atomic commits.`,
    ...hunkGroupingBreakingAuthoringRules(context),
    ...hunkGroupingBatchContextRules(allFiles, files.length, context),
    ...buildFileLegendSection(files, fileAliases),
    ...buildHunkReferenceMapSection(files, fileAliases),
    ...buildFullDiffSection(files, fileAliases, formatFileDiff),
  ];
  return parts.join("\n");
}

function buildFileLegendSection(
  files: FileDiff[],
  fileAliases: ReturnType<typeof buildFileAliases>,
): string[] {
  return [
    "",
    "File legend:",
    ...files.map(
      (file) => `  ${getFileAlias(fileAliases, file.path)} = ${file.path}`,
    ),
  ];
}

function buildFullDiffSection(
  files: FileDiff[],
  fileAliases: ReturnType<typeof buildFileAliases>,
  formatFileDiff: (f: FileDiff) => string,
): string[] {
  return [
    "",
    "FULL DIFFS — each hunk is labeled [Hunk N] matching the reference map above:",
    "",
    ...files.flatMap((file) => [
      `=== ${getFileAlias(fileAliases, file.path)} ===`,
      formatPromptDiff(file, formatFileDiff),
      "",
    ]),
  ];
}

function buildHunkReferenceLines(
  file: FileDiff,
  fileAliases: ReturnType<typeof buildFileAliases>,
): string[] {
  const fileAlias = getFileAlias(fileAliases, file.path);
  if (file.hunks.length === 0) {
    return [`  ${fileAlias}: (no hunks — file-level change only)`];
  }

  return [
    `  ${fileAlias}:`,
    ...file.hunks.map(
      (hunk, index) => `    [Hunk ${formatScalar(index)}] ${hunk.header}`,
    ),
  ];
}

function buildHunkReferenceMapSection(
  files: FileDiff[],
  fileAliases: ReturnType<typeof buildFileAliases>,
): string[] {
  return [
    "",
    "HUNK REFERENCE MAP (use this to identify linked hunks across files):",
    ...files.flatMap((file) => buildHunkReferenceLines(file, fileAliases)),
  ];
}
