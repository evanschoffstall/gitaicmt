import { ValidationError } from "../application/errors.js";
import {
  isBulletContinuationLine,
  isBulletLine,
  trimTrailingBlankLines,
} from "./commit-message-bullets.js";
import { parseConventionalSubject } from "./subject-parser.js";

const BREAKING_CHANGE_FOOTER_PREFIX = "BREAKING CHANGE:";
const BREAKING_CHANGE_FOOTER_PATTERN =
  /^BREAKING[ -]CHANGE:\s+(?<detail>\S.*)$/;

/** Ensure a breaking commit body carries a valid BREAKING CHANGE footer. */
export function ensureBreakingChangeFooter(
  bodyLines: string[],
  subject: string,
): string[] {
  const { hasBreakingChangeFooter } =
    splitCommitBodyAndBreakingFooter(bodyLines);
  if (hasBreakingChangeFooter) {
    return bodyLines;
  }

  return [...bodyLines, "", buildBreakingChangeFooter(subject, bodyLines)];
}

/** Separate the bullet body from the footer while enforcing footer placement rules. */
export function splitCommitBodyAndBreakingFooter(bodyLines: string[]): {
  bulletBodyLines: string[];
  hasBreakingChangeFooter: boolean;
} {
  const breakingFooterIndex = bodyLines.findIndex((line) =>
    BREAKING_CHANGE_FOOTER_PATTERN.test(line),
  );
  if (breakingFooterIndex === -1) {
    return { bulletBodyLines: bodyLines, hasBreakingChangeFooter: false };
  }

  if (
    breakingFooterIndex === 0 ||
    bodyLines[breakingFooterIndex - 1]?.trim() !== ""
  ) {
    throw new ValidationError(
      "BREAKING CHANGE footer must be separated from the body by a blank line",
    );
  }

  validateBreakingChangeFooter(bodyLines.slice(breakingFooterIndex));
  return {
    bulletBodyLines: trimTrailingBlankLines(
      bodyLines.slice(0, breakingFooterIndex),
    ),
    hasBreakingChangeFooter: true,
  };
}

function buildBreakingChangeFooter(
  subject: string,
  bodyLines: string[],
): string {
  const parsed = parseConventionalSubject(subject);
  const subjectDetail = parsed.description || subject;
  let bodyDetail =
    "Review the commit body for migration and compatibility details.";

  for (let index = 0; index < bodyLines.length; index++) {
    const line = bodyLines[index] ?? "";
    if (!isBulletLine(line)) {
      continue;
    }

    const bulletParts = [line.replace(/^\s*-\s+/, "").trim()];
    for (let nextIndex = index + 1; nextIndex < bodyLines.length; nextIndex++) {
      const nextLine = bodyLines[nextIndex] ?? "";
      if (!isBulletContinuationLine(nextLine, true)) {
        break;
      }
      bulletParts.push(nextLine.trim());
    }

    bodyDetail = bulletParts.join(" ").replace(/\s+/g, " ");
    break;
  }

  return `${BREAKING_CHANGE_FOOTER_PREFIX} ${capitalizeSentence(subjectDetail)}. ${bodyDetail}`;
}

function capitalizeSentence(value: string): string {
  const trimmed = value.trim().replace(/[.!?]+$/, "");
  return trimmed.length === 0
    ? "This change is breaking"
    : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function validateBreakingChangeFooter(footerLines: string[]): void {
  const [footerLine, ...continuationLines] = footerLines;
  const detail =
    BREAKING_CHANGE_FOOTER_PATTERN.exec(footerLine)?.groups?.detail;
  if (!detail || detail.trim().length < 20) {
    throw new ValidationError(
      "BREAKING CHANGE footer must describe the compatibility impact",
    );
  }

  for (const line of continuationLines) {
    if (line.trim().length === 0) {
      throw new ValidationError(
        "BREAKING CHANGE footer must not contain blank continuation lines",
      );
    }
    if (isBulletLine(line)) {
      throw new ValidationError(
        "BREAKING CHANGE footer continuation lines must be prose, not bullets",
      );
    }
  }
}
