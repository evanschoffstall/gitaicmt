/** Terminal block rendering: ANSI styling, line wrapping, and event-stat lines. */
import { wrapTokenizedTextBySeparatorPreference } from "../token-splitting.js";
import { formatJsonTraceValue } from "./json-trace.js";

type AiOutputEvent = import("../../commit-planning/openai-client.js").AiOutputEvent;

export const ANSI_BOLD = "\x1b[1m";
export const ANSI_CYAN = "\x1b[36m";
export const ANSI_DIM = "\x1b[2m";
export const ANSI_RED = "\x1b[31m";
export const ANSI_RESET = "\x1b[0m";
export const ANSI_YELLOW = "\x1b[33m";

export type TraceFrameSeverity = "error" | "info" | "warning";

/** Builds an event title, optionally appending a sequence number. */
export function buildEventTitle(
  event: AiOutputEvent,
  parsed: unknown,
  sequence?: number,
): string {
  const baseTitle = describeEvent(event, parsed);
  return sequence === undefined
    ? baseTitle
    : `${baseTitle} #${String(sequence)}`;
}

/** Resolves a human-friendly title for one AI output event. */
export function describeEvent(event: AiOutputEvent, parsed: unknown): string {
  if (event.kind === "planner-decision") {
    const decisionTitle = describePlannerDecision(parsed);
    if (decisionTitle) {
      return decisionTitle;
    }
  }

  return describeStage(event.stage);
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
  severity: TraceFrameSeverity = "info",
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
  return wrapLine(statsLine, maxWidth - 4, "│   ", "│     ").map((line) =>
    styleTraceRail(line, severity),
  );
}

/** Renders a full trace block (raw/JSON expansion) for the given event. */
export function formatTraceBlock(
  event: AiOutputEvent,
  parsed: unknown,
  maxWidth: number,
  sequence?: number,
): string[] {
  const title = `${buildEventTitle(event, parsed, sequence)} trace`;
  const severity = getEventFrameSeverity(event, parsed);
  const rawContent = event.content.trimEnd();
  const lines = [styleTraceHeader(`╭── ${title}`, severity)];
  lines.push(...formatEventStatLines(event, maxWidth, severity));

  if (rawContent.length === 0) {
    lines.push(
      styleTraceRail("│ (empty)", severity),
      styleTraceFooter("╰──", severity),
    );
    return lines;
  }

  const traceContent =
    parsed === undefined
      ? rawContent
      : formatJsonTraceValue(parsed, maxWidth - 2);

  for (const rawLine of traceContent.split("\n")) {
    lines.push(...wrapTraceLine(rawLine, maxWidth, severity));
  }

  lines.push(styleTraceFooter("╰──", severity));
  return lines;
}

export function getEventFrameSeverity(
  event: AiOutputEvent,
  parsed: unknown,
): TraceFrameSeverity {
  const decision = getPlannerDecisionName(parsed);
  if (
    decision?.endsWith("-failed") ||
    decision?.endsWith("-fallback") ||
    decision === "grouping-fallback"
  ) {
    return "error";
  }
  if (
    decision?.endsWith("-retry-scheduled") ||
    decision === "cluster-stop" ||
    decision === "consolidation-stop"
  ) {
    return "warning";
  }

  return "info";
}

/**
 * Returns the stable counter bucket for one verbose event so unrelated event
 * families do not consume the same sequence numbers.
 */
export function getEventSequenceKey(
  event: AiOutputEvent,
  parsed: unknown,
): string {
  if (event.kind === "planner-decision") {
    const decision = getPlannerDecisionName(parsed);
    if (decision) {
      return `planner:${decision}`;
    }
  }

  return `stage:${event.stage}`;
}

/** Styles a trace-box footer line with dim cyan. */
export function styleTraceFooter(
  line: string,
  severity: TraceFrameSeverity = "info",
): string {
  return `${ANSI_DIM}${getSeverityColor(severity)}${line}${ANSI_RESET}`;
}

/** Styles a trace-box header line with bold cyan. */
export function styleTraceHeader(
  line: string,
  severity: TraceFrameSeverity = "info",
): string {
  return `${ANSI_BOLD}${getSeverityColor(severity)}${line}${ANSI_RESET}`;
}

