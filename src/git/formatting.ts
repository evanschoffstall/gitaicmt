import type { DiffChunk, DiffHunk, DiffStats, FileDiff } from "./models.js";

import { DIFF_DEV_NULL_PATH } from "./header.js";

export function formatDiffHeaderLines(file: FileDiff): string[] {
  const oldHeaderPath =
    file.status === "added" ? DIFF_DEV_NULL_PATH : (file.oldPath ?? file.path);
  const newHeaderPath =
    file.status === "deleted" ? DIFF_DEV_NULL_PATH : file.path;

  return [
    `--- ${oldHeaderPath}`,
    `+++ ${newHeaderPath}`,
    ...(file.metadataLines ?? []),
  ];
}

export function formatFileDiff(file: FileDiff): string {
  return formatSelectedFileDiff(file);
}

export function formatSelectedFileDiff(
  file: FileDiff,
  hunks?: DiffHunk[],
): string {
  const parts = formatDiffHeaderLines(file);
  for (const hunk of hunks ?? file.hunks) {
    parts.push(hunk.header);
    parts.push(...hunk.lines);
  }
  return parts.join("\n");
}

export function getStats(files: FileDiff[], chunks: DiffChunk[]): DiffStats {
  return {
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    chunks: chunks.length,
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    filesChanged: files.length,
  };
}
