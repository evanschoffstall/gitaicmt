/**
 * File-context helpers shared across grouping, consolidation, and cluster
 * prompt builders: file aliases, area summaries, and diff preview lines.
 */
import { formatLabeledDiff, formatScalar } from "../../commit-messages/formatting.js";
import { parseConventionalSubject } from "../../commit-messages/subject-parser.js";

type FileDiff = import("../../git/diff.js").FileDiff;
type PlannedCommit = import("../types.js").PlannedCommit;
type PlannedCommitFile = import("../types.js").PlannedCommitFile;

const MAX_PREVIEW_FILES_PER_COMMIT = 2;
const MAX_PREVIEW_HUNKS_PER_FILE = 1;
const MAX_PREVIEW_LINES_PER_HUNK = 2;
const SUPPORT_COMMIT_TYPES = new Set(["chore", "docs", "style", "test"]);

/** Builds all preview lines for a planned commit's files in the consolidation user prompt. */
export function buildConsolidationPreviewLines(
  group: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
  fileAliases: Map<string, string>,
): string[] {
  const previewLines: string[] = [];
  const previewFiles = group.files.slice(0, MAX_PREVIEW_FILES_PER_COMMIT);

  for (const fileRef of previewFiles) {
    const file = fileByPath.get(fileRef.path);
    if (!file) {
      previewLines.push(
        `- ${getFileAlias(fileAliases, fileRef.path)}: missing file metadata`,
      );
      continue;
    }

    previewLines.push(...buildFilePreviewLines(file, fileRef, fileAliases));
  }

  const remainingFiles = group.files.length - previewFiles.length;
  if (remainingFiles > 0) {
    previewLines.push(
      `- ... ${formatScalar(remainingFiles)} more file(s) omitted from preview`,
    );
  }

  return previewLines;
}

/** Builds a short alias map (F1, F2, …) for a list of files. */
export function buildFileAliases(files: FileDiff[]): Map<string, string> {
  return new Map(
    files.map((file, index) => [file.path, `F${String(index + 1)}`]),
  );
}

/** Builds preview lines for one file in the consolidation user prompt. */
export function buildFilePreviewLines(
  file: FileDiff,
  fileRef: PlannedCommitFile,
  fileAliases: Map<string, string>,
): string[] {
  const lines: string[] = [`- ${getFileAlias(fileAliases, file.path)}:`];
  const selectedHunks = getSelectedPreviewHunks(file, fileRef);

  if (selectedHunks.length === 0) {
    const metadata = (file.metadataLines ?? []).slice(
      0,
      MAX_PREVIEW_LINES_PER_HUNK,
    );
    if (metadata.length === 0) {
      lines.push(`  ${file.status} file-level change`);
      return lines;
    }

    for (const metadataLine of metadata) {
      lines.push(`  ${metadataLine}`);
    }
    return lines;
  }

  for (const hunk of selectedHunks) {
    lines.push(`  ${hunk.header}`);
    for (const previewLine of getPreviewChangeLines(hunk.lines)) {
      lines.push(`    ${previewLine}`);
    }
  }

  const selectedCount = fileRef.hunks?.length ?? file.hunks.length;
  if (selectedCount > selectedHunks.length) {
    lines.push(
      `  ... ${formatScalar(selectedCount - selectedHunks.length)} more hunk(s) omitted`,
    );
  }

  return lines;
}

/**
 * Formats a FileDiff for prompt inclusion, stripping the redundant
 * `--- / +++` header lines that are already present in the HUNK REFERENCE MAP.
 */
export function formatPromptDiff(
  file: FileDiff,
  formatFileDiff: (f: FileDiff) => string,
): string {
  const labeled = formatLabeledDiff(file, formatFileDiff).split("\n");
  if (
    labeled.length >= 2 &&
    labeled[0]?.startsWith("--- ") &&
    labeled[1]?.startsWith("+++ ")
  ) {
    return labeled.slice(2).join("\n");
  }
  return labeled.join("\n");
}

