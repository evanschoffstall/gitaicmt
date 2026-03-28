import {
  createPlannerNoticeState,
  getPlannerFallbackNotice,
  recordPlannerNotice,
} from "../src/cli/planner-notices.js";

const { describe, expect, test } = await import("bun:test");

describe("planner-notices", () => {
  test("mentions retry exhaustion when final consolidation retried before falling back", () => {
    const state = createPlannerNoticeState();

    recordPlannerNotice(state, {
      content: JSON.stringify({
        decision: "consolidation-retry-scheduled",
        failedAttemptCount: 1,
        maxAttemptCount: 2,
      }),
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });
    recordPlannerNotice(state, {
      content: JSON.stringify({
        decision: "consolidation-fallback",
        reason: "retry-exhausted-call-failed",
      }),
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });

    expect(getPlannerFallbackNotice(state)).toBe(
      "Note: Final consolidation retried once after a transient planner failure, then fell back to heuristic ordering.",
    );
  });

  test("records finalization fallback notices from consolidate-stage planner decisions", () => {
    const state = createPlannerNoticeState();

    recordPlannerNotice(state, {
      content: JSON.stringify({
        decision: "consolidation-fallback",
        reason: "consolidation-call-failed",
      }),
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });

    expect(getPlannerFallbackNotice(state)).toBe(
      "Note: Final consolidation fell back to heuristic ordering after a planner model call failed.",
    );
  });

  test("ignores consolidation failure events that do not degrade into fallback finalization", () => {
    const state = createPlannerNoticeState();

    recordPlannerNotice(state, {
      content: JSON.stringify({
        decision: "consolidation-failed",
        reason: "retry-exhausted-call-failed",
      }),
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });

    expect(getPlannerFallbackNotice(state)).toBeNull();
  });

  test("explains invalid consolidation output distinctly from call failures", () => {
    const state = createPlannerNoticeState();

    recordPlannerNotice(state, {
      content: JSON.stringify({
        decision: "consolidation-fallback",
        reason: "invalid-consolidation-response",
      }),
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });

    expect(getPlannerFallbackNotice(state)).toBe(
      "Note: Final consolidation fell back to heuristic ordering after the planner returned an invalid plan.",
    );
  });

  test("explains coverage mismatches distinctly from call failures", () => {
    const state = createPlannerNoticeState();

    recordPlannerNotice(state, {
      content: JSON.stringify({
        decision: "consolidation-fallback",
        reason: "coverage-mismatch",
      }),
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });

    expect(getPlannerFallbackNotice(state)).toBe(
      "Note: Final consolidation fell back to heuristic ordering after the planner returned a coverage-mismatched plan.",
    );
  });

  test("ignores unrelated planner decisions", () => {
    const state = createPlannerNoticeState();

    recordPlannerNotice(state, {
      content: JSON.stringify({ decision: "dependency-ordering" }),
      kind: "planner-decision",
      stage: "consolidate",
      transport: "internal",
    });

    expect(getPlannerFallbackNotice(state)).toBeNull();
  });
});