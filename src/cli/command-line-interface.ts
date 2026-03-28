#!/usr/bin/env node

import { createInterface } from "node:readline";

import { initConfig, loadConfig } from "../application/config.js";
import {
  type AiOutputEvent,
  estimateGenerateOperationTokens,
  estimatePlanOperationTokens,
  generateForChunks,
  getTokenUsageByStage,
  getTokenUsageSummary,
  planCommits,
  type PlannedCommitFile,
  resetTokenUsageSummary,
  setAiOutputObserver,
  type TokenEstimateSummary,
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
  commitWithMessage,
  getStagedDiff,
  getStagedPatch,
  hasCommitHistory,
  hasStagedChanges,
  isGitRepository,
  resetStaging,
  restoreStagedPatch,
  stageAll,
} from "../git/operations.js";
import { stageGroupFiles } from "./commit-group-staging.js";
import {
  formatCommitFile,
} from "./commit-plan-display.js";
import {
  buildPlanCardLines,
  buildReadyPromptLines,
  buildStatusSectionLines,
  type PresentationStatusRow,
} from "./output-presentation.js";
import {
  createPlannerNoticeState,
  getPlannerFallbackNotice,
  recordPlannerNotice,
} from "./planner-notices.js";
import { resolveTerminalColumns } from "./terminal-columns.js";
import { wrapTerminalTextBlock } from "./terminal-line-wrapping.js";
import { withThinkingIndicator, writeTerminalLines } from "./terminal-output-ui.js";
import {
  formatVerboseAiOutputLines,
  getVerboseAiOutputSequenceKey,
} from "./verbose-output.js";

// -------- Helpers --------

const VERSION = "1.0.0";
let verboseMode = false;

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DEFAULT_VERBOSE_WIDTH = 100;

type OutputMode = "off" | "summary" | "trace";

let outputMode: OutputMode = "off";
let verboseEventCounts: Record<string, number> = Object.create(null) as Record<
  string,
  number
>;

interface CommitPlanAnalysis {
  elapsed: string;
  files: FileDiff[];
  groups: { files: PlannedCommitFile[]; message: string }[];
  plannerFallbackNotice: null | string;
}

interface StatusRow {
  label: string;
  tone?: "default" | "warning";
  value: string;
}

interface TokenCheckOptions {
  skipPrompt: boolean;
}

const plannerNoticeState = createPlannerNoticeState();

async function analyzeCommitPlan(tokenCheckOptions: TokenCheckOptions) {
  const t0 = performance.now();
  ensureStaged();
  plannerNoticeState.usedFallbackFinalization = false;

  const raw = getStagedDiff();
  if (!raw.trim()) die("Staged diff is empty.");

  const files = parseDiff(raw);
  const cfg = loadConfig();
  const tokenEstimate = estimatePlanOperationTokens(files, formatFileDiff, cfg);
  const shouldPrompt = shouldPromptForHighTokenUsage(
    tokenEstimate,
    cfg,
    tokenCheckOptions,
  );
  log("");
  logStatusSection("Analyzing changes", [
    { label: "model", value: cfg.openai.model },
    { label: "files", value: `${formatCount(files.length)} changed file(s)` },
  ]);
  logTokenEstimate(
    tokenEstimate,
    cfg.analysis.tokenWarningThreshold,
    shouldPrompt,
  );
  if (!(await confirmTokenUsage(tokenEstimate, cfg, tokenCheckOptions))) {
    return null;
  }
  validateOpenAIConfiguration();

  const groups = await withThinkingIndicator(() =>
    planCommits(files, formatFileDiff),
  );
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const plannerFallbackNotice = getPlannerFallbackNotice(plannerNoticeState);
  return { elapsed, files, groups, plannerFallbackNotice } satisfies CommitPlanAnalysis;
}

function buildReadyToCommitPrompt(plannedCommitCount: number): string {
  return buildReadyPromptLines(plannedCommitCount, resolveLogWidth()).join("\n");
}