/**
 * Styles a trace-box rail line: the leading `│` character gets bold cyan,
 * the rest is unstyled.
 */
export function styleTraceRail(
  line: string,
  severity: TraceFrameSeverity = "info",
): string {
  if (!line.startsWith("│")) {
    return line;
  }

  return `${getSeverityColor(severity)}│${ANSI_RESET}${line.slice(1)}`;
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
  const wrappedContentLines = wrapTokenizedTextBySeparatorPreference(text, maxWidth);
  if (wrappedContentLines.length === 1 && wrappedContentLines[0].length === 0) {
    return [firstPrefix.trimEnd()];
  }

  return wrappedContentLines.map((line, index) =>
    `${index === 0 ? firstPrefix : continuationPrefix}${line}`,
  );
}

/**
 * Wraps a single raw trace line, preserving JSON key alignment when the line
 * looks like `"key": value`.
 */
export function wrapTraceLine(
  text: string,
  maxWidth: number,
  severity: TraceFrameSeverity = "info",
): string[] {
  const valuePrefixMatch = /^(\s*"[^"]+":\s+)(.*)$/u.exec(text);
  if (valuePrefixMatch) {
    const [, firstContentPrefix, valueText] = valuePrefixMatch;
    const continuationContentPrefix = " ".repeat(firstContentPrefix.length);
    return wrapLine(
      valueText,
      Math.max(12, maxWidth - firstContentPrefix.length - 2),
      `│ ${firstContentPrefix}`,
      `│ ${continuationContentPrefix}`,
    ).map((line) => styleTraceRail(line, severity));
  }

  const indentMatch = /^(\s*)(.*)$/u.exec(text);
  const firstContentPrefix = indentMatch?.[1] ?? "";
  const content = indentMatch?.[2] ?? text;

  return wrapLine(
    content,
    Math.max(12, maxWidth - firstContentPrefix.length - 2),
    `│ ${firstContentPrefix}`,
    `│ ${firstContentPrefix}`,
  ).map((line) => styleTraceRail(line, severity));
}

function describePlannerDecision(parsed: unknown): null | string {
  const decision = getPlannerDecisionName(parsed);
  if (!decision) {
    return null;
  }

  switch (decision) {
    case "batched-plan-finalization": {
      return "Batched plan finalization";
    }
    case "cluster-failed": {
      return "Cluster failed";
    }
    case "cluster-fallback": {
      return "Cluster fallback";
    }
    case "cluster-pass": {
      return "Cluster pass";
    }
    case "cluster-stop": {
      return "Cluster stop";
    }
    case "consolidation-failed": {
      return "Consolidation failed";
    }
    case "consolidation-fallback": {
      return "Consolidation fallback";
    }
    case "consolidation-noop": {
      return "Consolidation noop";
    }
    case "consolidation-pass": {
      return "Consolidation pass";
    }
    case "consolidation-retry-scheduled": {
      return "Consolidation retry scheduled";
    }
    case "consolidation-stop": {
      return "Consolidation stop";
    }
    case "dependency-ordering": {
      return "Dependency ordering";
    }
    case "finalize-planned-groups": {
      return "Finalize planned groups";
    }
    case "repartition-after-consolidation": {
      return "Repartition after consolidation";
    }
    case "skip-consolidation": {
      return "Skip consolidation";
    }
    default: {
      return decision
        .split("-")
        .map((segment) => segment[0].toUpperCase() + segment.slice(1))
        .join(" ");
    }
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs > 0 && durationMs < 1) {
    return "<1ms";
  }

  return durationMs >= 1000
    ? `${(durationMs / 1000).toFixed(2)}s`
    : `${Math.round(durationMs)}ms`;
}

function getPlannerDecisionName(parsed: unknown): null | string {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("decision" in parsed) ||
    typeof parsed.decision !== "string"
  ) {
    return null;
  }

  return parsed.decision;
}

function getSeverityColor(severity: TraceFrameSeverity): string {
  switch (severity) {
    case "error": {
      return ANSI_RED;
    }
    case "warning": {
      return ANSI_YELLOW;
    }
    default: {
      return ANSI_CYAN;
    }
  }
}
