import { type PlannedCommitFile } from "./ai.js";
import { type FileDiff } from "./diff.js";

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

  for (let index = 0; index < files.length; index++) {
    const fileText = index < files.length - 1 ? `${files[index]},` : files[index];
    const candidate =
      currentLine === "Files:" ? `${currentLine} ${fileText}` : `${currentLine} ${fileText}`;

    if (candidate.length <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    lines.push(currentLine);
    currentLine = `       ${fileText}`;
  }

  lines.push(currentLine);
  return lines;
}

export function wrapDisplayText(text: string, maxWidth: number): string[] {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return [""];
  }

  const parts = trimmedText.split(/\s+/u).filter((part) => part.length > 0);
  const lines: string[] = [];
  let currentLine = "";

  for (const part of parts) {
    const candidate = currentLine.length === 0 ? part : `${currentLine} ${part}`;
    if (candidate.length <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = part;
      continue;
    }

    lines.push(part);
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
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