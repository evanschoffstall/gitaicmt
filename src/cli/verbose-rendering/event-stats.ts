type AiOutputEvent =
  import("../../commit-planning/openai-client.js").AiOutputEvent;

const DECISION_SEPARATOR_RE = /[\s_]+/g;
const NON_DECISION_CHAR_RE = /[^a-z0-9-]/g;
const DUPLICATE_DASH_RE = /-+/g;

export function collectEventStatParts(event: AiOutputEvent): {
  summaryParts: string[];
  usageParts: string[];
} {
  const summaryParts = [
    event.kind,
    event.transport,
    typeof event.durationMs === "number"
      ? formatDuration(event.durationMs)
      : undefined,
  ].filter((entry): entry is string => typeof entry === "string");
  const usageParts = [
    formatUsagePart(event.requestCountDelta, "req"),
    formatUsagePart(event.inputTokens, "in"),
    formatUsagePart(event.outputTokens, "out"),
    formatUsagePart(event.totalTokens, "tok"),
  ].filter((entry): entry is string => typeof entry === "string");

  return { summaryParts, usageParts };
}

export function describePlannerDecision(parsed: unknown): null | string {
  const decision = getPlannerDecisionName(parsed);
  if (!decision) {
    return null;
  }

  const baseTitle = formatPlannerDecisionTitle(decision);
  return isPlannerDecisionResultsSummary(parsed)
    ? `${baseTitle} results`
    : baseTitle;
}

export function getPlannerDecisionName(parsed: unknown): null | string {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("decision" in parsed) ||
    typeof parsed.decision !== "string"
  ) {
    return null;
  }

  return toNormalizedPlannerDecisionId(parsed.decision);
}

export function toNormalizedPlannerDecisionId(value: unknown): null | string {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(DECISION_SEPARATOR_RE, "-")
    .replace(NON_DECISION_CHAR_RE, "")
    .replace(DUPLICATE_DASH_RE, "-")
    .replace(/^-|-$/g, "");
  return normalized.length === 0 ? null : normalized;
}

function formatDuration(durationMs: number): string {
  if (durationMs > 0 && durationMs < 1) {
    return "<1ms";
  }

  return durationMs >= 1000
    ? `${(durationMs / 1000).toFixed(2)}s`
    : `${Math.round(durationMs)}ms`;
}

function formatPlannerDecisionTitle(decision: string): string {
  return decision
    .split("-")
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatUsagePart(
  value: number | undefined,
  suffix: string,
): string | undefined {
  return typeof value === "number" ? `${String(value)} ${suffix}` : undefined;
}

function isPlannerDecisionResultsSummary(parsed: unknown): boolean {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "summaryKind" in parsed &&
    parsed.summaryKind === "results"
  );
}
