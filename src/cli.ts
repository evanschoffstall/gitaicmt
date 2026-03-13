#!/usr/bin/env node

import { createInterface } from "node:readline";

import { getTokenUsageSummary, resetTokenUsageSummary } from "./ai-client.js";
import {
  estimateGenerateOperationTokens,
  estimatePlanOperationTokens,
  generateForChunks,
  planCommits,
  type PlannedCommitFile,
  type TokenEstimateSummary,
} from "./ai.js";
import { initConfig, loadConfig } from "./config.js";
import {
  chunkDiffs,
  type FileDiff,
  formatFileDiff,
  getStats,
  parseDiff,
} from "./diff.js";
import {
  commitWithMessage,
  getStagedDiff,
  getStagedFiles,
  hasStagedChanges,
  isGitRepository,
  resetStaging,
  stageAll,
  stageFiles,
} from "./git.js";
import { mergeCommitsByFile } from "./merge.js";
import { stageGroupFiles } from "./staging.js";
import { withThinkingIndicator } from "./terminal-ui.js";

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

interface TokenCheckOptions {
  skipPrompt: boolean;
}

async function analyzeCommitPlan(tokenCheckOptions: TokenCheckOptions) {
  const t0 = performance.now();
  ensureStaged();

  const raw = getStagedDiff();
  if (!raw.trim()) die("Staged diff is empty.");

  const files = parseDiff(raw);
  const cfg = loadConfig();
  const tokenEstimate = estimatePlanOperationTokens(files, formatFileDiff, cfg);
  const shouldPromptForTokenUsage = shouldPromptForHighTokenUsage(
    tokenEstimate,
    cfg,
    tokenCheckOptions,
  );
  log(
    `${DIM}Analyzing ${formatCount(files.length)} file(s) with ${cfg.openai.model}...${RESET}`,
  );
  logTokenEstimate(
    tokenEstimate,
    cfg.analysis.tokenWarningThreshold,
    shouldPromptForTokenUsage,
  );
  if (!(await confirmTokenUsage(tokenEstimate, cfg, tokenCheckOptions))) {
    return null;
  }

  const groups = await withThinkingIndicator(() =>
    planCommits(files, formatFileDiff),
  );
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  return { elapsed, files, groups };
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

  const { elapsed, files, groups } = analysis;

  logPlannedCommits(groups, elapsed);

  // Deduplicate commits that would produce staging conflicts
  const mergedGroups = mergeCommitsByFile(groups);
  if (mergedGroups.length < groups.length) {
    const dropped = groups.length - mergedGroups.length;
    log(
      `${YELLOW}Note: Dropped ${formatCount(dropped)} duplicate commit(s) whose files were already covered${RESET}`,
    );
    log("");
  }

  // Build file lookup for hunk-level staging
  const fileMap = new Map(files.map((f) => [f.path, f]));

  displayPlan(mergedGroups, fileMap);

  // Confirm before committing
  if (!autoConfirm) {
    logActualTokenUsage(getTokenUsageSummary());
    const confirmed = await promptYesNo(
      `${BOLD}Commit ${formatCount(mergedGroups.length)} planned commit(s)?${RESET}`,
    );
    if (!confirmed) {
      log(`${YELLOW}Aborted.${RESET}`);
      return;
    }
    log("");
  }

  // Execute each commit group
  let committed = 0;
  let initialStagedFiles: string[] = [];

  // Save initial staging state for recovery
  try {
    initialStagedFiles = getStagedFiles();
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
        `  ${DIM}${g.files.map((f) => formatCommitFile(f, fileMap)).join(", ")}${RESET}`,
      );

      // Unstage everything, then stage only this group's files/hunks
      resetStaging();
      stageGroupFiles(g.files, fileMap);

      // Skip if nothing ended up staged (files already committed, gitignored, etc.)
      if (!hasStagedChanges()) {
        log(
          `${YELLOW}  (skipped — no stageable changes remain for this group)${RESET}`,
        );
        log("");
        continue;
      }

      // Commit
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
    if (committed < mergedGroups.length && initialStagedFiles.length > 0) {
      log(`${YELLOW}Attempting to restore initial staging state...${RESET}`);
      try {
        resetStaging();
        if (initialStagedFiles.length > 0) {
          stageFiles(initialStagedFiles);
          log(`${GREEN}Initial staging state restored successfully.${RESET}`);
        }
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
  const shouldPromptForTokenUsage = shouldPromptForHighTokenUsage(
    tokenEstimate,
    cfg,
    {
      skipPrompt: skipTokenCheck,
    },
  );
  logGenerationContext(
    cfg.openai.model,
    stats,
    tokenEstimate,
    cfg.analysis.tokenWarningThreshold,
    shouldPromptForTokenUsage,
  );
  if (
    !(await confirmTokenUsage(tokenEstimate, cfg, {
      skipPrompt: skipTokenCheck,
    }))
  ) {
    log(`${YELLOW}Aborted.${RESET}`);
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
  const shouldPromptForTokenUsage = shouldPromptForHighTokenUsage(
    tokenEstimate,
    cfg,
    {
      skipPrompt: skipTokenCheck,
    },
  );

  logGenerationContext(
    cfg.openai.model,
    stats,
    tokenEstimate,
    cfg.analysis.tokenWarningThreshold,
    shouldPromptForTokenUsage,
  );
  if (
    !(await confirmTokenUsage(tokenEstimate, cfg, {
      skipPrompt: skipTokenCheck,
    }))
  ) {
    log(`${YELLOW}Aborted.${RESET}`);
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
  log("  -v, --verbose         Show detailed operation logs");
  log("  --version             Show version information");
  log("  -h, --help            Show this help\n");
  log(`${CYAN}Usage:${RESET}`);
  log("  gitaicmt                         Detect, analyze, confirm & commit");
  log(
    "  gitaicmt -y                      Detect, analyze & commit (no prompt)",
  );
  log("  gitaicmt -v plan                 Show verbose logs during planning");
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

  const { elapsed, files, groups } = analysis;

  logPlannedCommits(groups, elapsed);

  const fileMap = new Map(files.map((f) => [f.path, f]));
  displayPlan(groups, fileMap);
}

/** Show version information */
function cmdVersion() {
  log(`gitaicmt v${VERSION}`);
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
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    log(
      `${BOLD}${GREEN}Commit ${formatCount(i + 1)}/${formatCount(groups.length)}:${RESET}`,
    );
    log(`  ${BOLD}${g.message.split("\n")[0]}${RESET}`);
    const body = g.message.split("\n").slice(1).join("\n").trim();
    if (body) {
      for (const line of body.split("\n")) {
        log(`  ${DIM}${line}${RESET}`);
      }
    }
    log(
      `  ${DIM}Files: ${g.files.map((f) => formatCommitFile(f, fileDiffs)).join(", ")}${RESET}`,
    );
    log("");
  }
}

/** Ensure changes are staged. If nothing is staged, auto-stage all changes. */
function ensureStaged(): void {
  // First check if we're in a git repository
  if (!isGitRepository()) {
    die(
      "Not a git repository. Run 'git init' first or cd into a git repository.",
    );
  }

  try {
    if (hasStagedChanges()) return;
  } catch (err: unknown) {
    // Git command failed - provide helpful error
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("does not have any commits yet") ||
        msg.includes("no commits")
      ) {
        die(
          "Git repository has no commits yet. Create an initial commit first:\n  git commit --allow-empty -m 'Initial commit'",
        );
      }
      // Re-throw with original message if not a known case
      die(err.message);
    }
    throw err; // Re-throw unexpected errors
  }

  log(`${DIM}No staged changes detected, auto-staging all changes...${RESET}`);
  stageAll();
  if (!hasStagedChanges()) {
    die("No changes to commit.");
  }
}

// -------- Commands --------

/** Format a PlannedCommitFile for display */
function formatCommitFile(
  f: PlannedCommitFile,
  fileDiffs?: Map<string, FileDiff>,
): string {
  if (!f.hunks || f.hunks.length === 0) return f.path;
  const total = fileDiffs?.get(f.path)?.hunks.length;
  const idx = f.hunks.join(", ");
  const word = f.hunks.length === 1 ? "hunk" : "hunks";
  const suffix =
    total !== undefined
      ? `[${word} ${idx} / ${formatCount(total)}]`
      : `[${word} ${idx}]`;
  return `${f.path} ${suffix}`;
}

function formatCount(value: number): string {
  return String(value);
}

function formatTokenWarning(tokenWarningThreshold: number): string {
  return `Estimated token usage exceeds threshold (${formatCount(tokenWarningThreshold)}).`;
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
  process.stderr.write(msg + "\n");
}

function logActualTokenUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  totalTokens: number;
}): void {
  log(
    `${DIM}tokens used: ${formatCount(usage.totalTokens)} total across ${formatCount(usage.requestCount)} request(s)${RESET}`,
  );
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
  log(
    `${DIM}${formatCount(stats.filesChanged)} file(s), +${formatCount(stats.additions)}/-${formatCount(stats.deletions)}, ${formatCount(stats.chunks)} chunk(s)${RESET}`,
  );
  log(`${DIM}model: ${model}${RESET}`);
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
  log(
    `${BOLD}${CYAN}Planned ${formatCount(groups.length)} commit(s):${RESET} ${DIM}(${elapsed}s)${RESET}`,
  );
  log("");
}