/** Analyze, split, and execute multiple commits */
async function cmdCommit(autoConfirm: boolean, skipTokenCheck: boolean) {
  const startedAtMs = performance.now();
  resetTokenUsageSummary();
  const analysis = await analyzeCommitPlan({
    skipPrompt: autoConfirm || skipTokenCheck,
  });
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

  const fileMap = new Map(files.map((f) => [f.path, f]));

  displayPlan(mergedGroups, fileMap);

  if (!autoConfirm) {
    logActualTokenUsage(getTokenUsageSummary());
    const confirmed = await promptYesNo(
      buildReadyToCommitPrompt(mergedGroups.length),
    );
    if (!confirmed) {
      log(`${YELLOW}Aborted.${RESET}`);
      return;
    }
    log("");
  }

  let committed = 0;
  let initialStagedPatch = "";

  try {
    initialStagedPatch = getStagedPatch();
  } catch {
    log(
      `${YELLOW}Warning: Could not save initial staging state for recovery${RESET}`,
    );
  }

  try {
    for (let i = 0; i < mergedGroups.length; i++) {
      const g = mergedGroups[i];
      const subject = g.message.split("\n")[0];

      log(
        `${BOLD}${GREEN}[${formatCount(i + 1)}/${formatCount(mergedGroups.length)}]${RESET} ${subject}`,
      );
      log(
        `  ${DIM}${g.files.map((f) => formatCommitFile(f, fileMap)).join(", ")} ${RESET}`,
      );

      resetStaging();
      stageGroupFiles(g.files, fileMap);

      if (!hasStagedChanges()) {
        log(
          `${YELLOW}  (skipped — no stageable changes remain for this group)${RESET}`,
        );
        log("");
        continue;
      }

      commitWithMessage(g.message);
      committed++;
      log("");
    }

    const totalElapsed = ((performance.now() - startedAtMs) / 1000).toFixed(1);
    const skipped = mergedGroups.length - committed;
    const skippedNote = skipped > 0 ? `, ${formatCount(skipped)} skipped` : "";
    log(
      `${GREEN}${BOLD}Done:${RESET} ${formatCount(committed)} commit(s) in ${totalElapsed}s${skippedNote}`,
    );
  } catch (err) {
    log(
      `${RED}${BOLD}Failed after ${formatCount(committed)}/${formatCount(mergedGroups.length)} commits.${RESET}`,
    );

    // Attempt to restore staging state
    if (
      committed < mergedGroups.length &&
      initialStagedPatch.trim().length > 0
    ) {
      log(`${YELLOW}Attempting to restore initial staging state...${RESET}`);
      try {
        resetStaging();
        restoreStagedPatch(initialStagedPatch);
        log(`${GREEN}Initial staging state restored successfully.${RESET}`);
      } catch {
        log(`${RED}Failed to restore staging state.${RESET}`);
        log(
          `${YELLOW}Manual recovery: Review 'git status' and 'git log' to assess state.${RESET}`,
        );
        log(
          `${YELLOW}Previous ${formatCount(committed)} commits were completed successfully.${RESET}`,
        );
      }
    } else {
      log(
        `${YELLOW}Manual recovery required: Check 'git status' and 'git log'.${RESET}`,
      );
    }
    throw err;
  }
}

/** Single commit mode — one message for everything (fully automated) */
async function cmdCommitSingle(skipTokenCheck: boolean) {
  const t0 = performance.now();
  ensureStaged();

  const raw = getStagedDiff();
  if (!raw.trim()) die("Staged diff is empty.");

  const files = parseDiff(raw);
  const chunks = chunkDiffs(files);
  const stats = getStats(files, chunks);

  const cfg = loadConfig();
  const tokenEstimate = estimateGenerateOperationTokens(chunks, stats, cfg);
  if (
    !(await confirmTokenCheckedGeneration(
      cfg,
      stats,
      tokenEstimate,
      skipTokenCheck,
    ))
  ) {
    return;
  }

  const message = await withThinkingIndicator(() =>
    generateForChunks(chunks, stats),
  );
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  log(`${GREEN}${BOLD}Commit message:${RESET}`);
  log(message);
  log(`${DIM}(${elapsed}s)${RESET}`);

  // Execute commit
  commitWithMessage(message);
}

