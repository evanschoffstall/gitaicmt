import type {
  AiOutputEvent,
  TokenUsageSummary,
} from "../commit-planning/openai-client.js";

import {
  type PlannedCommitFile,
  type TokenEstimateSummary,
} from "../commit-planning/orchestration.js";
import {
  formatCount,
  formatRequestCount,
  formatStageUsageLabel,
  formatTokenWarning,
  isHighTokenEstimate,
} from "./counts.js";
import { buildStatusSectionLines } from "./output-presentation.js";
import { wrapTerminalTextBlock } from "./terminal/line-wrapping.js";
import { writeTerminalLines } from "./terminal/output-ui.js";
import { configureTracePersistence } from "./trace/index.js";
import {
  accumulateSubmoduleEntry,
  createSubmoduleAccumulator,
  formatSubmoduleReportLines,
  type SubmoduleAccumulator,
} from "./trace/submodule/index.js";
import {
  formatVerboseAiOutputLines,
  getVerboseAiOutputSequenceKey,
} from "./verbose-output.js";
import { toNormalizedPlannerDecisionId } from "./verbose-rendering/index.js";
import { resolveLogWidth, resolveVerboseWidth } from "./viewport.js";

export type OutputMode = "off" | "summary" | "trace";

interface CommitPlanAnalysisSummary {
  elapsed: string;
  groups: { files: PlannedCommitFile[]; message: string }[];
  plannerFallbackNotice: null | string;
}

// Accepted by callers for API compatibility; options are intentionally ignored
// since the new per-submodule trace system flushes automatically on transitions.
interface FlushVerboseOptions {
  includeCoverageSummary?: boolean;
}

interface StatusRow {
  label: string;
  tone?: "default" | "warning";
  value: string | string[];
}

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const YELLOW = "\u001b[33m";

let outputMode: OutputMode = "off";
let verboseEventCounts: Record<string, number> = Object.create(null) as Record<
  string,
  number
>;

// Per-submodule trace accumulation state
let currentSubmoduleKey: null | string = null;
let currentSubmoduleAcc: null | SubmoduleAccumulator = null;

export function configureOutputMode(mode: OutputMode): void {
  flushVerboseAiOutput();
  outputMode = mode;
  verboseEventCounts = Object.create(null) as Record<string, number>;
  currentSubmoduleKey = null;
  currentSubmoduleAcc = null;
  configureTracePersistence(mode);
}

/** Flush any accumulated per-submodule trace entries before transitions. */
export function flushVerboseAiOutput(_options?: FlushVerboseOptions): void {
  flushCurrentSubmodule();
}

export function hasVisibleOutputMode(): boolean {
  return outputMode !== "off";
}

export function isVerboseModeEnabled(): boolean {
  return outputMode !== "off";
}

export function log(message: string): void {
  if (outputMode !== "trace") {
    flushVerboseAiOutput();
  }
  writeTerminalLines(wrapTerminalTextBlock(message, resolveLogWidth()));
}

export function logActualTokenUsage(
  usage: TokenUsageSummary,
  usageByStage: Record<string, TokenUsageSummary>,
): void {
  const stageLines = Object.entries(usageByStage)
    .filter(([, stageUsage]) => stageUsage.requestCount > 0)
    .map(
      ([stage, stageUsage]) =>
        `${formatStageUsageLabel(stage)}=${formatCount(stageUsage.totalTokens)} (${formatCount(stageUsage.requestCount)} req)`,
    );

  log("");
  logStatusSection("Usage Summary", [
    {
      label: "tokens used",
      value: `${formatCount(usage.totalTokens)} total across ${formatRequestCount(usage.requestCount)}`,
    },
    ...(isVerboseModeEnabled() && stageLines.length > 0
      ? [{ label: "stages", value: stageLines }]
      : []),
  ]);
}

export function logCommitPlanAnalysis(
  analysis: CommitPlanAnalysisSummary,
): void {
  if (outputMode === "trace") {
    flushVerboseAiOutput();
  }

  log("");
  logStatusSection("Plan Summary", [
    {
      label: "commits",
      value: `${formatCount(analysis.groups.length)} planned ${analysis.groups.length === 1 ? "commit" : "commits"}`,
    },
    {
      label: "elapsed",
      value: `${analysis.elapsed}s analysis time`,
    },
  ]);
  log("");

  if (analysis.plannerFallbackNotice) {
    log(`${YELLOW}${analysis.plannerFallbackNotice}${RESET}`);
    log("");
  }
}

