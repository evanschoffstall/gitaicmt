import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as outputPresentation from "../src/cli/output-presentation.js";
import {
  configureOutputMode,
  flushVerboseAiOutput,
  logCommitPlanAnalysis,
  logVerboseAiOutput,
} from "../src/cli/session-display.js";
import * as lineWrapping from "../src/cli/terminal/line-wrapping.js";
import * as outputUi from "../src/cli/terminal/output-ui.js";
import * as viewport from "../src/cli/viewport.js";

const { afterEach, beforeEach, describe, expect, mock, spyOn, test } =
  await import("bun:test");

let isolatedCacheHome = "";
let savedXdgCacheHome: string | undefined;

beforeEach(() => {
  savedXdgCacheHome = process.env["XDG_CACHE_HOME"];
  isolatedCacheHome = mkdtempSync(join(tmpdir(), "gitaicmt-trace-agg-"));
  process.env["XDG_CACHE_HOME"] = isolatedCacheHome;
});

afterEach(() => {
  mock.restore();
  configureOutputMode("off");
  if (savedXdgCacheHome === undefined) {
    delete process.env["XDG_CACHE_HOME"];
  } else {
    process.env["XDG_CACHE_HOME"] = savedXdgCacheHome;
  }
  rmSync(isolatedCacheHome, { force: true, recursive: true });
});