/** Generate a single commit message (legacy / simple mode) */
async function cmdGenerate(skipTokenCheck: boolean) {
  const t0 = performance.now();
  ensureStaged();

  verbose("Loading configuration");
  const cfg = loadConfig();
  verbose("Getting staged diff");
  const raw = getStagedDiff();
  if (!raw.trim()) die("Staged diff is empty.");

  verbose("Parsing diff");
  const files = parseDiff(raw);
  const totalLines = files.reduce(
    (s, f) => s + f.hunks.reduce((hs, h) => hs + h.lines.length, 0),
    0,
  );
  if (totalLines > cfg.analysis.maxDiffLines) {
    log(
      `${YELLOW}Warning: diff is ${formatCount(totalLines)} lines (limit: ${formatCount(cfg.analysis.maxDiffLines)}). Results may be truncated.${RESET}`,
    );
  }

  verbose("Chunking diffs");
  const chunks = chunkDiffs(files);
  const stats = getStats(files, chunks);
  const tokenEstimate = estimateGenerateOperationTokens(chunks, stats, cfg);

  if (
    !(await confirmTokenCheckedGeneration(
      cfg,
      stats,
      tokenEstimate,
      skipTokenCheck,
    ))
  ) {
    return;
  }

  verbose("Calling OpenAI API");
  const message = await withThinkingIndicator(() =>
    generateForChunks(chunks, stats),
  );
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  log(`${DIM}(${elapsed}s)${RESET}`);
  log("");

  // Print commit message to stdout so it can be piped
  process.stdout.write(message + "\n");
}

function cmdHelp() {
  log(`${BOLD}gitaicmt${RESET} — AI-powered git commits\n`);
  log(`${CYAN}Commands:${RESET}`);
  log(
    "  gitaicmt              Auto-detect, split & commit (shows plan, asks y/n)",
  );
  log("  gitaicmt -y           Same as above, but skip confirmation");
  log(
    "  gitaicmt plan         Preview planned commit groups without committing",
  );
  log("  gitaicmt single       One commit for all changes");
  log("  gitaicmt gen          Generate message to stdout (for piping)");
  log("  gitaicmt init         Create default gitaicmt.config.json");
  log("  gitaicmt version      Show version information");
  log("  gitaicmt help         Show this help\n");
  log(`${CYAN}Flags:${RESET}`);
  log("  -y, --yes             Auto-confirm (skip prompts)");
  log("  --no-token-check      Skip high-token confirmation prompts");
  log("  -v, --verbose         Show concise stage summaries and diagnostics");
  log("  --trace               Show raw intermediate AI payloads");
  log("  --version             Show version information");
  log("  -h, --help            Show this help\n");
  log(`${CYAN}Usage:${RESET}`);
  log("  gitaicmt                         Detect, analyze, confirm & commit");
  log(
    "  gitaicmt -y                      Detect, analyze & commit (no prompt)",
  );
  log("  gitaicmt -v plan                 Show verbose logs during planning");
  log("  gitaicmt --trace plan            Show raw AI planning payloads");
  log("  gitaicmt plan                    Preview the split before committing");
  log("  gitaicmt gen | git commit -F -   Pipe single message to git\n");
  log(`${CYAN}Config:${RESET}`);
  log("  Place gitaicmt.config.json in your project root.");
  log("  Set OPENAI_API_KEY env var or openai.apiKey in config.");
  log("");
  log(`${DIM}Changes are auto-staged if nothing is manually staged.${RESET}`);
}

