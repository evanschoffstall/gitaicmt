#!/usr/bin/env node

import { createInterface } from "node:readline";
import type { PlannedCommitFile } from "./ai.js";
import { generateForChunks, planCommits } from "./ai.js";
import { initConfig, loadConfig } from "./config.js";
import type { FileDiff } from "./diff.js";
import {
  chunkDiffs,
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

function log(msg: string) {
  process.stderr.write(msg + "\n");
}

function verbose(msg: string) {
  if (verboseMode) {
    log(`${DIM}[verbose] ${msg}${RESET}`);
  }
}

function die(msg: string): never {
  log(`${RED}error:${RESET} ${msg}`);
  process.exit(1);
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
      ? `[${word} ${idx} / ${total}]`
      : `[${word} ${idx}]`;
  return `${f.path} ${suffix}`;
}

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
    while (true) {
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

/** Display planned commit groups */
function displayPlan(
  groups: { files: PlannedCommitFile[]; message: string }[],
  fileDiffs?: Map<string, FileDiff>,
): void {
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    log(`${BOLD}${GREEN}Commit ${i + 1}/${groups.length}:${RESET}`);
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

// -------- Commands --------

/** Show version information */
function cmdVersion() {
  log(`gitaicmt v${VERSION}`);
}

/** Generate a single commit message (legacy / simple mode) */
async function cmdGenerate() {
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
      `${YELLOW}Warning: diff is ${totalLines} lines (limit: ${cfg.analysis.maxDiffLines}). Results may be truncated.${RESET}`,
    );
  }

  verbose("Chunking diffs");
  const chunks = chunkDiffs(files);
  const stats = getStats(files, chunks);

  log(
    `${DIM}${stats.filesChanged} file(s), +${stats.additions}/-${stats.deletions}, ${stats.chunks} chunk(s)${RESET}`,
  );
  log(`${DIM}model: ${cfg.openai.model}${RESET}`);

  verbose("Calling OpenAI API");
  const message = await generateForChunks(chunks, stats);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  log(`${DIM}(${elapsed}s)${RESET}`);
  log("");

  // Print commit message to stdout so it can be piped
  process.stdout.write(message + "\n");
}

/** Analyze diffs and plan multiple commits (print plan without committing) */
async function cmdPlan() {
  const t0 = performance.now();
  ensureStaged();

  const raw = getStagedDiff();
  if (!raw.trim()) die("Staged diff is empty.");

  const files = parseDiff(raw);
  const cfg = loadConfig();
  log(
    `${DIM}Analyzing ${files.length} file(s) with ${cfg.openai.model}...${RESET}`,
  );

  const groups = await planCommits(files, formatFileDiff);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  log("");
  log(
    `${BOLD}${CYAN}Planned ${groups.length} commit(s):${RESET} ${DIM}(${elapsed}s)${RESET}`,
  );
  log("");

  const fileMap = new Map(files.map((f) => [f.path, f]));
  displayPlan(groups, fileMap);
}

/** Analyze, split, and execute multiple commits */
async function cmdCommit(autoConfirm: boolean) {
  const t0 = performance.now();
  ensureStaged();

  const raw = getStagedDiff();
  if (!raw.trim()) die("Staged diff is empty.");

  const files = parseDiff(raw);
  const cfg = loadConfig();
  log(
    `${DIM}Analyzing ${files.length} file(s) with ${cfg.openai.model}...${RESET}`,
  );

  const groups = await planCommits(files, formatFileDiff);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  log("");
  log(
    `${BOLD}${CYAN}Planned ${groups.length} commit(s):${RESET} ${DIM}(${elapsed}s)${RESET}`,
  );
  log("");

  // Deduplicate commits that would produce staging conflicts
  const mergedGroups = mergeCommitsByFile(groups);
  if (mergedGroups.length < groups.length) {
    const dropped = groups.length - mergedGroups.length;
    log(
      `${YELLOW}Note: Dropped ${dropped} duplicate commit(s) whose files were already covered${RESET}`,
    );
    log("");
  }

  // Build file lookup for hunk-level staging
  const fileMap = new Map(files.map((f) => [f.path, f]));

  displayPlan(mergedGroups, fileMap);

  // Confirm before committing
  if (!autoConfirm) {
    const confirmed = await promptYesNo(
      `${BOLD}Commit ${mergedGroups.length} planned commit(s)?${RESET}`,
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
  } catch (err) {
    log(
      `${YELLOW}Warning: Could not save initial staging state for recovery${RESET}`,
    );
  }

  try {
    for (let i = 0; i < mergedGroups.length; i++) {
      const g = mergedGroups[i];
      const subject = g.message.split("\n")[0];

      log(
        `${BOLD}${GREEN}[${i + 1}/${mergedGroups.length}]${RESET} ${subject}`,
      );
      log(`  ${DIM}${g.files.map((f) => formatCommitFile(f, fileMap)).join(", ")}${RESET}`);

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

    const totalElapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const skipped = mergedGroups.length - committed;
    const skippedNote = skipped > 0 ? `, ${skipped} skipped` : "";
    log(
      `${GREEN}${BOLD}Done:${RESET} ${committed} commit(s) in ${totalElapsed}s${skippedNote}`,
    );
  } catch (err) {
    log(
      `${RED}${BOLD}Failed after ${committed}/${mergedGroups.length} commits.${RESET}`,
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
      } catch (restoreErr) {
        log(`${RED}Failed to restore staging state.${RESET}`);
        log(
          `${YELLOW}Manual recovery: Review 'git status' and 'git log' to assess state.${RESET}`,
        );
        log(
          `${YELLOW}Previous ${committed} commits were completed successfully.${RESET}`,
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
async function cmdCommitSingle() {
  const t0 = performance.now();
  ensureStaged();

  const raw = getStagedDiff();
  if (!raw.trim()) die("Staged diff is empty.");

  const files = parseDiff(raw);
  const chunks = chunkDiffs(files);
  const stats = getStats(files, chunks);

  log(
    `${DIM}${stats.filesChanged} file(s), +${stats.additions}/-${stats.deletions}, ${stats.chunks} chunk(s)${RESET}`,
  );

  const cfg = loadConfig();
  log(`${DIM}model: ${cfg.openai.model}${RESET}`);

  const message = await generateForChunks(chunks, stats);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  log(`${GREEN}${BOLD}Commit message:${RESET}`);
  log(message);
  log(`${DIM}(${elapsed}s)${RESET}`);

  // Execute commit
  commitWithMessage(message);
}

function cmdInit() {
  const path = initConfig();
  log(`${GREEN}Created config:${RESET} ${path}`);
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

// -------- Entry --------

async function main() {
  const args = process.argv.slice(2);
  const hasYFlag = args.includes("-y") || args.includes("--yes");
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
    case "commit":
    case "c":
      await cmdCommit(hasYFlag);
      break;
    case "plan":
    case "p":
      await cmdPlan();
      break;
    case "single":
    case "s":
      await cmdCommitSingle();
      break;
    case "generate":
    case "gen":
    case "g":
      await cmdGenerate();
      break;
    case "init":
      cmdInit();
      break;
    case "version":
    case "--version":
      cmdVersion();
      break;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      die(`Unknown command: ${cmd}. Run 'gitaicmt help' for usage.`);
  }
}

// Explicitly exit — the OpenAI HTTP agent and any other async handles
// would otherwise keep the process alive indefinitely after completion.
main()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    die(err.message);
  });