function logTokenEstimate(
  estimate: TokenEstimateSummary,
  tokenWarningThreshold: number,
  suppressWarning = false,
): void {
  if (estimate.requestCount === 0) {
    return;
  }

  log(
    `${DIM}estimated tokens: ~${formatCount(estimate.totalTokens)} total across ${formatCount(estimate.requestCount)} request(s), peak ~${formatCount(estimate.peakRequestTokens)}/request${RESET}`,
  );

  if (
    !suppressWarning &&
    isHighTokenEstimate(estimate, tokenWarningThreshold)
  ) {
    log(`${YELLOW}${formatTokenWarning(tokenWarningThreshold)}${RESET}`);
  }
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

async function main() {
  const args = process.argv.slice(2);
  const hasYFlag = args.includes("-y") || args.includes("--yes");
  const hasNoTokenCheckFlag = args.includes("--no-token-check");
  const hasVerboseFlag = args.includes("-v") || args.includes("--verbose");
  const hasVersionFlag = args.includes("--version");
  // Help flags are special — treat them as commands
  const hasHelpFlag = args.includes("-h") || args.includes("--help");

  // Set verbose mode globally
  verboseMode = hasVerboseFlag;

  // Version flag takes precedence
  if (hasVersionFlag) {
    cmdVersion();
    return;
  }

  const cmd = hasHelpFlag
    ? "help"
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

// -------- Entry --------

/** Prompt the user for y/n. Re-prompts until a valid answer is given. */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  // Add timeout protection (5 minutes max) to prevent indefinite hangs
  const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("User prompt timed out after 5 minutes"));
    }, PROMPT_TIMEOUT_MS);
  });

  try {
    for (;;) {
      const answerPromise = new Promise<string>((resolve) => {
        rl.question(`${question} ${DIM}(y/n)${RESET} `, resolve);
      });

      const answer = await Promise.race([answerPromise, timeoutPromise]);
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      // Invalid input — re-prompt (no default)
    }
  } finally {
    // Always clear the timeout so it doesn't hold the event loop open
    clearTimeout(timeoutId);
    rl.close();
  }
}

function verbose(msg: string) {
  if (verboseMode) {
    log(`${DIM}[verbose] ${msg}${RESET}`);
  }
}

// Explicitly exit — the OpenAI HTTP agent and any other async handles
// would otherwise keep the process alive indefinitely after completion.
main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    die(err instanceof Error ? err.message : String(err));
  });
