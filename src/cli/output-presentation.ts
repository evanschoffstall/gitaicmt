import { type PlannedCommitFile } from "../commit-planning/orchestration.js";
import { type FileDiff } from "../git/diff.js";
import {
  formatCommitFile,
  formatPlanBodyLines,
  wrapDisplayFileLines,
  wrapDisplayText,
} from "./commit-plan-display.js";

const ANSI_BLUE = "\x1b[34m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_DIM = "\x1b[2m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RESET = "\x1b[0m";
const ANSI_WHITE = "\x1b[37m";
const ANSI_YELLOW = "\x1b[33m";

/** Input contract for rendering one planned-commit card in the default UI. */
export interface PlanCardOptions {
  fileDiffs?: Map<string, FileDiff>;
  files: PlannedCommitFile[];
  index: number;
  maxWidth: number;
  message: string;
  total: number;
}

/** Semantic status row rendered inside compact CLI summary sections. */
export interface PresentationStatusRow {
  label: string;
  tone?: "default" | "warning";
  value: string;
}

/**
 * Renders the default planned-commit presentation as a boxed card with a clear
 * subject, impact summary, details, and file scope.
 */
export function buildPlanCardLines(options: PlanCardOptions): string[] {
  const [rawSubject = "(missing subject)", ...rawBodyLines] = options.message.split("\n");
  const subject = rawSubject.trim() || "(missing subject)";
  const body = rawBodyLines.join("\n").trim();
  const detailLines = body.length > 0 ? formatPlanBodyLines(body, options.maxWidth - 8) : [];
  const detailCount = countDetailBullets(body);
  const impactSummary = [
    `${String(options.files.length)} ${options.files.length === 1 ? "file" : "files"}`,
    detailCount > 0
      ? `${String(detailCount)} ${detailCount === 1 ? "detail" : "details"}`
      : "subject only",
  ].join(" · ");
  const fileLines = wrapDisplayFileLines(
    options.files.map((file) => formatCommitFile(file, options.fileDiffs)),
    options.maxWidth - 8,
  );
  const lines = [
    `${ANSI_BOLD}${ANSI_CYAN}╭─ Commit ${String(options.index)} of ${String(options.total)}${ANSI_RESET}`,
    ...formatCardValueLines("Subject", subject, options.maxWidth, ANSI_CYAN),
    ...formatCardValueLines("Impact", impactSummary, options.maxWidth, ANSI_DIM),
  ];

  if (detailLines.length > 0) {
    lines.push(formatCardSpacer(), formatCardSectionLabel("Details"));
    for (const line of detailLines) {
      lines.push(formatCardBulletLine(line, ANSI_BLUE));
    }
  }

  lines.push(formatCardSpacer(), formatCardSectionLabel("Files"));
  for (const line of fileLines) {
    lines.push(formatCardBulletLine(line, ANSI_DIM));
  }
  lines.push(`${ANSI_DIM}╰─${ANSI_RESET}`);

  return lines;
}

/** Builds the final confirmation block shown before commit execution begins. */
export function buildReadyPromptLines(
  plannedCommitCount: number,
  maxWidth: number,
): string[] {
  return buildStatusSectionLines(
    "Ready To Commit",
    [
      {
        label: "commits",
        value: `${String(plannedCommitCount)} planned ${plannedCommitCount === 1 ? "commit" : "commits"} ready`,
      },
      {
        label: "action",
        value: "reply y to commit or n to abort",
      },
    ],
    maxWidth,
    `${ANSI_BOLD}${ANSI_GREEN}Proceed?${ANSI_RESET}`,
  );
}

/**
 * Builds one compact status section with aligned labels and optional trailing
 * content such as a confirmation prompt.
 */
export function buildStatusSectionLines(
  title: string,
  rows: PresentationStatusRow[],
  maxWidth: number,
  trailingLine?: string,
): string[] {
  const sectionLines = [`${ANSI_BOLD}${ANSI_WHITE}${title}${ANSI_RESET}`];

  for (const row of rows) {
    sectionLines.push(...formatStatusRowLines(row, maxWidth));
  }

  if (trailingLine) {
    sectionLines.push(trailingLine);
  }

  return sectionLines;
}

/** Counts top-level detail bullets from the AI-authored body for impact labels. */
function countDetailBullets(body: string): number {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ")).length;
}

/** Styles one wrapped detail or file line within a commit card subsection. */
function formatCardBulletLine(line: string, accentColor: string): string {
  if (line.length === 0) {
    return formatCardSpacer();
  }

  const bulletMatch = /^(\s*)-\s(.*)$/u.exec(line);
  if (!bulletMatch) {
    return `${ANSI_DIM}│${ANSI_RESET}   ${ANSI_DIM}${line}${ANSI_RESET}`;
  }

  const [, indentation, content] = bulletMatch;
  return `${ANSI_DIM}│${ANSI_RESET}   ${ANSI_DIM}${indentation}${ANSI_RESET}${accentColor}${ANSI_BOLD}-${ANSI_RESET}${ANSI_DIM} ${content}${ANSI_RESET}`;
}

/** Renders one subsection label inside a commit card. */
function formatCardSectionLabel(label: string): string {
  return `${ANSI_DIM}│${ANSI_RESET} ${ANSI_BOLD}${ANSI_WHITE}${label}${ANSI_RESET}`;
}

/** Renders an empty spacer rail inside a commit card. */
function formatCardSpacer(): string {
  return `${ANSI_DIM}│${ANSI_RESET}`;
}

/** Wraps one labeled line inside a commit card while preserving the card rail. */
function formatCardValueLines(
  label: string,
  value: string,
  maxWidth: number,
  valueColor: string,
): string[] {
  const labelPrefix = `│ ${label.padEnd(7)} `;
  const continuationPrefix = "│         ";
  const valueWidth = Math.max(12, maxWidth - labelPrefix.length);
  const valueLines = wrapDisplayText(value, valueWidth);

  return valueLines.map((line, index) => {
    const styledLabel =
      index === 0
        ? `${ANSI_DIM}│ ${ANSI_BOLD}${ANSI_WHITE}${label.padEnd(7)}${ANSI_RESET}${ANSI_DIM} ${ANSI_RESET}`
        : `${ANSI_DIM}${continuationPrefix}${ANSI_RESET}`;

    return `${styledLabel}${valueColor}${line}${ANSI_RESET}`;
  });
}

/** Aligns one status row label and wraps the value to the provided width. */
function formatStatusRowLines(
  row: PresentationStatusRow,
  maxWidth: number,
): string[] {
  const labelWidth = 10;
  const labelText = row.label.padEnd(labelWidth);
  const valueWidth = Math.max(12, maxWidth - 3 - labelWidth - 1);
  const valueLines = wrapDisplayText(row.value, valueWidth);
  const labelColor = row.tone === "warning" ? ANSI_YELLOW : ANSI_DIM;

  return valueLines.map((line, index) => {
    const prefix = index === 0 ? labelText : " ".repeat(labelWidth);
    return `  ${labelColor}${prefix}${ANSI_RESET} ${ANSI_DIM}${line}${ANSI_RESET}`;
  });
}