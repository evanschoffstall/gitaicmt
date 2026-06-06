/** Per-submodule trace accumulation and report rendering. */

import type { SubmoduleAccumulator, SubmoduleReportEntry } from "./types.js";

import {
  extractBatchGroupEntry,
  extractOutputSubjectEntry,
  extractPairEntry,
  extractSingleGroupEntry,
} from "./entry-extraction.js";

export function accumulateSubmoduleEntry(
  acc: SubmoduleAccumulator,
  payload: Record<string, unknown>,
): void {
  if (tryRecordCountSummary(acc, payload)) return;

  acc.occurrenceCount++;

  const resolution =
    typeof payload.resolution === "string" ? payload.resolution : undefined;
  if (resolution)
    acc.resolutionCounts[resolution] =
      (acc.resolutionCounts[resolution] ?? 0) + 1;

  trackMetricSamples(acc.metricSamples, payload.diagnostics);

  const result = extractSubmoduleEntry(payload);
  if (result === null) return;

  if (result.isNoChange) {
    acc.noChangeCount++;
  } else {
    acc.entries.push(result.entry);
  }
}

/** Converts a kebab-case decision id to Title Case. */
export function buildDecisionTitle(decision: string): string {
  return decision
    .split("-")
    .map((seg) => (seg.length > 0 ? seg[0].toUpperCase() + seg.slice(1) : seg))
    .join(" ");
}

export function createSubmoduleAccumulator(
  stage: string,
  decision: string,
): SubmoduleAccumulator {
  return {
    decision,
    entries: [],
    metricSamples: {},
    noChangeCount: 0,
    occurrenceCount: 0,
    resolutionCounts: {},
    stage,
  };
}

export function extractSubmoduleEntry(
  payload: Record<string, unknown>,
): null | { entry: SubmoduleReportEntry; isNoChange: boolean } {
  return (
    extractPairEntry(payload) ??
    extractSingleGroupEntry(payload) ??
    extractBatchGroupEntry(payload) ??
    ("inputGroupCount" in payload && Object.keys(payload).length <= 3
      ? null
      : extractOutputSubjectEntry(payload))
  );
}

/** Renders ANSI trace box lines for the accumulator. Returns [] if empty. */
export function formatSubmoduleReportLines(
  acc: SubmoduleAccumulator,
  maxWidth: number,
): string[] {
  if (
    acc.entries.length === 0 &&
    acc.noChangeCount === 0 &&
    !acc.countSummary
  ) {
    return [];
  }

  const title = `${buildDecisionTitle(acc.decision)} [${acc.stage}]`;
  const inner = Math.max(20, maxWidth - 4);
  const lines: string[] = [];

  lines.push(`\x1b[2m╭── ${title}\x1b[0m`);

  for (const entry of acc.entries) {
    const outcomeTag = `[${entry.outcome}]`;
    const before = truncate(entry.before, inner - outcomeTag.length - 3);
    const main = `${before}  ${outcomeTag}`;
    lines.push(`\x1b[2m│\x1b[0m ${main}`);

    if (entry.after) {
      const afterLine = truncate(`  → ${entry.after}`, inner);
      lines.push(`\x1b[2m│\x1b[0m ${afterLine}`);
    }

    if (entry.why) {
      const whyLine = truncate(`  reason: ${entry.why}`, inner);
      lines.push(`\x1b[2m│\x1b[0m ${whyLine}`);
    }
  }

  if (acc.noChangeCount > 0) {
    lines.push(
      `\x1b[2m│\x1b[0m  (${String(acc.noChangeCount)} kept/no-change)`,
    );
  }

  if (acc.countSummary) {
    lines.push(`\x1b[2m│\x1b[0m  summary: ${acc.countSummary}`);
  }

  lines.push(`\x1b[2m╰──\x1b[0m`);
  return lines;
}

/**
 * Builds the parenthetical detail string appended to a count summary line.
 * The `fields` array controls which payload fields to include and in what order.
 */
function buildPayloadDetail(
  payload: Record<string, unknown>,
  fields: string[],
): string {
  const values = fields
    .filter((f) => typeof payload[f] === "string" && payload[f])
    .map((f) => payload[f] as string);
  return values.length > 0 ? ` (${values.join(", ")})` : "";
}

/** True when the payload contains at least one group-level data field. */
function hasGroupLevelFields(payload: Record<string, unknown>): boolean {
  return (
    "inputGroups" in payload ||
    "inputGroup" in payload ||
    "group" in payload ||
    "leftGroup" in payload ||
    "rightGroup" in payload ||
    "candidateGroup" in payload ||
    "supportGroup" in payload
  );
}

/**
 * Resolves the output-group count from whichever alias field the event used.
 * Different events omit `outputGroupCount` in favour of `finalGroupCount` or
 * `mergedGroupCount`.
 */
function resolveOutputCount(payload: Record<string, unknown>): null | number {
  if (typeof payload.outputGroupCount === "number")
    return payload.outputGroupCount;
  if (typeof payload.finalGroupCount === "number")
    return payload.finalGroupCount;
  if (typeof payload.mergedGroupCount === "number")
    return payload.mergedGroupCount;
  return null;
}

function trackMetricSamples(
  metricSamples: Record<string, number[]>,
  diagnostics: unknown,
): void {
  if (
    !diagnostics ||
    typeof diagnostics !== "object" ||
    Array.isArray(diagnostics)
  )
    return;
  for (const [key, val] of Object.entries(
    diagnostics as Record<string, unknown>,
  )) {
    if (typeof val === "number") (metricSamples[key] ??= []).push(val);
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/**
 * Attempts to set `acc.countSummary` from a count-summary payload.
 * Returns true when a summary was recorded so the caller can return early.
 */
function tryRecordCountSummary(
  acc: SubmoduleAccumulator,
  payload: Record<string, unknown>,
): boolean {
  const inputCount =
    typeof payload.inputGroupCount === "number"
      ? payload.inputGroupCount
      : null;
  if (inputCount === null) return false;

  // Full count: both input and output counts present.
  const outputCount = resolveOutputCount(payload);
  if (outputCount !== null) {
    // reason before resolution for full-count summaries.
    const detail = buildPayloadDetail(payload, ["reason", "resolution"]);
    acc.countSummary = `${String(inputCount)} → ${String(outputCount)} groups${detail}`;
    return true;
  }

  // Partial count: inputGroupCount present but no output count available.
  // Only fire when no group-level entry data is present so we don't shadow
  // richer extraction paths (e.g. cluster rejection, diminishing-returns stop).
  if (!hasGroupLevelFields(payload)) {
    // resolution before reason for partial-count summaries.
    const detail = buildPayloadDetail(payload, ["resolution", "reason"]);
    acc.countSummary = `${String(inputCount)} groups${detail}`;
    return true;
  }

  return false;
}
