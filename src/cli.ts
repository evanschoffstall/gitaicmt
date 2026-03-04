#!/usr/bin/env node

import type { PlannedCommitFile } from "./ai.js";
import { generateForChunks, planCommits } from "./ai.js";
import { initConfig, loadConfig } from "./config.js";
import type { DiffHunk, FileDiff } from "./diff.js";
import {
  buildPatch,
  chunkDiffs,
  commitWithMessage,
  formatFileDiff,
  getFileWorkingDiff,
  getStagedDiff,
  getStats,
  hasStagedChanges,
  parseDiff,
  resetStaging,
  stageAll,
  stageFiles,
  stagePatch,
} from "./diff.js";

// -------- Helpers --------

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
 * For files with specific hunks, uses content-matching against the current
 * working tree diff to handle line-number shifts between commits.
 */
function stageGroupFiles(
  group: PlannedCommitFile[],
  originalFiles: Map<string, FileDiff>,
): void {
  const wholeFiles: string[] = [];
  const hunkFiles: PlannedCommitFile[] = [];

  for (const f of group) {
    if (!f.hunks || f.hunks.length === 0) {
      wholeFiles.push(f.path);
    } else {
      hunkFiles.push(f);
    }
  }

  // Stage whole files
  if (wholeFiles.length > 0) {
    stageFiles(wholeFiles);
  }

  // Stage specific hunks via content-matching
  for (const f of hunkFiles) {
    const original = originalFiles.get(f.path);
    if (!original) {
      stageFiles([f.path]);
      continue;
    }

    // Extract the changed-line content for each desired hunk
    const desiredContents = f
      .hunks!.map((i) => {
        if (i >= original.hunks.length) return null;
        const hunk = original.hunks[i];
        return hunk.lines
          .filter((l) => l.startsWith("+") || l.startsWith("-"))
          .join("\n");
      })
      .filter((c): c is string => c !== null);

    if (desiredContents.length === 0) {
      stageFiles([f.path]);
      continue;
    }

    // Get the CURRENT working tree diff for this file (line numbers may have
    // shifted after previous commits)
    let currentDiffRaw: string;
    try {
      currentDiffRaw = getFileWorkingDiff(f.path);
    } catch {
      stageFiles([f.path]);
      continue;
    }

    if (!currentDiffRaw.trim()) {
      stageFiles([f.path]);
      continue;
    }

    const currentFiles = parseDiff(currentDiffRaw);
    if (currentFiles.length === 0) {
      stageFiles([f.path]);
      continue;
    }

    const currentFile = currentFiles[0];

    // Match current hunks to desired hunks by changed-line content
    const hunksToStage: DiffHunk[] = [];
    const usedCurrentHunks = new Set<number>();
    for (const desiredContent of desiredContents) {
      for (let ci = 0; ci < currentFile.hunks.length; ci++) {
        if (usedCurrentHunks.has(ci)) continue;
        const ch = currentFile.hunks[ci];
        const chContent = ch.lines
          .filter((l) => l.startsWith("+") || l.startsWith("-"))
          .join("\n");
        if (chContent === desiredContent) {
          hunksToStage.push(ch);
          usedCurrentHunks.add(ci);
          break;
        }
      }
    }

    if (hunksToStage.length > 0) {
      try {
        const patch = buildPatch(currentFile, hunksToStage);
        stagePatch(patch);
      } catch {
        stageFiles([f.path]);
      }
    } else {
      stageFiles([f.path]);
    }
  }
}

// -------- Commands --------

/** Generate a single commit message (legacy / simple mode) */
async function cmdGenerate() {
  const t0 = performance.now();
  ensureStaged();

  const cfg = loadConfig();
  const raw = getStagedDiff();
  if (!raw.trim()) die("Staged diff is empty.");

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

  const chunks = chunkDiffs(files);
  const stats = getStats(files, chunks);

  log(
    `${DIM}${stats.filesChanged} file(s), +${stats.additions}/-${stats.deletions}, ${stats.chunks} chunk(s)${RESET}`,
  );
  log(`${DIM}model: ${cfg.openai.model}${RESET}`);

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

/** Analyze, split, and execute multiple commits (fully automated) */
async function cmdCommit() {
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

  log(
    `${BOLD}${CYAN}Planned ${groups.length} commit(s)${RESET} ${DIM}(${elapsed}s)${RESET}`,
  );
  log("");

  // Build file lookup for hunk-level staging
  const fileMap = new Map(files.map((f) => [f.path, f]));

  // Execute each commit group
  let committed = 0;
  try {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const subject = g.message.split("\n")[0];

      log(`${BOLD}${GREEN}[${i + 1}/${groups.length}]${RESET} ${subject}`);
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
      `${RED}${BOLD}Failed after ${committed}/${groups.length} commits.${RESET}`,
    );
    // Try to restore remaining files to staged state
    if (committed < groups.length) {
      const remainingPaths = groups
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
  log(`${BOLD}gitaicmt${RESET} — Fully automated AI-powered git commits\n`);
  log(`${CYAN}Commands:${RESET}`);
  log("  gitaicmt              Auto-detect changes, split & commit (default)");
  log(
    "  gitaicmt plan         Preview planned commit groups without committing",
  );
  log("  gitaicmt single       One commit for all changes");
  log("  gitaicmt gen          Generate message to stdout (for piping)");
  log("  gitaicmt init         Create default gitaicmt.config.json");
  log("  gitaicmt help         Show this help\n");
  log(`${CYAN}Usage:${RESET}`);
  log("  gitaicmt                         Detect, analyze & commit everything");
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
  const cmd = process.argv[2] ?? "";

  switch (cmd) {
    case "":
    case "commit":
    case "c":
      await cmdCommit();
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