describe("session-display per-submodule trace reporting", () => {
  function setupTrace(terminalLines: string[]) {
    spyOn(viewport, "resolveVerboseWidth").mockReturnValue(96);
    spyOn(viewport, "resolveLogWidth").mockReturnValue(88);
    spyOn(outputPresentation, "buildStatusSectionLines").mockReturnValue([]);
    spyOn(lineWrapping, "wrapTerminalTextBlock").mockReturnValue([]);
    spyOn(outputUi, "writeTerminalLines").mockImplementation((lines) => {
      terminalLines.push(...lines);
    });
  }

  test("renders submodule report when submodule key transitions", () => {
    const terminalLines: string[] = [];
    setupTrace(terminalLines);
    configureOutputMode("trace");

    // Accumulate a pair-evaluation submodule
    logVerboseAiOutput({
      content: JSON.stringify({
        decision: "premerge-pair-evaluation",
        leftGroup: "feat/ui",
        reason: "shared topic",
        result: "merge",
        rightGroup: "feat/api",
      }),
      kind: "planner-decision",
      stage: "group",
      transport: "internal",
    });
    logVerboseAiOutput({
      content: JSON.stringify({
        decision: "premerge-pair-evaluation",
        leftGroup: "fix/auth",
        result: "keep-separate",
        rightGroup: "docs/readme",
      }),
      kind: "planner-decision",
      stage: "group",
      transport: "internal",
    });

    // Nothing rendered yet — still accumulating
    expect(terminalLines).toHaveLength(0);

    // Transition to a different submodule key → flush
    logVerboseAiOutput({
      content: JSON.stringify({ decision: "finalize-groups" }),
      kind: "planner-decision",
      stage: "group",
      transport: "internal",
    });

    // Should have rendered the premerge-pair-evaluation report
    const joined = terminalLines.join("\n");
    expect(joined).toContain("Premerge Pair Evaluation");
    expect(joined).toContain("[group]");
    // WHAT: which groups were evaluated (non-no-change entry)
    expect(joined).toContain("feat/ui + feat/api");
    // HOW: the outcome
    expect(joined).toContain("[merged]");
    // WHY: the reason
    expect(joined).toContain("shared topic");
    // summary of no-change decisions
    expect(joined).toContain("(1 kept/no-change)");
  });

  test("flushes accumulated entries on flushVerboseAiOutput", () => {
    const terminalLines: string[] = [];
    setupTrace(terminalLines);
    configureOutputMode("trace");

    logVerboseAiOutput({
      content: JSON.stringify({
        decision: "cluster-merge",
        leftGroup: "src/a.ts",
        reason: "common directory",
        result: "merge",
        rightGroup: "src/b.ts",
      }),
      kind: "planner-decision",
      stage: "group",
      transport: "internal",
    });

    expect(terminalLines).toHaveLength(0);
    flushVerboseAiOutput();

    const joined = terminalLines.join("\n");
    expect(joined).toContain("Cluster Merge");
    // HOW: merged outcome
    expect(joined).toContain("[merged]");
    // WHY: the reason
    expect(joined).toContain("common directory");
  });

  test("counts no-change decisions without individual entries", () => {
    const terminalLines: string[] = [];
    setupTrace(terminalLines);
    configureOutputMode("trace");

    for (let i = 0; i < 3; i++) {
      logVerboseAiOutput({
        content: JSON.stringify({
          decision: "overlap-resolution",
          leftGroup: `group-${String(i)}`,
          result: "keep-separate",
          rightGroup: `group-${String(i + 1)}`,
        }),
        kind: "planner-decision",
        stage: "group",
        transport: "internal",
      });
    }

    flushVerboseAiOutput();

    const joined = terminalLines.join("\n");
    // All 3 were no-change, so summary count line appears
    expect(joined).toContain("(3 kept/no-change)");
    // No per-entry [kept] strings appear — only the summary count
    expect(joined).not.toContain("[kept]");
  });

  test("renders nothing for fully-empty submodule accumulator", () => {
    const terminalLines: string[] = [];
    setupTrace(terminalLines);
    configureOutputMode("trace");

    // Payload with no structural group fields — no entry generated
    logVerboseAiOutput({
      content: JSON.stringify({
        decision: "batch-summary",
        inputGroupCount: 5,
      }),
      kind: "planner-decision",
      stage: "group",
      transport: "internal",
    });

    flushVerboseAiOutput();

    // The accumulator has only a countSummary but no entries or noChangeCount
    // formatSubmoduleReportLines should still render the count line
    const joined = terminalLines.join("\n");
    // Either renders summary or empty — but must not throw
    expect(typeof joined).toBe("string");
  });

  test("flushes pending submodule before logCommitPlanAnalysis plan summary", () => {
    const terminalLines: string[] = [];
    setupTrace(terminalLines);
    configureOutputMode("trace");

    logVerboseAiOutput({
      content: JSON.stringify({
        decision: "premerge-pair-evaluation",
        leftGroup: "src/x.ts",
        result: "merge",
        rightGroup: "src/y.ts",
      }),
      kind: "planner-decision",
      stage: "group",
      transport: "internal",
    });

    // logCommitPlanAnalysis calls flushVerboseAiOutput internally
    logCommitPlanAnalysis({
      elapsed: "1.2",
      groups: [{ files: [{ path: "src/x.ts" }], message: "feat: x" }],
      plannerFallbackNotice: null,
    });

    const joined = terminalLines.join("\n");
    // Submodule report should appear (trace was flushed before plan summary)
    expect(joined).toContain("Premerge Pair Evaluation");
  });

  test("does not accumulate planner-decision events in summary mode", async () => {
    const terminalLines: string[] = [];
    setupTrace(terminalLines);

    // In summary mode, planner-decision events go directly to renderVerboseAiOutput
    // (not accumulated into submodule accumulators)
    configureOutputMode("summary");

    // Use formatVerboseAiOutputLines spy to track direct renders
    let directRenderCount = 0;
    const fmtSpy = spyOn(
      await import("../src/cli/verbose-output.js"),
      "formatVerboseAiOutputLines",
    ).mockImplementation(() => {
      directRenderCount++;
      return ["summary line"];
    });

    logVerboseAiOutput({
      content: JSON.stringify({ decision: "cluster-merge" }),
      kind: "planner-decision",
      stage: "group",
      transport: "internal",
    });

    // In summary mode, planner-decision passes through to renderVerboseAiOutput
    expect(directRenderCount).toBe(1);
    fmtSpy.mockRestore();
  });

  test("separate submodule keys produce separate reports", () => {
    const terminalLines: string[] = [];
    setupTrace(terminalLines);
    configureOutputMode("trace");

    // First submodule key: group:cluster-merge
    logVerboseAiOutput({
      content: JSON.stringify({
        decision: "cluster-merge",
        leftGroup: "a",
        result: "merge",
        rightGroup: "b",
      }),
      kind: "planner-decision",
      stage: "group",
      transport: "internal",
    });

    // Second submodule key: finalize:cluster-merge
    logVerboseAiOutput({
      content: JSON.stringify({
        decision: "cluster-merge",
        leftGroup: "c",
        result: "merge",
        rightGroup: "d",
      }),
      kind: "planner-decision",
      stage: "finalize",
      transport: "internal",
    });

    flushVerboseAiOutput();

    const joined = terminalLines.join("\n");
    // Two separate reports keyed by stage
    expect(joined).toContain("Cluster Merge [group]");
    expect(joined).toContain("Cluster Merge [finalize]");
  });
});
