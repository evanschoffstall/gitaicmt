import { type PlannedCommitFile } from "../../commit-planning/orchestration.js";
import { type FileDiff } from "../../git/diff.js";
import { wrapTokenizedTextBySeparatorPreference } from "../token/splitting.js";

export function formatCommitFile(
  file: PlannedCommitFile,
  fileDiffs?: Map<string, FileDiff>,
): string {
  const displayPath = normalizeDisplayPath(file.path);
  if (!file.hunks || file.hunks.length === 0) return displayPath;
  const total = fileDiffs?.get(file.path)?.hunks.length;
  const idx = file.hunks.join(", ");
  const word = file.hunks.length === 1 ? "hunk" : "hunks";
  const suffix =
    total !== undefined
      ? `[${word} ${idx} / ${String(total)}]`
      : `[${word} ${idx}]`;
  return `${displayPath} ${suffix}`;
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

export function formatPlanBodyLines(body: string, maxWidth: number): string[] {
  const lines = body.split("\n").map((line) => line.trimEnd());
  const normalizedLines: string[] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0) {
      normalizedLines.push("");
      continue;
    }

    if (trimmedLine.startsWith("- ")) {
      normalizedLines.push(trimmedLine);
      continue;
    }

    const previousLine = normalizedLines.at(-1);
    if (previousLine?.trim().startsWith("- ")) {
      normalizedLines[normalizedLines.length - 1] =
        `${previousLine} ${trimmedLine}`;
      continue;
    }

    normalizedLines.push(trimmedLine);
  }

  return normalizedLines.flatMap((line) => formatPlanBodyLine(line, maxWidth));
}

export function wrapDisplayFileLines(
  files: string[],
  maxWidth: number,
): string[] {
  return files.flatMap((file) =>
    wrapDisplayTextWithPrefix(normalizeDisplayPath(file), {
      continuationPrefix: "  ",
      firstLinePrefix: "- ",
      maxWidth,
    }),
  );
}

export function wrapDisplayText(text: string, maxWidth: number): string[] {
  return wrapTokenizedTextBySeparatorPreference(text, maxWidth);
}

function normalizeDisplayPath(text: string): string {
  for (const rootName of ["src/", "tests/", "scripts/"]) {
    const rootIndex = text.indexOf(rootName);
    if (rootIndex >= 0) {
      return text.slice(rootIndex);
    }
  }

  return text;
}

function wrapDisplayTextWithPrefix(
  text: string,
  options: {
    continuationPrefix: string;
    firstLinePrefix: string;
    maxWidth: number;
  },
): string[] {
  const contentWidth = Math.max(
    12,
    options.maxWidth - options.firstLinePrefix.length,
  );
  const wrappedLines = wrapDisplayText(text, contentWidth);

  return wrappedLines.map(
    (line, index) =>
      `${index === 0 ? options.firstLinePrefix : options.continuationPrefix}${line}`,
  );
}
