import type { DiffHunk, FileDiff } from "./models.js";

import { encodeGitQuotedPath } from "./header.js";

export function buildPatch(file: FileDiff, hunks?: DiffHunk[]): string {
  const selectedHunks = hunks ?? file.hunks;
  if (
    file.isBinary ||
    isEmptyPatchSelection(selectedHunks, file.metadataLines)
  ) {
    return "";
  }

  const oldPath = file.oldPath ?? file.path;
  const lines = [
    `diff --git ${formatGitPatchPath(oldPath, "a/")} ${formatGitPatchPath(file.path, "b/")}`,
    ...(file.metadataLines ?? []),
    ...buildPatchHeaderLines(file, oldPath, selectedHunks.length > 0),
  ];

  for (const hunk of selectedHunks) {
    lines.push(hunk.header, ...hunk.lines);
  }

  lines.push("");
  return lines.join("\n");
}

function buildPatchHeaderLines(
  file: FileDiff,
  oldPath: string,
  shouldIncludeContentHeaders: boolean,
): string[] {
  if (!shouldIncludeContentHeaders) {
    return [];
  }
  if (file.status === "added") {
    return ["--- /dev/null", `+++ ${formatGitPatchPath(file.path, "b/")}`];
  }
  if (file.status === "deleted") {
    return [`--- ${formatGitPatchPath(oldPath, "a/")}`, "+++ /dev/null"];
  }

  return [
    `--- ${formatGitPatchPath(oldPath, "a/")}`,
    `+++ ${formatGitPatchPath(file.path, "b/")}`,
  ];
}

function formatGitPatchPath(path: string, prefix: "a/" | "b/"): string {
  return encodeGitQuotedPath(`${prefix}${path}`);
}

function isEmptyPatchSelection(
  selectedHunks: DiffHunk[],
  metadataLines: FileDiff["metadataLines"],
): boolean {
  return selectedHunks.length === 0 && (metadataLines?.length ?? 0) === 0;
}