function cmdInit() {
  const path = initConfig();
  log(`${GREEN}Created config:${RESET} ${path}`);
}

/** Analyze diffs and plan multiple commits (print plan without committing) */
async function cmdPlan(skipTokenCheck: boolean) {
  const analysis = await analyzeCommitPlan({ skipPrompt: skipTokenCheck });
  if (!analysis) {
    log(`${YELLOW}Aborted.${RESET}`);
    return;
  }

  const { files, groups } = analysis;

  logCommitPlanAnalysis(analysis);

  const fileMap = new Map(files.map((f) => [f.path, f]));
  displayPlan(groups, fileMap);
}

/** Show version information */
function cmdVersion() {
  log(`gitaicmt v${VERSION}`);
}

async function confirmTokenCheckedGeneration(
  cfg: ReturnType<typeof loadConfig>,
  stats: {
    additions: number;
    chunks: number;
    deletions: number;
    filesChanged: number;
  },
  tokenEstimate: TokenEstimateSummary,
  skipTokenCheck: boolean,
): Promise<boolean> {
  const shouldPrompt = shouldPromptForHighTokenUsage(tokenEstimate, cfg, {
    skipPrompt: skipTokenCheck,
  });
  logGenerationContext(
    cfg.openai.model,
    stats,
    tokenEstimate,
    cfg.analysis.tokenWarningThreshold,
    shouldPrompt,
  );

  return confirmTokenCheckedOperation(tokenEstimate, cfg, {
    skipPrompt: skipTokenCheck,
  });
}

async function confirmTokenCheckedOperation(
  estimate: TokenEstimateSummary,
  cfg: ReturnType<typeof loadConfig>,
  options: TokenCheckOptions,
): Promise<boolean> {
  if (!(await confirmTokenUsage(estimate, cfg, options))) {
    log(`${YELLOW}Aborted.${RESET}`);
    return false;
  }

  validateOpenAIConfiguration();
  return true;
}

async function confirmTokenUsage(
  estimate: TokenEstimateSummary,
  cfg: ReturnType<typeof loadConfig>,
  options: TokenCheckOptions,
): Promise<boolean> {
  if (!shouldPromptForHighTokenUsage(estimate, cfg, options)) {
    return true;
  }

  return promptYesNo(
    `${YELLOW}${formatTokenWarning(cfg.analysis.tokenWarningThreshold)} ${BOLD}Continue?${RESET}`,
  );
}

function die(msg: string): never {
  log(`${RED}error:${RESET} ${msg}`);
  process.exit(1);
}

/** Display planned commit groups */
function displayPlan(
  groups: { files: PlannedCommitFile[]; message: string }[],
  fileDiffs?: Map<string, FileDiff>,
): void {
  const maxWidth = resolveDisplayWidth();

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    writeTerminalLines(
      buildPlanCardLines({
        fileDiffs,
        files: g.files,
        index: i + 1,
        maxWidth,
        message: g.message,
        total: groups.length,
      }),
    );
    writeTerminalLines([""]);
  }
}

// -------- Commands --------

/** Ensure changes are staged. If nothing is staged, auto-stage all changes. */
function ensureStaged(): void {
  // First check if we're in a git repository
  if (!isGitRepository()) {
    die(
      "Not a git repository. Run 'git init' first or cd into a git repository.",
    );
  }

  if (!hasCommitHistory()) {
    die(
      "Git repository has no commits yet. Create an initial commit first:\n  git commit --allow-empty -m 'Initial commit'",
    );
  }

  try {
    if (hasStagedChanges()) return;
  } catch (err: unknown) {
    if (err instanceof Error) {
      die(err.message);
    }
    throw err;
  }

  log(`${DIM}No staged changes detected, auto-staging all changes...${RESET}`);
  stageAll();
  if (!hasStagedChanges()) {
    die("No changes to commit.");
  }
}

function formatCount(value: number): string {
  return String(value);
}

