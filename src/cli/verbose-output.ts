import type { AiOutputEvent } from "../commit-planning/orchestration.js";

import {
  buildEventTitle,
  formatEventStatLines,
  formatTraceBlock,
  getEventFrameSeverity,
  styleTraceFooter,
  styleTraceHeader,
  styleTraceRail,
  wrapLine,
} from "./verbose-rendering/block-render.js";

export interface VerboseOutputOptions {
  maxWidth?: number;
  mode?: "summary" | "trace";
  sequence?: number;
}

interface VerboseCommitFile {
  hunks?: number[];
  path: string;
}

interface VerboseCommitPlanItem {
  files: VerboseCommitFile[];
  message: string;
}

/**
 * Formats AI stage output into terminal-friendly lines instead of raw JSON.
 * Dispatches to trace, commit-plan, or generic block renderers based on mode
 * and content shape.
 */
export function formatVerboseAiOutputLines(
  event: AiOutputEvent,
  options?: VerboseOutputOptions,
): string[] {
  const maxWidth = Math.max(60, options?.maxWidth ?? 100);
  const mode = options?.mode ?? "summary";
  const parsed = parseJson(event.content);
  const sequence = options?.sequence;

  if (mode === "trace") {
    return formatTraceBlock(event, parsed, maxWidth, sequence);
  }

  if (isCommitPlan(parsed)) {
    return formatCommitPlanBlock(event, parsed, maxWidth, sequence);
  }

  return formatGenericBlock(
    event,
    buildEventTitle(event, parsed, sequence),
    normalizeGenericContent(event.content, parsed),
    maxWidth,
  );
}

function collectBodyBullets(message: string): string[] {
  const lines = message
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const bullets: string[] = [];

  for (const line of lines) {
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
      continue;
    }

    const previous = bullets.pop();
    if (previous) {
      bullets.push(`${previous} ${line}`);
      continue;
    }

    bullets.push(line);
  }

  return bullets;
}

function formatCommitFiles(files: VerboseCommitFile[]): string {
  return files
    .map((file) => {
      if (!file.hunks || file.hunks.length === 0) {
        return file.path;
      }

      if (file.hunks.length <= 3) {
        return `${file.path} [${file.hunks.join(", ")}]`;
      }

      return `${file.path} [${String(file.hunks.length)} hunks]`;
    })
    .join(", ");
}

function formatCommitPlanBlock(
  event: AiOutputEvent,
  commits: VerboseCommitPlanItem[],
  maxWidth: number,
  sequence?: number,
): string[] {
  const severity = getEventFrameSeverity(event, commits);
  const commitLabel =
    commits.length === 1 ? "candidate commit" : "candidate commits";
  const lines = [
    styleTraceHeader(
      `╭── ${buildEventTitle(event, commits, sequence)} · ${String(commits.length)} ${commitLabel}`,
      severity,
    ),
  ];
  lines.push(...formatEventStatLines(event, maxWidth, severity));

  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index];
    const subject =
      commit.message.split("\n")[0]?.trim() ?? "(missing subject)";
    lines.push(
      ...wrapLine(
        `${String(index + 1)}. ${subject}`,
        maxWidth - 2,
        "│ ",
        "│    ",
      ).map((line) => styleTraceRail(line, severity)),
      ...wrapLine(
        `coverage: ${String(commit.files.length)} file(s) · ${formatCommitFiles(commit.files)}`,
        maxWidth - 4,
        "│   ",
        "│         ",
      ).map((line) => styleTraceRail(line, severity)),
    );

    const bullets = collectBodyBullets(commit.message);
    const previewBullets = bullets.slice(0, 2);
    for (const bullet of previewBullets) {
      lines.push(
        ...wrapLine(bullet, maxWidth - 6, "│   - ", "│     ").map(
          (line) => styleTraceRail(line, severity),
        ),
      );
    }
    if (bullets.length > previewBullets.length) {
      lines.push(
        styleTraceRail(
          `│   - ... ${String(bullets.length - previewBullets.length)} more detail line(s)`,
          severity,
        ),
      );
    }

    if (index < commits.length - 1) {
      lines.push(styleTraceRail("│", severity));
    }
  }

  lines.push(styleTraceFooter("╰──", severity));
  return lines;
}

function formatGenericBlock(
  event: AiOutputEvent,
  title: string,
  content: string,
  maxWidth: number,
): string[] {
  const severity = getEventFrameSeverity(event, parseJson(event.content));
  const trimmedContent = content.trim();
  const lines = [styleTraceHeader(`╭── ${title}`, severity)];
  lines.push(...formatEventStatLines(event, maxWidth, severity));

  if (trimmedContent.length === 0) {
    lines.push(
      styleTraceRail("│ (empty)", severity),
      styleTraceFooter("╰──", severity),
    );
    return lines;
  }

  for (const rawLine of trimmedContent.split("\n")) {
    lines.push(
      ...wrapLine(rawLine, maxWidth - 2, "│ ", "│ ").map((line) =>
        styleTraceRail(line, severity),
      ),
    );
  }

  lines.push(styleTraceFooter("╰──", severity));
  return lines;
}

function isCommitPlan(value: unknown): value is VerboseCommitPlanItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "message" in item &&
        typeof item.message === "string" &&
        "files" in item &&
        Array.isArray(item.files) &&
        item.files.every(
          (file: unknown) =>
            typeof file === "object" &&
            file !== null &&
            "path" in file &&
            typeof file.path === "string" &&
            (!("hunks" in file) ||
              file.hunks === undefined ||
              (Array.isArray(file.hunks) &&
                file.hunks.every(
                  (hunk: unknown) => typeof hunk === "number",
                ))),
        ),
    )
  );
}

function normalizeGenericContent(
  parsedText: string,
  parsedJson: unknown,
): string {
  if (parsedJson === undefined) {
    return parsedText.trim();
  }

  return JSON.stringify(parsedJson, null, 2);
}

function parseJson(content: string): unknown {
  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(trimmedContent) as unknown;
  } catch {
    return undefined;
  }
}
