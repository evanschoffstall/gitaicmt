import {
  accumulateSubmoduleEntry,
  buildDecisionTitle,
  createSubmoduleAccumulator,
  extractSubmoduleEntry,
  formatSubmoduleReportLines,
  type SubmoduleAccumulator,
} from "../src/cli/trace/submodule/index.js";

const { describe, expect, test } = await import("bun:test");

// ─── extractSubmoduleEntry ─────────────────────────────────────────────────

describe("extractSubmoduleEntry", () => {
  test("pair evaluation merge → entry with merged outcome", () => {
    const result = extractSubmoduleEntry({
      decision: "premerge-pair-evaluation",
      leftGroup: "feat/ui",
      reason: "shared topic",
      result: "merge",
      rightGroup: "feat/api",
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("merged");
    expect(result!.entry.before).toContain("feat/ui");
    expect(result!.entry.why).toBe("shared topic");
    expect(result!.isNoChange).toBe(false);
  });

  test("pair evaluation keep-separate → isNoChange=true", () => {
    const result = extractSubmoduleEntry({
      decision: "premerge-pair-evaluation",
      leftGroup: "fix/auth",
      result: "keep-separate",
      rightGroup: "docs/readme",
    });
    expect(result).not.toBeNull();
    expect(result!.isNoChange).toBe(true);
    expect(result!.entry.outcome).toBe("kept");
  });

  test("adjacent merge (candidateGroup+previousGroup) → entry with after", () => {
    const result = extractSubmoduleEntry({
      candidateGroup: "src/components",
      decision: "adjacent-merge",
      previousGroup: "src/utils",
      result: "merge",
    });
    expect(result).not.toBeNull();
    expect(result!.entry.before).toContain("src/components");
    expect(result!.entry.after).toContain("src/utils");
    expect(result!.entry.outcome).toBe("merged");
    expect(result!.isNoChange).toBe(false);
  });

  test("support attachment (supportGroup+targetGroup) → entry", () => {
    const result = extractSubmoduleEntry({
      decision: "support-attachment",
      result: "attach",
      supportGroup: "tests/unit",
      targetGroup: "src/feature",
    });
    expect(result).not.toBeNull();
    expect(result!.entry.before).toContain("tests/unit");
    expect(result!.entry.after).toContain("src/feature");
    expect(result!.entry.outcome).toBe("attached");
  });

  test("single-group split (inputGroup → outputGroups, count>1) → split", () => {
    const result = extractSubmoduleEntry({
      decision: "group-split",
      inputGroup: "src/monolith",
      outputGroups: ["src/part-a", "src/part-b", "src/part-c"],
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("split");
    expect(result!.entry.after).toBe("3 commits");
    expect(result!.isNoChange).toBe(false);
  });

  test("single-group preserve (inputGroup, outputGroups length=1) → kept", () => {
    const result = extractSubmoduleEntry({
      decision: "group-resolution",
      inputGroup: "src/feature",
      outputGroups: ["src/feature"],
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("kept");
    expect(result!.isNoChange).toBe(true);
  });

  test("batch transform (inputGroups → outputGroups, different counts) → entry", () => {
    const result = extractSubmoduleEntry({
      decision: "batch-consolidation",
      inputGroups: ["a", "b", "c"],
      outputGroups: ["a+b", "c"],
    });
    expect(result).not.toBeNull();
    expect(result!.entry.before).toBe("3 groups");
    expect(result!.entry.after).toBe("2 groups");
    expect(result!.entry.outcome).toBe("merged");
    expect(result!.isNoChange).toBe(false);
  });

  test("batch no-change (same input/output count) → kept", () => {
    const result = extractSubmoduleEntry({
      decision: "batch-validation",
      inputGroups: ["a", "b"],
      outputGroups: ["a", "b"],
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("kept");
    expect(result!.isNoChange).toBe(true);
  });

  test("count-only payload (inputGroupCount only, few fields) → null", () => {
    const result = extractSubmoduleEntry({
      decision: "batch-summary",
      inputGroupCount: 5,
    });
    expect(result).toBeNull();
  });

  test("message-generation payload → transformed entry", () => {
    const result = extractSubmoduleEntry({
      decision: "message-generation",
      fileCount: 3,
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
      outputSubject: "feat: implement login flow",
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("transformed");
    expect(result!.entry.before).toContain("3 file(s)");
    expect(result!.entry.after).toBe("feat: implement login flow");
    expect(result!.isNoChange).toBe(false);
  });

  test("unknown payload without recognized fields → null", () => {
    const result = extractSubmoduleEntry({
      decision: "some-custom-decision",
      randomField: 42,
    });
    expect(result).toBeNull();
  });
});

// ─── accumulateSubmoduleEntry ──────────────────────────────────────────────

describe("accumulateSubmoduleEntry", () => {
  test("pushes non-no-change entry into entries array", () => {
    const acc = createSubmoduleAccumulator("group", "cluster-merge");
    accumulateSubmoduleEntry(acc, {
      decision: "cluster-merge",
      leftGroup: "a",
      result: "merge",
      rightGroup: "b",
    });
    expect(acc.entries).toHaveLength(1);
    expect(acc.noChangeCount).toBe(0);
  });

  test("increments noChangeCount for no-change entries", () => {
    const acc = createSubmoduleAccumulator("group", "cluster-merge");
    accumulateSubmoduleEntry(acc, {
      decision: "cluster-merge",
      leftGroup: "a",
      result: "keep-separate",
      rightGroup: "b",
    });
    expect(acc.entries).toHaveLength(0);
    expect(acc.noChangeCount).toBe(1);
  });

  test("sets countSummary for count-only payloads with input+output counts", () => {
    const acc = createSubmoduleAccumulator("group", "batch-summary");
    accumulateSubmoduleEntry(acc, {
      decision: "batch-summary",
      inputGroupCount: 8,
      outputGroupCount: 5,
    });
    expect(acc.countSummary).toBe("8 → 5 groups");
    expect(acc.entries).toHaveLength(0);
  });

  test("ignores null-result payloads without throwing", () => {
    const acc = createSubmoduleAccumulator("group", "unknown-decision");
    expect(() => {
      accumulateSubmoduleEntry(acc, { decision: "unknown-decision" });
    }).not.toThrow();
    expect(acc.entries).toHaveLength(0);
    expect(acc.noChangeCount).toBe(0);
  });
});

// ─── buildDecisionTitle ────────────────────────────────────────────────────

describe("buildDecisionTitle", () => {
  test("converts kebab-case to Title Case", () => {
    expect(buildDecisionTitle("premerge-pair-evaluation")).toBe(
      "Premerge Pair Evaluation",
    );
  });

  test("single word", () => {
    expect(buildDecisionTitle("merge")).toBe("Merge");
  });

  test("already title-ish stays stable", () => {
    expect(buildDecisionTitle("cluster-stop")).toBe("Cluster Stop");
  });

  test("empty string returns empty", () => {
    expect(buildDecisionTitle("")).toBe("");
  });

  test("multiple hyphens", () => {
    expect(buildDecisionTitle("a-b-c-d")).toBe("A B C D");
  });
});

// ─── formatSubmoduleReportLines ────────────────────────────────────────────

describe("formatSubmoduleReportLines", () => {
  test("returns empty array for empty accumulator", () => {
    const acc = createSubmoduleAccumulator("group", "cluster-merge");
    const lines = formatSubmoduleReportLines(acc, 80);
    expect(lines).toHaveLength(0);
  });

  test("renders header and footer for non-empty accumulator", () => {
    const acc = createSubmoduleAccumulator("group", "cluster-merge");
    accumulateSubmoduleEntry(acc, {
      decision: "cluster-merge",
      leftGroup: "feat/login",
      result: "merge",
      rightGroup: "feat/auth",
    });
    const lines = formatSubmoduleReportLines(acc, 80);
    const joined = lines.join("\n");
    expect(joined).toContain("╭──");
    expect(joined).toContain("╰──");
    expect(joined).toContain("Cluster Merge");
    expect(joined).toContain("[group]");
  });

  test("shows kept/no-change count when nonzero", () => {
    const acc: SubmoduleAccumulator = createSubmoduleAccumulator(
      "group",
      "overlap-resolution",
    );
    acc.noChangeCount = 7;
    const lines = formatSubmoduleReportLines(acc, 80);
    const joined = lines.join("\n");
    expect(joined).toContain("7 kept/no-change");
  });

  test("shows countSummary when set", () => {
    const acc = createSubmoduleAccumulator("group", "batch-summary");
    acc.countSummary = "10 → 6 groups";
    const lines = formatSubmoduleReportLines(acc, 80);
    const joined = lines.join("\n");
    expect(joined).toContain("10 → 6 groups");
  });

  test("renders entry with after line when after is present", () => {
    const acc = createSubmoduleAccumulator("finalize", "adjacent-merge");
    accumulateSubmoduleEntry(acc, {
      candidateGroup: "src/a",
      decision: "adjacent-merge",
      previousGroup: "src/b",
      result: "merge",
    });
    const lines = formatSubmoduleReportLines(acc, 80);
    const joined = lines.join("\n");
    expect(joined).toContain("→");
  });

  test("truncates very long group names to max width", () => {
    const longName = "a".repeat(200);
    const acc = createSubmoduleAccumulator("group", "pair-eval");
    accumulateSubmoduleEntry(acc, {
      decision: "pair-eval",
      leftGroup: longName,
      result: "merge",
      rightGroup: "b",
    });
    const lines = formatSubmoduleReportLines(acc, 60);
    for (const line of lines) {
      // strip ANSI escapes for width check
      // eslint-disable-next-line no-control-regex
      const stripped = line.replace(/\u001b\[[0-9;]*m/g, "");
      expect(stripped.length).toBeLessThanOrEqual(70); // some tolerance for box chars
    }
  });

  test("renders WHY reason line when entry has why field", () => {
    const acc = createSubmoduleAccumulator("group", "cluster-merge");
    accumulateSubmoduleEntry(acc, {
      decision: "cluster-merge",
      leftGroup: "feat/login",
      reason: "shared directory ownership",
      result: "merge",
      rightGroup: "feat/auth",
    });
    const lines = formatSubmoduleReportLines(acc, 80);
    const joined = lines.join("\n");
    expect(joined).toContain("reason: shared directory ownership");
  });

  test("renders WHAT/HOW/WHY for merged pair entry", () => {
    const acc = createSubmoduleAccumulator("group", "premerge-pair-evaluation");
    accumulateSubmoduleEntry(acc, {
      decision: "premerge-pair-evaluation",
      leftGroup: "feat/ui",
      reason: "shared topic",
      result: "merge",
      rightGroup: "feat/api",
    });
    const lines = formatSubmoduleReportLines(acc, 80);
    const joined = lines.join("\n");
    // WHAT: which groups
    expect(joined).toContain("feat/ui + feat/api");
    // HOW: outcome tag
    expect(joined).toContain("[merged]");
    // WHY: reason
    expect(joined).toContain("shared topic");
  });

  test("no-change entries counted but not rendered as individual rows", () => {
    const acc = createSubmoduleAccumulator("group", "overlap-resolution");
    for (let i = 0; i < 4; i++) {
      accumulateSubmoduleEntry(acc, {
        decision: "overlap-resolution",
        leftGroup: `a-${String(i)}`,
        result: "keep-separate",
        rightGroup: `b-${String(i)}`,
      });
    }
    const lines = formatSubmoduleReportLines(acc, 80);
    const joined = lines.join("\n");
    expect(joined).toContain("(4 kept/no-change)");
    // No [kept] outcome tag in individual entry rows
    expect(joined).not.toContain("[kept]");
  });
});

// ─── describeGroupRecord (via extractSubmoduleEntry) ──────────────────────

describe("describeGroupRecord — group shape recognition", () => {
  test("uses subject field from summarizeTraceGroup-style payload", () => {
    const result = extractSubmoduleEntry({
      decision: "pair-eval",
      leftGroup: {
        fileCount: 2,
        filePreview: ["src/a.ts"],
        subject: "feat: login flow",
      },
      result: "merge",
      rightGroup: {
        fileCount: 1,
        filePreview: ["src/b.ts"],
        subject: "feat: auth token",
      },
    });
    expect(result).not.toBeNull();
    expect(result!.entry.before).toBe("feat: login flow + feat: auth token");
  });

  test("falls back to message field when subject is absent", () => {
    const result = extractSubmoduleEntry({
      decision: "pair-eval",
      leftGroup: {
        files: [{ path: "src/a.ts" }],
        message: "feat: login\n\nBody text",
      },
      result: "merge",
      rightGroup: { files: [{ path: "src/b.ts" }], message: "feat: auth" },
    });
    expect(result).not.toBeNull();
    // Only first line of message is used as the subject
    expect(result!.entry.before).toBe("feat: login + feat: auth");
  });

  test("message field: uses only first line (strips body)", () => {
    const result = extractSubmoduleEntry({
      decision: "pair-eval",
      leftGroup: { message: "fix: handle null\n\nDetailed explanation here." },
      result: "merge",
      rightGroup: { message: "fix: edge case" },
    });
    expect(result).not.toBeNull();
    expect(result!.entry.before).toContain("fix: handle null");
    expect(result!.entry.before).not.toContain("Detailed explanation");
  });

  test("falls back to id+label field when subject and message absent", () => {
    const result = extractSubmoduleEntry({
      decision: "pair-eval",
      leftGroup: { id: 42, label: "commit" },
      result: "merge",
      rightGroup: { id: 43, label: "commit" },
    });
    expect(result).not.toBeNull();
    expect(result!.entry.before).toBe("commit(42) + commit(43)");
  });

  test("falls back to JSON.stringify when no recognized field", () => {
    const result = extractSubmoduleEntry({
      decision: "pair-eval",
      leftGroup: { unknownField: "x" },
      result: "merge",
      rightGroup: { unknownField: "y" },
    });
    expect(result).not.toBeNull();
    // Falls back to JSON.stringify
    expect(result!.entry.before).toContain("unknownField");
  });
});

// ─── resolveOutcome — field name coverage ────────────────────────────────

describe("resolveOutcome — resolution field aliases", () => {
  test("reads outcome from `resolution` field (production planner events use this)", () => {
    // Real planner events like emitPremergePairEvaluationEvent use `resolution` not `result`
    const result = extractSubmoduleEntry({
      decision: "premerge-pair-evaluation",
      leftGroup: "feat/a",
      resolution: "merge",
      rightGroup: "feat/b",
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("merged");
    expect(result!.isNoChange).toBe(false);
  });

  test("resolution: keep-separate → kept → noChange (production payload shape)", () => {
    const result = extractSubmoduleEntry({
      decision: "premerge-pair-evaluation",
      leftGroup: "feat/a",
      resolution: "keep-separate",
      rightGroup: "feat/b",
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("kept");
    expect(result!.isNoChange).toBe(true);
  });

  test("reads outcome from `result` field (legacy / test payloads)", () => {
    const result = extractSubmoduleEntry({
      decision: "premerge-pair-evaluation",
      leftGroup: "feat/a",
      result: "keep-separate",
      rightGroup: "feat/b",
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("kept");
    expect(result!.isNoChange).toBe(true);
  });

  test("`result` field takes precedence over `resolution` when both present", () => {
    // result wins over resolution
    const result = extractSubmoduleEntry({
      decision: "premerge-pair-evaluation",
      leftGroup: "feat/a",
      resolution: "keep-separate",
      result: "merge",
      rightGroup: "feat/b",
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("merged");
  });

  test("no outcome field → defaults to per-extractor default", () => {
    // extractPairEntry default is "merged"
    const result = extractSubmoduleEntry({
      decision: "pair-eval",
      leftGroup: "feat/a",
      rightGroup: "feat/b",
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("merged");
  });

  test("accumulateSubmoduleEntry with `resolution` field correctly sets noChangeCount", () => {
    const acc = createSubmoduleAccumulator("group", "premerge-pair-evaluation");
    // Simulate real production payload using `resolution` field
    accumulateSubmoduleEntry(acc, {
      decision: "premerge-pair-evaluation",
      diagnostics: { sharedSubjectWordCount: 0 },
      leftGroup: "feat/a",
      resolution: "keep-separate",
      rightGroup: "feat/b",
    });
    accumulateSubmoduleEntry(acc, {
      decision: "premerge-pair-evaluation",
      diagnostics: { sharedSubjectWordCount: 1 },
      leftGroup: "feat/c",
      resolution: "merge",
      rightGroup: "feat/d",
    });
    expect(acc.entries).toHaveLength(1);
    expect(acc.entries[0]?.outcome).toBe("merged");
    expect(acc.noChangeCount).toBe(1);
    expect(acc.resolutionCounts["keep-separate"]).toBe(1);
    expect(acc.resolutionCounts["merge"]).toBe(1);
  });
});

// ─── Count-summary aliases and partial counts ─────────────────────────────
//
// Many internal planner events use alternative field names for the output
// group count (mergedGroupCount, finalGroupCount) or omit the output count
// entirely (cluster rejection, consolidation-stop from diminishing-returns).
// These regression tests ensure the accumulator correctly generates a
// countSummary instead of silently producing blank trace output.

describe("accumulateSubmoduleEntry — count-summary aliases and partial counts", () => {
  test("mergedGroupCount alias: cluster-pass produces N → M groups summary", () => {
    // Production shape from emitClusterProgressEvent
    const acc = createSubmoduleAccumulator("cluster", "cluster-pass");
    accumulateSubmoduleEntry(acc, {
      clusterCount: 5,
      decision: "cluster-pass",
      inputGroupCount: 28,
      mergedGroupCount: 24,
      pass: 0,
      rawMergedGroupCount: 23,
    });
    expect(acc.countSummary).toBe("28 → 24 groups");
    expect(acc.entries).toHaveLength(0);
  });

  test("mergedGroupCount alias: cluster-stop includes reason in summary", () => {
    // Production shape: stopped because semantic repartition undid the merge
    const acc = createSubmoduleAccumulator("cluster", "cluster-stop");
    accumulateSubmoduleEntry(acc, {
      clusterCount: 5,
      decision: "cluster-stop",
      inputGroupCount: 28,
      mergedGroupCount: 24,
      pass: 1,
      reason: "semantic-repartition-undid-merge",
      repartitionedGroupCount: 25,
    });
    expect(acc.countSummary).toBe(
      "28 → 24 groups (semantic-repartition-undid-merge)",
    );
    expect(acc.entries).toHaveLength(0);
  });

  test("finalGroupCount alias: finalize-planned-groups produces N → M groups summary", () => {
    // Production shape from emitFinalizePlannedGroupsEvent
    const acc = createSubmoduleAccumulator(
      "consolidate",
      "finalize-planned-groups",
    );
    accumulateSubmoduleEntry(acc, {
      decision: "finalize-planned-groups",
      diagnostics: { absorbedGroupCount: 3, sameSubjectMergedGroupCount: 2 },
      finalGroupCount: 28,
      finalGroups: [{ fileCount: 2, subject: "feat: x" }],
      inputGroupCount: 52,
      premergedGroupCount: 52,
      repartitionedGroupCount: 49,
    });
    expect(acc.countSummary).toBe("52 → 28 groups");
    expect(acc.entries).toHaveLength(0);
  });

  test("partial count: cluster-merge-resolution rejected shows N groups (rejected, reason)", () => {
    // Production shape: oversized cluster rejection — no outputGroupCount field
    const acc = createSubmoduleAccumulator(
      "cluster",
      "cluster-merge-resolution",
    );
    accumulateSubmoduleEntry(acc, {
      clusterCount: 5,
      decision: "cluster-merge-resolution",
      diagnostics: { oversizedCount: 1 },
      inputGroupCount: 28,
      largestClusterSize: 13,
      reason: "cluster-too-large",
      resolution: "rejected",
    });
    expect(acc.countSummary).toBe("28 groups (rejected, cluster-too-large)");
    expect(acc.entries).toHaveLength(0);
  });

  test("partial count: consolidation-stop (diminishing-returns) shows N groups (reason)", () => {
    // Production shape from emitConsolidationDiminishingReturnsStop — no outputGroupCount
    const acc = createSubmoduleAccumulator("consolidate", "consolidation-stop");
    accumulateSubmoduleEntry(acc, {
      decision: "consolidation-stop",
      inputGroupCount: 52,
      previousReduction: 1,
      reason: "diminishing-returns",
    });
    expect(acc.countSummary).toBe("52 groups (diminishing-returns)");
    expect(acc.entries).toHaveLength(0);
  });

  test("partial count: payload with group-level data is not treated as count-only", () => {
    // When inputGroupCount is present alongside group fields, the group
    // extraction path should win, not the partial count fallback.
    const acc = createSubmoduleAccumulator("consolidate", "batch-eval");
    accumulateSubmoduleEntry(acc, {
      decision: "batch-eval",
      inputGroupCount: 3,
      leftGroup: "feat/a",
      resolution: "merge",
      rightGroup: "feat/b",
    });
    // The pair extraction path wins; no countSummary is set
    expect(acc.countSummary).toBeUndefined();
    expect(acc.entries).toHaveLength(1);
  });

  test("full count with reason and resolution appended", () => {
    // cluster-merge-resolution accepted — has outputGroupCount + reason + resolution
    const acc = createSubmoduleAccumulator(
      "cluster",
      "cluster-merge-resolution",
    );
    accumulateSubmoduleEntry(acc, {
      clusterCount: 5,
      decision: "cluster-merge-resolution",
      diagnostics: {},
      inputGroupCount: 28,
      largestClusterSize: 6,
      outputGroupCount: 22,
      reason: "cluster-merge-accepted",
      resolution: "accepted",
    });
    expect(acc.countSummary).toBe(
      "28 → 22 groups (cluster-merge-accepted, accepted)",
    );
  });

  test("full count without reason/resolution has no parenthetical suffix", () => {
    // Standard consolidation-pass: only input and output counts
    const acc = createSubmoduleAccumulator("consolidate", "consolidation-pass");
    accumulateSubmoduleEntry(acc, {
      decision: "consolidation-pass",
      inputGroupCount: 40,
      outputGroupCount: 30,
    });
    expect(acc.countSummary).toBe("40 → 30 groups");
  });
});

// ─── Support attachment score — rejectionReason handling ──────────────────
//
// emitSupportAttachmentTraceEvent sets `rejectionReason` when the evaluation
// determined the support group must not be attached (style-without-coverage,
// weak-test-support, etc.).  We must surface those as no-change (kept) entries
// so repeated rejections compress into "(N kept/no-change)" instead of
// polluting the trace with hundreds of incorrect "[attached]" rows.

describe("extractSubmoduleEntry — support attachment rejectionReason", () => {
  test("rejectionReason present → outcome is kept (no-change), why is the reason", () => {
    const result = extractSubmoduleEntry({
      decision: "support-attachment-score",
      diagnostics: {},
      rejectionReason: "style-without-coverage",
      score: 0,
      supportGroup: { fileCount: 1, subject: "style(button): format" },
      targetGroup: { fileCount: 3, subject: "feat: add login" },
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("kept");
    expect(result!.isNoChange).toBe(true);
    expect(result!.entry.why).toBe("style-without-coverage");
    // before is the support group, after is the target
    expect(result!.entry.before).toContain("style(button)");
    expect(result!.entry.after).toContain("feat: add login");
  });

  test("rejectionReason empty string → treated as no rejection → outcome is attached", () => {
    const result = extractSubmoduleEntry({
      decision: "support-attachment-score",
      diagnostics: {},
      rejectionReason: "",
      score: 5,
      supportGroup: { fileCount: 1, subject: "test(auth): unit tests" },
      targetGroup: { fileCount: 4, subject: "feat: auth service" },
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("attached");
    expect(result!.isNoChange).toBe(false);
  });

  test("no rejectionReason (undefined) → outcome resolved from payload default (attached)", () => {
    const result = extractSubmoduleEntry({
      decision: "support-attachment-score",
      diagnostics: {},
      score: 7,
      supportGroup: { fileCount: 1, subject: "test(login): integration test" },
      targetGroup: { fileCount: 5, subject: "feat: login page" },
    });
    expect(result).not.toBeNull();
    expect(result!.entry.outcome).toBe("attached");
    expect(result!.isNoChange).toBe(false);
  });

  test("accumulateSubmoduleEntry: rejected evaluations go to noChangeCount, accepted to entries", () => {
    const acc = createSubmoduleAccumulator(
      "consolidate",
      "support-attachment-score",
    );
    // Rejected evaluation
    accumulateSubmoduleEntry(acc, {
      decision: "support-attachment-score",
      diagnostics: {},
      rejectionReason: "weak-test-support",
      score: 0,
      supportGroup: { fileCount: 1, subject: "test: weak test" },
      targetGroup: { fileCount: 2, subject: "feat: unrelated feature" },
    });
    // Accepted evaluation
    accumulateSubmoduleEntry(acc, {
      decision: "support-attachment-score",
      diagnostics: {},
      score: 8,
      supportGroup: { fileCount: 1, subject: "test(auth): integration" },
      targetGroup: { fileCount: 4, subject: "feat: auth service" },
    });
    expect(acc.noChangeCount).toBe(1);
    expect(acc.entries).toHaveLength(1);
    expect(acc.entries[0]?.outcome).toBe("attached");
  });

  test("all rejected evaluations compress into (N kept/no-change) in rendered output", () => {
    const acc = createSubmoduleAccumulator(
      "consolidate",
      "support-attachment-score",
    );
    for (let i = 0; i < 5; i++) {
      accumulateSubmoduleEntry(acc, {
        decision: "support-attachment-score",
        diagnostics: {},
        rejectionReason: "style-without-coverage",
        score: 0,
        supportGroup: { fileCount: 1, subject: `style(c${String(i)}): format` },
        targetGroup: { fileCount: 2, subject: `feat: feature-${String(i)}` },
      });
    }
    const lines = formatSubmoduleReportLines(acc, 80);
    const joined = lines.join("\n");
    expect(joined).toContain("(5 kept/no-change)");
    expect(joined).not.toContain("[kept]");
    expect(joined).not.toContain("[attached]");
  });
});