/** Derives a two-segment area key from a file path. */
export function getAreaKey(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return "(root)";
  }
  if (segments.length === 2) {
    return segments[0];
  }
  return segments.slice(0, 2).join("/");
}

/** Looks up the alias for a path, falling back to the raw path. */
export function getFileAlias(
  fileAliases: Map<string, string>,
  path: string,
): string {
  const alias = fileAliases.get(path);
  return alias ?? path;
}

/** Returns the changed lines (+/-) from a hunk, capped at the preview limit. */
export function getPreviewChangeLines(lines: string[]): string[] {
  const changedLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---"),
  );

  if (changedLines.length > 0) {
    return changedLines.slice(0, MAX_PREVIEW_LINES_PER_HUNK);
  }

  return lines.slice(0, MAX_PREVIEW_LINES_PER_HUNK);
}

/** Returns the set of file paths that appear in more than one planned commit. */
export function getRepeatedPlanPaths(groups: PlannedCommit[]): Set<string> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const file of group.files) {
      counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
    }
  }

  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([path]) => path),
  );
}

/** Returns the hunks selected for preview from a file reference. */
export function getSelectedPreviewHunks(
  file: FileDiff,
  fileRef: PlannedCommitFile,
) {
  if (fileRef.hunks && fileRef.hunks.length > 0) {
    return fileRef.hunks
      .map((hunkIndex) => file.hunks[hunkIndex])
      .slice(0, MAX_PREVIEW_HUNKS_PER_FILE);
  }

  return file.hunks.slice(0, MAX_PREVIEW_HUNKS_PER_FILE);
}

/** Returns true when a subject line looks like a support-type commit (chore/docs/style/test). */
export function isSupportLikeSubject(subject: string): boolean {
  const parsed = parseConventionalSubject(subject.trim().toLowerCase());
  return parsed.type !== "" && SUPPORT_COMMIT_TYPES.has(parsed.type);
}

/** Returns up to 3 representative paths from a list (first, second, last). */
export function samplePaths(paths: string[]): string[] {
  if (paths.length <= 3) {
    return [...paths];
  }

  return [paths[0], paths[1], paths.at(-1) ?? paths[paths.length - 1]];
}

/** Returns true when a commit group should show a diff preview in the consolidation prompt. */
export function shouldIncludeConsolidationPreview(
  group: PlannedCommit,
  repeatedPaths: Set<string>,
): boolean {
  const subject = group.message.split("\n")[0] ?? "";
  return (
    group.files.some((file) => repeatedPaths.has(file.path)) ||
    group.files.some(
      (file) => Array.isArray(file.hunks) && file.hunks.length > 0,
    ) ||
    isSupportLikeSubject(subject)
  );
}

/** Builds a compact area-by-area summary string list for the overall file map. */
export function summarizeFileAreas(files: FileDiff[]): string[] {
  const pathsByArea = new Map<string, string[]>();

  for (const file of files) {
    const area = getAreaKey(file.path);
    const paths = pathsByArea.get(area);
    if (paths) {
      paths.push(file.path);
    } else {
      pathsByArea.set(area, [file.path]);
    }
  }

  const entries = [...pathsByArea.entries()].sort((left, right) => {
    if (left[1].length === right[1].length) {
      return left[0].localeCompare(right[0]);
    }
    return right[1].length - left[1].length;
  });

  const summaryLimit = 12;
  const lines = entries.slice(0, summaryLimit).map(([area, paths]) => {
    const samples = samplePaths(paths).join(", ");
    const moreCount = paths.length - Math.min(paths.length, 3);
    const moreSuffix =
      moreCount > 0 ? `, +${formatScalar(moreCount)} more` : "";
    return `  - ${area}: ${formatScalar(paths.length)} file(s) (${samples}${moreSuffix})`;
  });

  if (entries.length > summaryLimit) {
    lines.push(
      `  - +${formatScalar(entries.length - summaryLimit)} more area(s)`,
    );
  }

  return lines;
}
