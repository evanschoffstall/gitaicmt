/** Terminal block rendering: ANSI styling, line wrapping, and event-stat lines. */
import { formatJsonTraceValue } from "./json-trace.js";

type AiOutputEvent = import("../../commit-planning/openai-client.js").AiOutputEvent;

export const ANSI_BOLD = "\x1b[1m";
export const ANSI_CYAN = "\x1b[36m";
export const ANSI_DIM = "\x1b[2m";
export const ANSI_RESET = "\x1b[0m";

/** Builds a stage title, optionally appending a sequence number. */
export function buildStageTitle(
  stage: AiOutputEvent["stage"],
  sequence?: number,
): string {
  const baseTitle = describeStage(stage);
  return sequence === undefined
    ? baseTitle
    : `${baseTitle} #${String(sequence)}`;
}

/** Returns a human-friendly label for an AI pipeline stage name. */
export function describeStage(stage: AiOutputEvent["stage"]): string {
  switch (stage) {
    case "cluster": {
      return "Merge review";
    }
    case "consolidate": {
      return "Final consolidation";
    }
    case "generate": {
      return "Message draft";
    }
    case "group": {
      return "Grouping batch";
    }
    case "merge": {
      return "Message merge";
    }
    default: {
      return "AI output";
    }
  }
}

/**
 * Returns wrapped rail lines for the "stats: …" line derived from an AI
 * output event. Returns an empty array when no stats are available.
 */
export function formatEventStatLines(
  event: AiOutputEvent,
  maxWidth: number,
): string[] {
  const parts: string[] = [];

  if (event.kind) {
    parts.push(`kind: ${event.kind}`);
  }
  if (event.transport) {
    parts.push(`transport: ${event.transport}`);
  }
  if (typeof event.durationMs === "number") {
    parts.push(`time: ${formatDuration(event.durationMs)}`);
  }
  if (typeof event.requestCountDelta === "number") {
    parts.push(`req: ${String(event.requestCountDelta)}`);
  }
  if (typeof event.inputTokens === "number") {
    parts.push(`in: ${String(event.inputTokens)}`);
  }
  if (typeof event.outputTokens === "number") {
    parts.push(`out: ${String(event.outputTokens)}`);
  }
  if (typeof event.totalTokens === "number") {
    parts.push(`tok: ${String(event.totalTokens)}`);
  }

  if (parts.length === 0) {
    return [];
  }

  const statsLine = `stats: ${parts.join(" · ")}`;
  return wrapLine(statsLine, maxWidth - 4, "│   ", "│     ").map(styleTraceRail);
}

/** Renders a full trace block (raw/JSON expansion) for the given event. */
export function formatTraceBlock(
  event: AiOutputEvent,
  parsed: unknown,
  maxWidth: number,
  sequence?: number,
): string[] {
  const title = `${buildStageTitle(event.stage, sequence)} trace`;
  const rawContent = event.content.trimEnd();
  const lines = [styleTraceHeader(`╭── ${title}`)];
  lines.push(...formatEventStatLines(event, maxWidth));

  if (rawContent.length === 0) {
    lines.push(styleTraceRail("│ (empty)"), styleTraceFooter("╰──"));
    return lines;
  }

  const traceContent =
    parsed === undefined
      ? rawContent
      : formatJsonTraceValue(parsed, maxWidth - 2);

  for (const rawLine of traceContent.split("\n")) {
    lines.push(...wrapTraceLine(rawLine, maxWidth));
  }

  lines.push(styleTraceFooter("╰──"));
  return lines;
}

/** Styles a trace-box footer line with dim cyan. */
export function styleTraceFooter(line: string): string {
  return `${ANSI_DIM}${ANSI_CYAN}${line}${ANSI_RESET}`;
}

/** Styles a trace-box header line with bold cyan. */
export function styleTraceHeader(line: string): string {
  return `${ANSI_BOLD}${ANSI_CYAN}${line}${ANSI_RESET}`;
}

/**
 * Styles a trace-box rail line: the leading `│` character gets bold cyan,
 * the rest is unstyled.
 */
export function styleTraceRail(line: string): string {
  if (!line.startsWith("│")) {
    return line;
  }

  return `${ANSI_CYAN}│${ANSI_RESET}${line.slice(1)}`;
}

/**
 * Wraps `text` to `maxWidth` characters per line, using `firstPrefix` on the
 * first line and `continuationPrefix` on subsequent lines.
 */
export function wrapLine(
  text: string,
  maxWidth: number,
  firstPrefix: string,
  continuationPrefix: string,
): string[] {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return [firstPrefix.trimEnd()];
  }

  const words = trimmedText.split(/\s+/u);
  const lines: string[] = [];
  let currentLine = "";
  let prefix = firstPrefix;

  for (const word of words) {
    const candidate =
      currentLine.length === 0 ? word : `${currentLine} ${word}`;
    if (candidate.length <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine.length > 0) {
      lines.push(`${prefix}${currentLine}`);
      prefix = continuationPrefix;
      currentLine = word;
      continue;
    }

    lines.push(`${prefix}${word}`);
    prefix = continuationPrefix;
  }

  if (currentLine.length > 0) {
    lines.push(`${prefix}${currentLine}`);
  }

  return lines;
}

/**
 * Wraps a single raw trace line, preserving JSON key alignment when the line
 * looks like `"key": value`.
 */
export function wrapTraceLine(text: string, maxWidth: number): string[] {
  const valuePrefixMatch = /^(\s*"[^"]+":\s+)(.*)$/u.exec(text);
  if (valuePrefixMatch) {
    const [, firstContentPrefix, valueText] = valuePrefixMatch;
    const continuationContentPrefix = " ".repeat(firstContentPrefix.length);
    return wrapLine(
      valueText,
      Math.max(12, maxWidth - firstContentPrefix.length - 2),
      `│ ${firstContentPrefix}`,
      `│ ${continuationContentPrefix}`,
    ).map(styleTraceRail);
  }

  const indentMatch = /^(\s*)(.*)$/u.exec(text);
  const firstContentPrefix = indentMatch?.[1] ?? "";
  const content = indentMatch?.[2] ?? text;

  return wrapLine(
    content,
    Math.max(12, maxWidth - firstContentPrefix.length - 2),
    `│ ${firstContentPrefix}`,
    `│ ${firstContentPrefix}`,
  ).map(styleTraceRail);
}

function formatDuration(durationMs: number): string {
  if (durationMs > 0 && durationMs < 1) {
    return "<1ms";
  }

  return durationMs >= 1000
    ? `${(durationMs / 1000).toFixed(2)}s`
    : `${Math.round(durationMs)}ms`;
}
