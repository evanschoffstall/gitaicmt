import { ValidationError } from "../application/errors.js";
import { formatDiffHeaderLines } from "../git/diff.js";
import {
  ensureBreakingChangeFooter,
  splitCommitBodyAndBreakingFooter,
} from "./breaking-change-footers.js";
import {
  isBulletContinuationLine,
  isBulletLine,
  trimTrailingBlankLines,
} from "./commit-message-bullets.js";
import {
  normalizeConventionalSubjectScope,
  parseConventionalSubject,
} from "./subject-parser.js";

type FileDiff = import("../git/diff.js").FileDiff;

const NON_BREAKING_CONVENTIONAL_TYPES = new Set([
  "chore",
  "ci",
  "docs",
  "style",
  "test",
  "tests",
]);

export function formatLabeledDiff(
  file: FileDiff,
  formatFileDiff: (f: FileDiff) => string,
): string {
  if (file.hunks.length <= 1) {
    return formatFileDiff(file);
  }

  const parts: string[] = [...formatDiffHeaderLines(file)];
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

/** Return a validated commit message whose conventional subject and footer declare a breaking change. */
export function markCommitMessageBreaking(message: string): string {
  const { bodyLines, subject } = parseCommitMessage(message);
  const parsedSubject = parseConventionalSubject(subject);
  const breakingSubject = markConventionalSubjectBreaking(subject);
  if (breakingSubject === subject && !parsedSubject.isBreaking) {
    return validateCommitMessage(message);
  }

  const nextBodyLines = ensureBreakingChangeFooter(bodyLines, breakingSubject);
  return validateCommitMessage(
    [breakingSubject, "", ...nextBodyLines].join("\n"),
  );
}

/** Return a validated commit message with conventional breaking metadata removed. */
export function suppressCommitMessageBreaking(message: string): string {
  const { bodyLines, subject } = parseCommitMessage(message);
  const nextSubject = suppressBreakingReleaseLanguage(
    suppressConventionalSubjectBreaking(subject),
  );
  const { bulletBodyLines } = splitCommitBodyAndBreakingFooter(bodyLines);
  return validateCommitMessage(
    [
      nextSubject,
      "",
      ...bulletBodyLines.map(suppressBreakingReleaseLanguage),
    ].join("\n"),
  );
}

export function validateCommitMessage(message: string): string {
  const { bodyLines, subject } = parseCommitMessage(message);
  const { bulletBodyLines, hasBreakingChangeFooter } =
    splitCommitBodyAndBreakingFooter(bodyLines);
  const parsedSubject = parseConventionalSubject(subject);

  validateCommitMessageBody(bulletBodyLines);
  if (parsedSubject.isBreaking && !hasBreakingChangeFooter) {
    throw new ValidationError(
      "Breaking commit messages must include a BREAKING CHANGE footer",
    );
  }

  return [subject, "", ...bodyLines].join("\n");
}

function markConventionalSubjectBreaking(subject: string): string {
  const parsed = parseConventionalSubject(subject);
  if (
    parsed.type === "" ||
    parsed.isBreaking ||
    NON_BREAKING_CONVENTIONAL_TYPES.has(parsed.type)
  ) {
    return subject;
  }

  const colonIdx = subject.indexOf(":");
  return `${subject.slice(0, colonIdx)}!${subject.slice(colonIdx)}`;
}

function parseCommitMessage(message: string): {
  bodyLines: string[];
  subject: string;
} {
  const normalized = message.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    throw new ValidationError("Commit message cannot be empty");
  }

  const lines = normalized.split("\n");
  const subject = normalizeConventionalSubjectScope(lines[0]?.trim() ?? "");
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

  return { bodyLines, subject };
}

function suppressBreakingReleaseLanguage(line: string): string {
  return line
    .replace(/\bbreaking[- ]change(s)?\b/giu, "compatibility-impact change$1")
    .replace(/\bbreaking metadata\b/giu, "release-impact metadata")
    .replace(/\bbreaking marker(s)?\b/giu, "release-impact marker$1")
    .replace(/\bbreaking footer(s)?\b/giu, "release-impact footer$1")
    .replace(/\bbreaking authoring\b/giu, "release-impact authoring")
    .replace(/\bmajor[- ]version\b/giu, "release-impact")
    .replace(/\bmajor[- ]release\b/giu, "release-impact")
    .replace(/\bmust migrate\b/giu, "must adjust")
    .replace(/\brequires migration\b/giu, "requires adjustment")
    .replace(/\brequire migration\b/giu, "require adjustment");
}

function suppressConventionalSubjectBreaking(subject: string): string {
  const parsed = parseConventionalSubject(subject);
  if (!parsed.isBreaking) {
    return subject;
  }

  const colonIdx = subject.indexOf(":");
  const prefix = subject.slice(0, colonIdx);
  return `${prefix.slice(0, -1)}${subject.slice(colonIdx)}`;
}

function validateCommitMessageBody(bodyLines: string[]): void {
  let bulletCount = 0;
  let previousLineWasBullet = false;

  for (const line of bodyLines) {
    if (line.trim().length === 0) {
      previousLineWasBullet = false;
      continue;
    }

    if (isBulletLine(line)) {
      bulletCount++;
      previousLineWasBullet = true;
      continue;
    }

    if (isBulletContinuationLine(line, previousLineWasBullet)) {
      continue;
    }

    throw new ValidationError("Commit message body must use bullet points");
  }

  if (bulletCount === 0) {
    throw new ValidationError(
      "Commit message body must include at least one bullet point",
    );
  }
}
