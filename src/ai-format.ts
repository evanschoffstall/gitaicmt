import { ValidationError } from "./errors.js";

type FileDiff = import("./diff.js").FileDiff;

export function formatLabeledDiff(
  file: FileDiff,
  formatFileDiff: (f: FileDiff) => string,
): string {
  if (file.hunks.length <= 1) {
    return formatFileDiff(file);
  }

  const parts: string[] = [
    `--- ${file.oldPath ?? file.path}`,
    `+++ ${file.path}`,
  ];
  for (let i = 0; i < file.hunks.length; i++) {
    const hunk = file.hunks[i];
    parts.push(`[Hunk ${formatScalar(i)}] ${hunk.header}`);
    parts.push(...hunk.lines);
  }
  return parts.join("\n");
}

export function formatScalar(value: boolean | number): string {
  return String(value);
}

export function validateCommitMessage(message: string): string {
  const normalized = message.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    throw new ValidationError("Commit message cannot be empty");
  }

  const lines = normalized.split("\n");
  const subject = lines[0]?.trim() ?? "";
  if (subject.length === 0) {
    throw new ValidationError("Commit message subject cannot be empty");
  }

  if (lines.length < 3) {
    throw new ValidationError(
      "Commit message body is required and must follow the subject",
    );
  }
  if (lines[1]?.trim() !== "") {
    throw new ValidationError(
      "Commit message body must be separated from the subject by a blank line",
    );
  }

  const bodyLines = trimTrailingBlankLines(lines.slice(2));
  if (bodyLines.length === 0) {
    throw new ValidationError("Commit message body is required");
  }

  let bulletCount = 0;
  let previousLineWasBullet = false;
  for (const line of bodyLines) {
    if (line.trim().length === 0) {
      previousLineWasBullet = false;
      continue;
    }
    if (/^\s*-\s+\S/.test(line)) {
      bulletCount++;
      previousLineWasBullet = true;
      continue;
    }
    if (/^\s{2,}\S/.test(line) && previousLineWasBullet) {
      continue;
    }

    throw new ValidationError("Commit message body must use bullet points");
  }

  if (bulletCount === 0) {
    throw new ValidationError(
      "Commit message body must include at least one bullet point",
    );
  }

  return [subject, "", ...bodyLines].join("\n");
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed.at(-1)?.trim() === "") {
    trimmed.pop();
  }
  return trimmed;
}