export function logGenerationContext(
  model: string,
  stats: {
    additions: number;
    chunks: number;
    deletions: number;
    filesChanged: number;
  },
  tokenEstimate?: TokenEstimateSummary,
  tokenWarningThreshold?: number,
  suppressWarning = false,
): void {
  log("");
  logStatusSection("Generating Message", [
    { label: "model", value: model },
    {
      label: "scope",
      value: `${formatCount(stats.filesChanged)} file(s) · +${formatCount(stats.additions)}/-${formatCount(stats.deletions)} · ${formatCount(stats.chunks)} chunk(s)`,
    },
  ]);
  if (tokenEstimate) {
    logTokenEstimate(
      tokenEstimate,
      tokenWarningThreshold ?? 0,
      suppressWarning,
    );
  }
}

export function logStatusSection(title: string, rows: StatusRow[]): void {
  if (outputMode !== "trace") {
    flushVerboseAiOutput();
  }
  writeTerminalLines(buildStatusSectionLines(title, rows, resolveLogWidth()));
}

export function logTokenEstimate(
  estimate: TokenEstimateSummary,
  tokenWarningThreshold: number,
  suppressWarning = false,
): void {
  if (estimate.requestCount === 0) {
    return;
  }

  logStatusSection("Token Estimate", [
    ...(estimate.minimumRequestCount < estimate.requestCount ||
    estimate.minimumTotalTokens < estimate.totalTokens
      ? [
          {
            label: "baseline",
            value: `~${formatCount(estimate.minimumTotalTokens)} across ${formatRequestCount(estimate.minimumRequestCount)}`,
          },
          {
            label: "upper bound",
            value: `~${formatCount(estimate.totalTokens)} across about ${formatRequestCount(estimate.requestCount)}`,
          },
        ]
      : [
          {
            label: "estimate",
            value: `~${formatCount(estimate.totalTokens)} across about ${formatRequestCount(estimate.requestCount)}`,
          },
        ]),
    {
      label: "peak",
      value: `~${formatCount(estimate.peakRequestTokens)}/request`,
    },
    ...(!suppressWarning && isHighTokenEstimate(estimate, tokenWarningThreshold)
      ? [
          {
            label: "warning",
            tone: "warning" as const,
            value: formatTokenWarning(tokenWarningThreshold),
          },
        ]
      : []),
  ]);
}

export function logVerboseAiOutput(event: AiOutputEvent): void {
  if (outputMode !== "trace" && outputMode !== "summary") {
    return;
  }

  if (event.kind === "planner-decision" && outputMode === "trace") {
    accumulateTracePlannerDecision(event);
    return;
  }

  if (currentSubmoduleKey !== null) {
    flushCurrentSubmodule();
  }
  renderVerboseAiOutput(event);
}

export function verbose(message: string): void {
  if (!isVerboseModeEnabled()) {
    return;
  }

  const label = outputMode === "trace" ? "trace" : "verbose";
  log(`${DIM}[${label}] ${message}${RESET}`);
}

function accumulateTracePlannerDecision(event: AiOutputEvent): boolean {
  let payload: null | Record<string, unknown> = null;
  try {
    const parsed = JSON.parse(event.content) as unknown;
    if (typeof parsed === "object" && !Array.isArray(parsed))
      payload = parsed as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  if (!payload) return false;
  const decision = toNormalizedPlannerDecisionId(payload.decision);
  if (!decision) return false;
  const key = `${event.stage}:${decision}`;
  if (currentSubmoduleKey !== null && currentSubmoduleKey !== key)
    flushCurrentSubmodule();
  if (currentSubmoduleKey === null) {
    currentSubmoduleAcc = createSubmoduleAccumulator(event.stage, decision);
    currentSubmoduleKey = key;
  }
  accumulateSubmoduleEntry(
    currentSubmoduleAcc ?? createSubmoduleAccumulator(event.stage, decision),
    payload,
  );
  return true;
}

function flushCurrentSubmodule(): void {
  if (currentSubmoduleAcc === null) return;
  const acc = currentSubmoduleAcc;
  currentSubmoduleKey = null;
  currentSubmoduleAcc = null;

  if (!isVerboseModeEnabled()) return;

  const lines = formatSubmoduleReportLines(acc, resolveVerboseWidth());
  if (lines.length === 0) return;

  const label = outputMode === "trace" ? "trace" : "verbose";
  writeTerminalLines(lines.map((line) => `${DIM}[${label}]${RESET} ${line}`));
}

function renderVerboseAiOutput(event: AiOutputEvent): void {
  const eventKey = getVerboseAiOutputSequenceKey(event);
  verboseEventCounts[eventKey] = (verboseEventCounts[eventKey] ?? 0) + 1;
  const lines = formatVerboseAiOutputLines(event, {
    maxWidth: resolveVerboseWidth(),
    mode: outputMode === "trace" ? "trace" : "summary",
    sequence: verboseEventCounts[eventKey],
  });
  if (isVerboseModeEnabled()) {
    const label = outputMode === "trace" ? "trace" : "verbose";
    writeTerminalLines(lines.map((line) => `${DIM}[${label}]${RESET} ${line}`));
  }
}
