import { type PlannedCommitFile } from "../commit-planning/orchestration.js";
import { type FileDiff } from "../git/diff.js";
import { wrapTokenizedTextBySeparatorPreference } from "./token-splitting.js";

export function formatCommitFile(
  file: PlannedCommitFile,
  fileDiffs?: Map<string, FileDiff>,
): string {
  if (!file.hunks || file.hunks.length === 0) return file.path;
  const total = fileDiffs?.get(file.path)?.hunks.length;
  const idx = file.hunks.join(", ");
  const word = file.hunks.length === 1 ? "hunk" : "hunks";
  const suffix =
    total !== undefined ? `[${word} ${idx} / ${String(total)}]` : `[${word} ${idx}]`;
  return `${file.path} ${suffix}`;
}

export function formatPlanBodyLine(line: string, maxWidth: number): string[] {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return [""];
  }

  const bulletMatch = /^(-\s+)(.*)$/u.exec(trimmedLine);
  if (!bulletMatch) {
    return wrapDisplayText(trimmedLine, maxWidth);
  }

  const [, bulletPrefix, bulletText] = bulletMatch;
  return wrapDisplayTextWithPrefix(bulletText, {
    continuationPrefix: " ".repeat(bulletPrefix.length),
    firstLinePrefix: bulletPrefix,
    maxWidth,
  });
}

export function wrapDisplayFileLines(files: string[], maxWidth: number): string[] {
  const lines: string[] = [];
  let currentLine = "Files:";
  const fileLinePrefix = "       ";

  for (let index = 0; index < files.length; index++) {
    const fileText = index < files.length - 1 ? `${files[index]},` : files[index];
    const candidate =
      currentLine === "Files:" ? `${currentLine} ${fileText}` : `${currentLine} ${fileText}`;

    if (candidate.length <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }

    const wrappedFileLines = wrapDisplayTextWithPrefix(fileText, {
      continuationPrefix: fileLinePrefix,
      firstLinePrefix: fileLinePrefix,
      maxWidth,
    });
    currentLine = wrappedFileLines.pop() ?? fileLinePrefix;
    lines.push(...wrappedFileLines);
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }
  return lines;
}

export function wrapDisplayText(text: string, maxWidth: number): string[] {
  return wrapTokenizedTextBySeparatorPreference(text, maxWidth);
}

function wrapDisplayTextWithPrefix(
  text: string,
  options: {
    continuationPrefix: string;
    firstLinePrefix: string;
    maxWidth: number;
  },
): string[] {
  const contentWidth = Math.max(12, options.maxWidth - options.firstLinePrefix.length);
  const wrappedLines = wrapDisplayText(text, contentWidth);

  return wrappedLines.map((line, index) =>
    `${index === 0 ? options.firstLinePrefix : options.continuationPrefix}${line}`,
  );
}