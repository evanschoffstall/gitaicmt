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
import { configureTracePersistence } from "./trace-persistence.js";
import {
  formatVerboseAiOutputLines,
  getVerboseAiOutputSequenceKey,
} from "./verbose-output.js";
import { resolveLogWidth, resolveVerboseWidth } from "./viewport.js";

export type OutputMode = "off" | "summary" | "trace";

interface CommitPlanAnalysisSummary {
  elapsed: string;
  groups: { files: PlannedCommitFile[]; message: string }[];
  plannerFallbackNotice: null | string;
}

interface StatusRow {
  label: string;
  tone?: "default" | "warning";
  value: string | string[];
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";

let outputMode: OutputMode = "off";
let verboseEventCounts: Record<string, number> = Object.create(null) as Record<
  string,
  number
>;

export function configureOutputMode(mode: OutputMode): void {
  outputMode = mode;
  verboseEventCounts = Object.create(null) as Record<string, number>;
  configureTracePersistence(mode);
}

export function hasVisibleOutputMode(): boolean {
  return outputMode !== "off";
}

export function isVerboseModeEnabled(): boolean {
  return outputMode !== "off";
}

export function log(message: string): void {
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

export function logCommitPlanAnalysis(analysis: CommitPlanAnalysisSummary): void {
  logPlannedCommits(analysis.groups, analysis.elapsed);
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
    logTokenEstimate(tokenEstimate, tokenWarningThreshold ?? 0, suppressWarning);
  }
}

export function logStatusSection(title: string, rows: StatusRow[]): void {
  writeTerminalLines(
    buildStatusSectionLines(
      title,
      rows as PresentationStatusRow[],
      resolveLogWidth(),
    ),
  );
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
  const eventKey = getVerboseAiOutputSequenceKey(event);
  verboseEventCounts[eventKey] = (verboseEventCounts[eventKey] ?? 0) + 1;
  const lines = formatVerboseAiOutputLines(event, {
    maxWidth: resolveVerboseWidth(),
    mode: outputMode === "trace" ? "trace" : "summary",
    sequence: verboseEventCounts[eventKey],
  });
  logVerboseBlock(lines);
}

export function verbose(message: string): void {
  if (!isVerboseModeEnabled()) {
    return;
  }

  const label = outputMode === "trace" ? "trace" : "verbose";
  log(`${DIM}[${label}] ${message}${RESET}`);
}

function logPlannedCommits(
  groups: { files: PlannedCommitFile[] }[],
  elapsed: string,
): void {
  log("");
  logStatusSection("Plan Summary", [
    {
      label: "commits",
      value: `${formatCount(groups.length)} planned ${groups.length === 1 ? "commit" : "commits"}`,
    },
    {
      label: "elapsed",
      value: `${elapsed}s analysis time`,
    },
  ]);
  log("");
}

function logVerboseBlock(lines: string[]): void {
  if (!isVerboseModeEnabled()) {
    return;
  }

  const label = outputMode === "trace" ? "trace" : "verbose";
  writeTerminalLines(lines.map((line) => `${DIM}[${label}]${RESET} ${line}`));
}