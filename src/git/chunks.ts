import type { DiffChunk, FileDiff } from "./models.js";

import { loadConfig } from "../application/config/index.js";
import { formatFileDiff, formatSelectedFileDiff } from "./formatting.js";

export function chunkDiffs(files: FileDiff[]): DiffChunk[] {
  const cfg = loadConfig();
  const maxLines = cfg.analysis.chunkSize;
  return cfg.analysis.groupByFile
    ? chunkDiffsByFile(files, maxLines, cfg.analysis.groupByHunk)
    : chunkDiffsAcrossFiles(files, maxLines);
}

function chunkDiffsAcrossFiles(
  files: FileDiff[],
  maxLines: number,
): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let nextId = 0;
  let buffer: string[] = [];
  let bufferFiles: string[] = [];
  let bufferLineCount = 0;

  for (const file of files) {
    const text = formatFileDiff(file);
    const lineCount = countTextLines(text);
    if (bufferLineCount + lineCount > maxLines && buffer.length > 0) {
      chunks.push(
        createChunk(buffer.join("\n"), bufferFiles, nextId++, bufferLineCount),
      );
      buffer = [];
      bufferFiles = [];
      bufferLineCount = 0;
    }
    buffer.push(text);
    bufferFiles.push(file.path);
    bufferLineCount += lineCount;
  }

  if (buffer.length > 0) {
    chunks.push(
      createChunk(buffer.join("\n"), bufferFiles, nextId, bufferLineCount),
    );
  }

  return chunks;
}

function chunkDiffsByFile(
  files: FileDiff[],
  maxLines: number,
  groupByHunk: boolean,
): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let nextId = 0;

  for (const file of files) {
    const text = formatFileDiff(file);
    const lineCount = countTextLines(text);
    if (lineCount <= maxLines || !groupByHunk) {
      chunks.push(createChunk(text, [file.path], nextId++, lineCount));
      continue;
    }

    for (const hunk of file.hunks) {
      const hunkText = formatSelectedFileDiff(file, [hunk]);
      chunks.push(
        createChunk(hunkText, [file.path], nextId++, countTextLines(hunkText)),
      );
    }
  }

  return chunks;
}

function countTextLines(text: string): number {
  return text.split("\n").length;
}

function createChunk(
  content: string,
  files: string[],
  id: number,
  lineCount: number,
): DiffChunk {
  return { content, files: [...files], id, lineCount };
}