function formatRequestCount(value: number): string {
  return `${formatCount(value)} request(s)`;
}

function formatStageUsageLabel(stage: string): string {
  switch (stage) {
    case "cluster": {
      return "merge-review";
    }
    case "consolidate": {
      return "final-consolidation";
    }
    case "generate": {
      return "message-draft";
    }
    case "group": {
      return "grouping";
    }
    case "merge": {
      return "message-merge";
    }
    default: {
      return stage;
    }
  }
}

function formatTokenWarning(tokenWarningThreshold: number): string {
  return `Estimated token usage may exceed threshold (${formatCount(tokenWarningThreshold)}).`;
}

function isHighTokenEstimate(
  estimate: TokenEstimateSummary,
  tokenWarningThreshold: number,
): boolean {
  return (
    tokenWarningThreshold > 0 &&
    (estimate.totalTokens >= tokenWarningThreshold ||
      estimate.peakRequestTokens >= tokenWarningThreshold)
  );
}

function log(msg: string) {
  writeTerminalLines(wrapTerminalTextBlock(msg, resolveLogWidth()));
}

function logActualTokenUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  totalTokens: number;
}): void {
  const usageByStage = getTokenUsageByStage();
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
    ...(verboseMode && stageLines.length > 0
      ? [
          {
            label: "stages",
            value: stageLines.join(" · "),
          },
        ]
      : []),
  ]);
}

function logCommitPlanAnalysis(analysis: CommitPlanAnalysis): void {
  logPlannedCommits(analysis.groups, analysis.elapsed);

  if (analysis.plannerFallbackNotice) {
    log(`${YELLOW}${analysis.plannerFallbackNotice}${RESET}`);
    log("");
  }
}

