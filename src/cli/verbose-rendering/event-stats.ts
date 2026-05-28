type AiOutputEvent =
  import("../../commit-planning/openai-client.js").AiOutputEvent;

const PLANNER_DECISION_TITLES = {
  "batched-plan-finalization": "Batched plan finalization",
  "cluster-failed": "Cluster failed",
  "cluster-fallback": "Cluster fallback",
  "cluster-pass": "Cluster pass",
  "cluster-stop": "Cluster stop",
  "consolidation-failed": "Consolidation failed",
  "consolidation-fallback": "Consolidation fallback",
  "consolidation-noop": "Consolidation noop",
  "consolidation-pass": "Consolidation pass",
  "consolidation-retry-scheduled": "Consolidation retry scheduled",
  "consolidation-stop": "Consolidation stop",
  "dependency-ordering": "Dependency ordering",
  "finalize-planned-groups": "Finalize planned groups",
  "repartition-after-consolidation": "Repartition after consolidation",
  "skip-consolidation": "Skip consolidation",
} satisfies Record<string, string>;

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

  const title = Object.hasOwn(PLANNER_DECISION_TITLES, decision)
    ? PLANNER_DECISION_TITLES[decision as keyof typeof PLANNER_DECISION_TITLES]
    : undefined;
  return title ?? formatPlannerDecisionTitle(decision);
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

  return parsed.decision;
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
