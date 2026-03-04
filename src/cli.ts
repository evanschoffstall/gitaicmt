#!/usr/bin/env node

import { createInterface } from "node:readline";
import type { PlannedCommit, PlannedCommitFile } from "./ai.js";
import { generateForChunks, planCommits } from "./ai.js";
import { initConfig, loadConfig } from "./config.js";
import type { FileDiff } from "./diff.js";
import { chunkDiffs, formatFileDiff, getStats, parseDiff } from "./diff.js";
import {
  commitWithMessage,
  getStagedDiff,
  hasStagedChanges,
  resetStaging,
  stageAll,
  stageFiles,
} from "./git.js";

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
  if (hasStagedChanges()) return;
  log(`${DIM}No staged changes detected, auto-staging all changes...${RESET}`);
  stageAll();
  if (!hasStagedChanges()) {
    die("No changes to commit.");
  }
}

/** Format a PlannedCommitFile for display */
function formatCommitFile(f: PlannedCommitFile): string {
  if (f.hunks && f.hunks.length > 0) {
    return `${f.path} (hunks: ${f.hunks.join(", ")})`;
  }
  return f.path;
}

/**
 * Stage files for a commit group, handling hunk-level staging.
 * This version stages whole files to avoid complex hunk-matching issues.
 */
function stageGroupFiles(
  group: PlannedCommitFile[],
  originalFiles: Map<string, FileDiff>,
): void {
  // Collect all unique file paths from the group
  const filesToStage = Array.from(new Set(group.map((f) => f.path)));

  if (filesToStage.length > 0) {
    try {
      stageFiles(filesToStage);
    } catch (err) {
      log(`${RED}Error staging files: ${err}${RESET}`);
      throw err;
    }
  }
}

/** Prompt the user for y/n. Re-prompts until a valid answer is given. */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${question} ${DIM}(y/n)${RESET} `, resolve);
      });
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      // Invalid input — re-prompt (no default)
    }
  } finally {
    rl.close();
  }
}

/** Display planned commit groups */
function displayPlan(
  groups: { files: PlannedCommitFile[]; message: string }[],
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
    log(`  ${DIM}Files: ${g.files.map(formatCommitFile).join(", ")}${RESET}`);
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

  displayPlan(groups);
}

/**
 * Merge commits that touch the same files to avoid staging conflicts.
 * When multiple commits reference the same file, combine them into one commit.
 */
function mergeCommitsByFile(groups: PlannedCommit[]): PlannedCommit[] {
  const fileToGroup = new Map<string, number>();
  const merged: PlannedCommit[] = [];

  for (const group of groups) {
    // Get all unique files in this group
    const groupFiles = group.files.map((f) => f.path);

    // Check if any of these files are already in a previous group
    let mergeIntoIndex: number | null = null;
    for (const file of groupFiles) {
      if (fileToGroup.has(file)) {
        mergeIntoIndex = fileToGroup.get(file)!;
        break;
      }
    }

    if (mergeIntoIndex !== null) {
      // Merge into existing group
      const target = merged[mergeIntoIndex];
      // Add files that aren't already there
      for (const f of group.files) {
        if (!target.files.some((tf) => tf.path === f.path)) {
          target.files.push({ path: f.path }); // Ignore hunks for simplicity
        }
      }
      // Combine messages
      target.message = target.message + "\n\n" + group.message;
    } else {
      // New group
      const newGroup: PlannedCommit = {
        files: group.files.map((f) => ({ path: f.path })), // Ignore hunks
        message: group.message,
      };
      merged.push(newGroup);

      // Track which files are in which group
      const index = merged.length - 1;
      for (const file of groupFiles) {
        fileToGroup.set(file, index);
      }
    }
  }

  return merged;
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

  // Merge commits that touch the same files to avoid staging conflicts
  const mergedGroups = mergeCommitsByFile(groups);
  if (mergedGroups.length < groups.length) {
    log(
      `${YELLOW}Note: Merged ${groups.length} commits into ${mergedGroups.length} to avoid file conflicts${RESET}`,
    );
    log("");
  }

  displayPlan(mergedGroups);

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

  // Build file lookup for hunk-level staging
  const fileMap = new Map(files.map((f) => [f.path, f]));

  // Execute each commit group
  let committed = 0;
  try {
    for (let i = 0; i < mergedGroups.length; i++) {
      const g = mergedGroups[i];
      const subject = g.message.split("\n")[0];

      log(
        `${BOLD}${GREEN}[${i + 1}/${mergedGroups.length}]${RESET} ${subject}`,
      );
      log(`  ${DIM}${g.files.map(formatCommitFile).join(", ")}${RESET}`);

      // Unstage everything, then stage only this group's files/hunks
      resetStaging();
      stageGroupFiles(g.files, fileMap);

      // Commit
      commitWithMessage(g.message);
      committed++;
      log("");
    }

    const totalElapsed = ((performance.now() - t0) / 1000).toFixed(1);
    log(
      `${GREEN}${BOLD}Done:${RESET} ${committed} commit(s) in ${totalElapsed}s`,
    );
  } catch (err) {
    log(
      `${RED}${BOLD}Failed after ${committed}/${mergedGroups.length} commits.${RESET}`,
    );
    // Try to restore remaining files to staged state
    if (committed < mergedGroups.length) {
      const remainingPaths = mergedGroups
        .slice(committed)
        .flatMap((g) => g.files.map((f) => f.path));
      try {
        stageFiles(remainingPaths);
        log(`${YELLOW}Remaining files re-staged.${RESET}`);
      } catch {
        log(
          `${RED}Could not re-stage files. Run: git add ${remainingPaths.join(" ")}${RESET}`,
        );
      }
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

main().catch((err: Error) => {
  die(err.message);
});