function logGenerationContext(
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
) {
  log("");
  logStatusSection("Generating Message", [
    {
      label: "model",
      value: model,
    },
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

function logStatusSection(title: string, rows: StatusRow[]): void {
  writeTerminalLines(
    buildStatusSectionLines(
      title,
      rows as PresentationStatusRow[],
      resolveLogWidth(),
    ),
  );
}

function logTokenEstimate(
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

function logVerboseAiOutput(event: AiOutputEvent): void {
  const eventKey = getVerboseAiOutputSequenceKey(event);
  verboseEventCounts[eventKey] = (verboseEventCounts[eventKey] ?? 0) + 1;
  const lines = formatVerboseAiOutputLines(event, {
    maxWidth: resolveVerboseWidth(),
    mode: outputMode === "trace" ? "trace" : "summary",
    sequence: verboseEventCounts[eventKey],
  });
  logVerboseBlock(lines);
}

// -------- Entry --------

function logVerboseBlock(lines: string[]): void {
  if (!verboseMode) {
    return;
  }

  const label = outputMode === "trace" ? "trace" : "verbose";

  writeTerminalLines(lines.map((line) => `${DIM}[${label}]${RESET} ${line}`));
}

async function main() {
  const args = process.argv.slice(2);
  const hasYFlag = args.includes("-y") || args.includes("--yes");
  const hasNoTokenCheckFlag = args.includes("--no-token-check");
  const hasPlanFlag = args.includes("--plan");
  const hasVerboseFlag = args.includes("-v") || args.includes("--verbose");
  const hasTraceFlag = args.includes("--trace");
  const hasVersionFlag = args.includes("--version");
  // Help flags are special — treat them as commands
  const hasHelpFlag = args.includes("-h") || args.includes("--help");

  // Set verbose mode globally
  outputMode = hasTraceFlag ? "trace" : hasVerboseFlag ? "summary" : "off";
  verboseMode = outputMode !== "off";
  verboseEventCounts = Object.create(null) as Record<string, number>;
  setAiOutputObserver(observeAiOutput);

  // Version flag takes precedence
  if (hasVersionFlag) {
    cmdVersion();
    return;
  }

  const cmd = hasHelpFlag
    ? "help"
    : hasPlanFlag
      ? "plan"
    : (args.find((a) => !a.startsWith("-")) ?? "");

  switch (cmd) {
    case "":
    case "c":
    case "commit":
      await cmdCommit(hasYFlag, hasNoTokenCheckFlag);
      break;
    case "--help":
    case "-h":
    case "help":
      cmdHelp();
      break;
    case "--version":
    case "version":
      cmdVersion();
      break;
    case "g":
    case "gen":
    case "generate":
      await cmdGenerate(hasYFlag || hasNoTokenCheckFlag);
      break;
    case "init":
      cmdInit();
      break;
    case "p":
    case "plan":
      await cmdPlan(hasYFlag || hasNoTokenCheckFlag);
      break;
    case "s":
    case "single":
      await cmdCommitSingle(hasYFlag || hasNoTokenCheckFlag);
      break;
    default:
      die(`Unknown command: ${cmd}. Run 'gitaicmt help' for usage.`);
  }
}

function observeAiOutput(event: AiOutputEvent): void {
  recordPlannerNotice(plannerNoticeState, event);

  if (outputMode !== "off") {
    logVerboseAiOutput(event);
  }
}

/** Prompt the user for y/n. Re-prompts until a valid answer is given. */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const wrappedQuestionLines = wrapTerminalTextBlock(question, resolveLogWidth());

  try {
    for (;;) {
      const answerPromise = new Promise<string>((resolve) => {
        let settled = false;

        const onEnd = () => {
          if (settled) {
            return;
          }
          settled = true;
          process.stdin.off("end", onEnd);
          resolve("__EOF__");
        };

        process.stdin.once("end", onEnd);
        const [promptLine = "", ...leadingLines] = wrappedQuestionLines
          .slice()
          .reverse();
        if (leadingLines.length > 0) {
          writeTerminalLines(leadingLines.reverse());
        }
        rl.question(`${promptLine} ${DIM}(y/n)${RESET} `, (answer) => {
          if (settled) {
            return;
          }
          settled = true;
          process.stdin.off("end", onEnd);
          resolve(answer);
        });
      });

      const answer = await answerPromise;
      if (answer === "__EOF__") {
        writeTerminalLines([""]);
        return true;
      }
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      // Invalid input — re-prompt (no default)
    }
  } finally {
    rl.close();
  }
}

function resolveDisplayWidth(): number {
  const terminalColumns = resolveTerminalColumns({
    fallbackColumns: DEFAULT_VERBOSE_WIDTH,
    streams: [process.stderr, process.stdout],
  });

  return Math.max(24, terminalColumns - 6);
}

function resolveLogWidth(): number {
  const terminalColumns = resolveTerminalColumns({
    fallbackColumns: DEFAULT_VERBOSE_WIDTH,
    streams: [process.stderr, process.stdout],
  });

  return Math.max(20, terminalColumns - 1);
}

function resolveVerboseWidth(): number {
  const terminalColumns = resolveTerminalColumns({
    fallbackColumns: DEFAULT_VERBOSE_WIDTH,
    streams: [process.stderr, process.stdout],
  });

  return Math.max(24, terminalColumns - 14);
}

function shouldPromptForHighTokenUsage(
  estimate: TokenEstimateSummary,
  cfg: ReturnType<typeof loadConfig>,
  options: TokenCheckOptions,
): boolean {
  return (
    !options.skipPrompt &&
    cfg.analysis.promptOnTokenWarning &&
    isHighTokenEstimate(estimate, cfg.analysis.tokenWarningThreshold)
  );
}

function verbose(msg: string) {
  if (verboseMode) {
    const label = outputMode === "trace" ? "trace" : "verbose";
    log(`${DIM}[${label}] ${msg}${RESET}`);
  }
}

// Explicitly exit — the OpenAI HTTP agent and any other async handles
// would otherwise keep the process alive indefinitely after completion.
main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    die(err instanceof Error ? err.message : String(err));
  });
