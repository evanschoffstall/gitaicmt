import type { PlannerNoticeState } from "./planner-notices.js";

import { loadConfig } from "../application/config/index.js";
import {
  estimateGenerateOperationTokens,
  estimatePlanOperationTokens,
  generateForChunks,
  planCommits,
  type PlannedCommitFile,
  resetTokenUsageSummary,
  validateOpenAIConfiguration,
} from "../commit-planning/orchestration.js";
import { resolveOverlappingCommits } from "../commit-planning/overlap-resolution.js";
import {
  chunkDiffs,
  type FileDiff,
  formatFileDiff,
  getStats,
  parseDiff,
} from "../git/diff.js";
import {
  getStagedDiff,
} from "../git/operations.js";
import {
  executePlannedCommits,
  executeSingleCommitMessage,
} from "./commit/execution.js";
import { formatCount } from "./counts.js";
import { die } from "./fatal.js";
import { buildPlanCardLines } from "./output-presentation.js";
import { getPlannerFallbackNotice } from "./planner-notices.js";
import {
  log,
  logCommitPlanAnalysis,
  logStatusSection,
  logTokenEstimate,
  verbose,
} from "./session-display.js";
import { ensureStaged } from "./staging-guard.js";
import { withThinkingIndicator, writeTerminalLines } from "./terminal/output-ui.js";
import {
  confirmCommitPlan,
  confirmTokenCheckedGeneration,
  confirmTokenUsage,
  shouldPromptForHighTokenUsage,
  type TokenCheckOptions,
} from "./token/confirmation.js";
import { resolveDisplayWidth } from "./viewport.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";

interface CommitPlanAnalysis {
  elapsed: string;
  files: FileDiff[];
  groups: { files: PlannedCommitFile[]; message: string }[];
  plannerFallbackNotice: null | string;
}

export async function cmdCommit(
  autoConfirm: boolean,
  skipTokenCheck: boolean,
  plannerNoticeState: PlannerNoticeState,
): Promise<void> {
  resetTokenUsageSummary();
  const analysis = await analyzeCommitPlan(
    { skipPrompt: autoConfirm || skipTokenCheck },
    plannerNoticeState,
  );
  if (!analysis) {
    log(`${YELLOW}Aborted.${RESET}`);
    return;
  }

  const { files, groups } = analysis;
  logCommitPlanAnalysis(analysis);

  const mergedGroups = resolveOverlappingCommits(groups);
  if (mergedGroups.length < groups.length) {
    const dropped = groups.length - mergedGroups.length;
    log(
      `${YELLOW}Note: Dropped ${formatCount(dropped)} duplicate commit(s) whose files were already covered${RESET}`,
    );
    log("");
  }

  const fileMap = new Map(files.map((file) => [file.path, file]));
  displayPlan(mergedGroups, fileMap);

  if (!(await confirmCommitPlan(autoConfirm, mergedGroups.length))) {
    return;
  }

  executePlannedCommits(mergedGroups, fileMap);
}

export async function cmdCommitSingle(skipTokenCheck: boolean): Promise<void> {
  const startedAtMs = performance.now();
  ensureStaged();

  const raw = getStagedDiff();
  if (!raw.trim()) {
    die("Staged diff is empty.");
  }

  const files = parseDiff(raw);
  const chunks = chunkDiffs(files);
  const stats = getStats(files, chunks);
  const cfg = loadConfig();
  const tokenEstimate = estimateGenerateOperationTokens(chunks, stats, cfg);
  if (!(await confirmTokenCheckedGeneration(cfg, stats, tokenEstimate, skipTokenCheck))) {
    return;
  }

  const message = await withThinkingIndicator(() => generateForChunks(chunks, stats));
  const elapsed = ((performance.now() - startedAtMs) / 1000).toFixed(1);

  log(`${GREEN}${BOLD}Commit message:${RESET}`);
  log(message);
  log(`${DIM}(${elapsed}s)${RESET}`);
  executeSingleCommitMessage(message);
}

