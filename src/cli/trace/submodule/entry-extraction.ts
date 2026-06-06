/** Payload-shape detection helpers for submodule report entry extraction. */

import type { SubmoduleReportEntry } from "./types.js";

type EntryResult = null | { entry: SubmoduleReportEntry; isNoChange: boolean };

export function makeEntry(
  entry: SubmoduleReportEntry,
  noChangeOutcome: SubmoduleReportEntry["outcome"],
): { entry: SubmoduleReportEntry; isNoChange: boolean } {
  return { entry, isNoChange: entry.outcome === noChangeOutcome };
}

const OUTCOME_PATTERNS: [SubmoduleReportEntry["outcome"], string[]][] = [
  ["merged", ["merge", "join", "combine"]],
  ["split", ["split", "partition", "divide"]],
  ["kept", ["keep", "separate", "preserve", "retain", "no", "skip"]],
  ["attached", ["attach", "append", "add"]],
  ["transformed", ["transform", "convert", "update"]],
];

export function describeGroup(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    const first = String(value[0]);
    return value.length > 1 ? `${first} +${String(value.length - 1)}` : first;
  }
  if (typeof value === "object" && value !== null) {
    // describeGroupRecord never returns null — JSON.stringify is the fallback.
    return describeGroupRecord(value as Record<string, unknown>);
  }
  return String(value);
}

export function extractBatchGroupEntry(
  payload: Record<string, unknown>,
): EntryResult {
  const why = typeof payload.reason === "string" ? payload.reason : undefined;
  // Array.isArray covers both the "in" check and the type guard in one call.
  if (!Array.isArray(payload.inputGroups)) return null;
  const inCount = payload.inputGroups.length;
  const before = `${String(inCount)} group${inCount !== 1 ? "s" : ""}`;
  const outCount = Array.isArray(payload.outputGroups)
    ? payload.outputGroups.length
    : null;

  if (outCount !== null && outCount !== inCount) {
    const outcome = outCount < inCount ? "merged" : "split";
    return {
      entry: { after: `${String(outCount)} groups`, before, outcome, why },
      isNoChange: false,
    };
  }

  return makeEntry(
    { before, outcome: resolveOutcome(payload, "kept"), why },
    "kept",
  );
}

export function extractOutputSubjectEntry(
  payload: Record<string, unknown>,
): EntryResult {
  if (!("outputSubject" in payload)) return null;
  const why = typeof payload.reason === "string" ? payload.reason : undefined;
  const before =
    "fileCount" in payload
      ? `${String(payload.fileCount)} file(s)`
      : "files" in payload && Array.isArray(payload.files)
        ? `${String(payload.files.length)} file(s)`
        : "chunk";
  return {
    entry: {
      after:
        typeof payload.outputSubject === "string"
          ? payload.outputSubject
          : undefined,
      before,
      outcome: "transformed",
      why,
    },
    isNoChange: false,
  };
}

export function extractPairEntry(
  payload: Record<string, unknown>,
): EntryResult {
  const why = typeof payload.reason === "string" ? payload.reason : undefined;
  if ("leftGroup" in payload && "rightGroup" in payload) {
    return makeEntry(
      {
        before: `${describeGroup(payload.leftGroup)} + ${describeGroup(payload.rightGroup)}`,
        outcome: resolveOutcome(payload, "merged"),
        why,
      },
      "kept",
    );
  }
  if ("candidateGroup" in payload && "previousGroup" in payload) {
    return makeEntry(
      {
        after: describeGroup(payload.previousGroup),
        before: describeGroup(payload.candidateGroup),
        outcome: resolveOutcome(payload, "merged"),
        why,
      },
      "kept",
    );
  }
  if ("supportGroup" in payload && "targetGroup" in payload) {
    // When a `rejectionReason` is present the evaluation determined the support
    // group should NOT be attached (score was 0 / failed a quality gate).
    // Surface that as a no-change entry so the block compresses repeated
    // "kept" outcomes into the "(N kept/no-change)" summary line rather than
    // listing each rejected pair individually.
    const rejectionReason = extractRejectionReason(payload);
    return makeEntry(
      {
        after: describeGroup(payload.targetGroup),
        before: describeGroup(payload.supportGroup),
        outcome:
          rejectionReason !== null
            ? "kept"
            : resolveOutcome(payload, "attached"),
        why: rejectionReason ?? why,
      },
      "kept",
    );
  }
  return null;
}

export function extractSingleGroupEntry(
  payload: Record<string, unknown>,
): EntryResult {
  const why = typeof payload.reason === "string" ? payload.reason : undefined;
  if (!("inputGroup" in payload) && !("group" in payload)) return null;
  const before = describeGroup(payload.inputGroup ?? payload.group);

  if ("outputGroups" in payload && Array.isArray(payload.outputGroups)) {
    const count = payload.outputGroups.length;
    const outcome = count > 1 ? "split" : "kept";
    return makeEntry(
      {
        after: count > 1 ? `${String(count)} commits` : undefined,
        before,
        outcome,
        why,
      },
      "kept",
    );
  }

  if ("outputGroup" in payload) {
    return makeEntry(
      {
        after: describeGroup(payload.outputGroup),
        before,
        outcome: resolveOutcome(payload, "transformed"),
        why,
      },
      "kept",
    );
  }

  return makeEntry(
    { before, outcome: resolveOutcome(payload, "kept"), why },
    "kept",
  );
}

export function resolveOutcome(
  payload: Record<string, unknown>,
  defaultOutcome: SubmoduleReportEntry["outcome"],
): SubmoduleReportEntry["outcome"] {
  // Use an ordered field list instead of a null-coalescing chain to avoid
  // counting each ?? as an extra CCN decision point.
  const result = ["result", "resolution", "action", "outcome"]
    .map((key) => payload[key])
    .find((v): v is string => typeof v === "string");
  if (result === undefined) return defaultOutcome;
  const r = result.toLowerCase();
  for (const [outcome, keywords] of OUTCOME_PATTERNS) {
    if (keywords.some((kw) => r.includes(kw))) return outcome;
  }
  return defaultOutcome;
}

function describeGroupRecord(rec: Record<string, unknown>): string {
  if (typeof rec.subject === "string") return rec.subject;
  if (typeof rec.message === "string") {
    const subject = rec.message.split("\n")[0]?.trim();
    if (subject) return subject;
  }
  if (typeof rec.id !== "undefined") {
    const id =
      typeof rec.id === "string" || typeof rec.id === "number"
        ? String(rec.id)
        : null;
    if (id !== null)
      return typeof rec.label === "string" ? `${rec.label}(${id})` : id;
  }
  return JSON.stringify(rec);
}

/** Extracts a non-empty string rejection reason from the payload, or null. */
function extractRejectionReason(
  payload: Record<string, unknown>,
): null | string {
  const value = payload.rejectionReason;
  if (typeof value !== "string") return null;
  return value || null;
}
