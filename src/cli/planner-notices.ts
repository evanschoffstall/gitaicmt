import { type AiOutputEvent } from "../commit-planning/orchestration.js";

export interface PlannerNoticeState {
  fallbackReason: null | string;
  retriedFallbackFinalization: boolean;
  usedFallbackFinalization: boolean;
}

interface PlannerDecisionPayload {
  decision?: unknown;
  reason?: unknown;
}

/** Creates per-command planner notice state from observed AI events. */
export function createPlannerNoticeState(): PlannerNoticeState {
  return {
    fallbackReason: null,
    retriedFallbackFinalization: false,
    usedFallbackFinalization: false,
  };
}

/** Returns a user-facing note when planner finalization degraded to heuristics. */
export function getPlannerFallbackNotice(
  state: PlannerNoticeState,
): null | string {
  if (!state.usedFallbackFinalization) {
    return null;
  }

  if (state.retriedFallbackFinalization) {
    return "Note: Final consolidation retried once after a transient planner failure, then fell back to heuristic ordering.";
  }

  switch (state.fallbackReason) {
    case "coverage-mismatch": {
      return "Note: Final consolidation fell back to heuristic ordering after the planner returned a coverage-mismatched plan.";
    }
    case "invalid-consolidation-json":
    case "invalid-consolidation-response": {
      return "Note: Final consolidation fell back to heuristic ordering after the planner returned an invalid plan.";
    }
    default: {
      return "Note: Final consolidation fell back to heuristic ordering after a planner model call failed.";
    }
  }
}

/** Records whether planner finalization had to fall back from model-driven consolidation. */
export function recordPlannerNotice(
  state: PlannerNoticeState,
  event: AiOutputEvent,
): void {
  if (event.kind !== "planner-decision") {
    return;
  }

  const decision = parsePlannerDecision(event.content);
  if (event.stage !== "consolidate") {
    return;
  }

  if (decision === "consolidation-retry-scheduled") {
    state.retriedFallbackFinalization = true;
    return;
  }

  if (decision === "consolidation-fallback") {
    state.fallbackReason = parsePlannerReason(event.content);
    state.usedFallbackFinalization = true;
  }
}

function parsePlannerDecision(content: string): null | string {
  try {
    const parsed = JSON.parse(content) as PlannerDecisionPayload;
    return typeof parsed.decision === "string" ? parsed.decision : null;
  } catch {
    return null;
  }
}

function parsePlannerReason(content: string): null | string {
  try {
    const parsed = JSON.parse(content) as PlannerDecisionPayload;
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}