export async function cmdGenerate(skipTokenCheck: boolean): Promise<void> {
  const startedAtMs = performance.now();
  ensureStaged();

  verbose("Loading configuration");
  const cfg = loadConfig();
  verbose("Getting staged diff");
  const raw = getStagedDiff();
  if (!raw.trim()) {
    die("Staged diff is empty.");
  }

  verbose("Parsing diff");
  const files = parseDiff(raw);
  warnIfDiffExceedsLimit(files, cfg.analysis.maxDiffLines);

  verbose("Chunking diffs");
  const chunks = chunkDiffs(files);
  const stats = getStats(files, chunks);
  const tokenEstimate = estimateGenerateOperationTokens(chunks, stats, cfg);
  if (!(await confirmTokenCheckedGeneration(cfg, stats, tokenEstimate, skipTokenCheck))) {
    return;
  }

  verbose("Calling OpenAI API");
  const message = await withThinkingIndicator(() => generateForChunks(chunks, stats));
  const elapsed = ((performance.now() - startedAtMs) / 1000).toFixed(1);

  log(`${DIM}(${elapsed}s)${RESET}`);
  log("");
  process.stdout.write(message + "\n");
}

export async function cmdPlan(
  skipTokenCheck: boolean,
  plannerNoticeState: PlannerNoticeState,
): Promise<void> {
  const analysis = await analyzeCommitPlan({ skipPrompt: skipTokenCheck }, plannerNoticeState);
  if (!analysis) {
    log(`${YELLOW}Aborted.${RESET}`);
    return;
  }

  logCommitPlanAnalysis(analysis);
  displayPlan(analysis.groups, new Map(analysis.files.map((file) => [file.path, file])));
}

async function analyzeCommitPlan(
  tokenCheckOptions: TokenCheckOptions,
  plannerNoticeState: PlannerNoticeState,
): Promise<CommitPlanAnalysis | null> {
  const startedAtMs = performance.now();
  ensureStaged();
  plannerNoticeState.usedFallbackFinalization = false;

  const raw = getStagedDiff();
  if (!raw.trim()) {
    die("Staged diff is empty.");
  }

  const files = parseDiff(raw);
  const cfg = loadConfig();
  const tokenEstimate = estimatePlanOperationTokens(files, formatFileDiff, cfg);
  const shouldPrompt = shouldPromptForHighTokenUsage(tokenEstimate, cfg, tokenCheckOptions);
  log("");
  logStatusSection("Analyzing changes", [
    { label: "model", value: cfg.openai.model },
    { label: "files", value: `${formatCount(files.length)} changed file(s)` },
  ]);
  logTokenEstimate(tokenEstimate, cfg.analysis.tokenWarningThreshold, shouldPrompt);
  if (!(await confirmTokenUsage(tokenEstimate, cfg, tokenCheckOptions))) {
    return null;
  }

  validateOpenAIConfiguration();
  const groups = await withThinkingIndicator(() => planCommits(files, formatFileDiff));
  return {
    elapsed: ((performance.now() - startedAtMs) / 1000).toFixed(1),
    files,
    groups,
    plannerFallbackNotice: getPlannerFallbackNotice(plannerNoticeState),
  };
}

function displayPlan(
  groups: { files: PlannedCommitFile[]; message: string }[],
  fileDiffs?: Map<string, FileDiff>,
): void {
  const maxWidth = resolveDisplayWidth();
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    writeTerminalLines(
      buildPlanCardLines({
        fileDiffs,
        files: group.files,
        index: index + 1,
        maxWidth,
        message: group.message,
        total: groups.length,
      }),
    );
    writeTerminalLines([""]);
  }
}

function warnIfDiffExceedsLimit(files: FileDiff[], maxDiffLines: number): void {
  const totalLines = files.reduce(
    (sum, file) => sum + file.hunks.reduce((hunkSum, hunk) => hunkSum + hunk.lines.length, 0),
    0,
  );
  if (totalLines <= maxDiffLines) {
    return;
  }

  log(
    `${YELLOW}Warning: diff is ${formatCount(totalLines)} lines (limit: ${formatCount(maxDiffLines)}). Results may be truncated.${RESET}`,
  );
}