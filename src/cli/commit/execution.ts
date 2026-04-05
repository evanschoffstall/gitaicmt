import type { PlannedCommitFile } from "../../commit-planning/orchestration.js";
import type { FileDiff } from "../../git/diff.js";

import {
  commitWithMessage,
  getStagedPatch,
  hasStagedChanges,
  resetStaging,
  restoreStagedPatch,
} from "../../git/operations.js";
import { formatCount } from "../counts.js";
import {
  buildExecutionCommitLines,
  buildExecutionResultLines,
} from "../output-presentation.js";
import { log } from "../session-display.js";
import { writeTerminalLines } from "../terminal/output-ui.js";
import { resolveDisplayWidth } from "../viewport.js";
import { stageGroupFiles } from "./group-staging.js";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";

export function executePlannedCommits(
  groups: { files: PlannedCommitFile[]; message: string }[],
  fileMap: Map<string, FileDiff>,
): void {
  const startedAtMs = performance.now();
  let committed = 0;
  const initialStagedPatch = captureInitialStagingPatch();

  try {
    for (let index = 0; index < groups.length; index++) {
      committed += executeCommitGroup(groups, fileMap, index);
    }

    logCommitCompletion(committed, groups.length, startedAtMs);
  } catch (error) {
    restoreStagingAfterFailure(committed, groups.length, initialStagedPatch);
    throw error;
  }
}

export function executeSingleCommitMessage(message: string): void {
  renderCommitExecutionResult(commitWithMessage(message));
}

function captureInitialStagingPatch(): string {
  try {
    return getStagedPatch();
  } catch {
    log(`${YELLOW}Warning: Could not save initial staging state for recovery${RESET}`);
    return "";
  }
}

function executeCommitGroup(
  groups: { files: PlannedCommitFile[]; message: string }[],
  fileMap: Map<string, FileDiff>,
  index: number,
): 0 | 1 {
  const group = groups[index];
  renderCommitGroupHeader(group, groups.length, fileMap, index);

  resetStaging();
  stageGroupFiles(group.files, fileMap);
  if (!hasStagedChanges()) {
    log(`${YELLOW}  (skipped - no stageable changes remain for this group)${RESET}`);
    log("");
    return 0;
  }

  renderCommitExecutionResult(commitWithMessage(group.message));
  log("");
  return 1;
}

function logCommitCompletion(
  committed: number,
  total: number,
  startedAtMs: number,
): void {
  const totalElapsed = ((performance.now() - startedAtMs) / 1000).toFixed(1);
  const skipped = total - committed;
  const skippedNote = skipped > 0 ? `, ${formatCount(skipped)} skipped` : "";
  log(`${GREEN}${BOLD}Done:${RESET} ${formatCount(committed)} commit(s) in ${totalElapsed}s${skippedNote}`);
}

function renderCommitExecutionResult(result: { stderr: string; stdout: string }): void {
  const executionResultLines = buildExecutionResultLines(
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
    resolveDisplayWidth(),
  );
  if (executionResultLines.length > 0) {
    writeTerminalLines(executionResultLines);
  }
}

function renderCommitGroupHeader(
  group: { files: PlannedCommitFile[]; message: string },
  total: number,
  fileMap: Map<string, FileDiff>,
  index: number,
): void {
  writeTerminalLines(
    buildExecutionCommitLines({
      fileDiffs: fileMap,
      files: group.files,
      index: index + 1,
      maxWidth: resolveDisplayWidth(),
      subject: group.message.split("\n")[0],
      total,
    }),
  );
}

function restoreStagingAfterFailure(
  committed: number,
  total: number,
  initialStagedPatch: string,
): void {
  log(`${RED}${BOLD}Failed after ${formatCount(committed)}/${formatCount(total)} commits.${RESET}`);
  if (committed < total && initialStagedPatch.trim().length > 0) {
    log(`${YELLOW}Attempting to restore initial staging state...${RESET}`);
    try {
      resetStaging();
      restoreStagedPatch(initialStagedPatch);
      log(`${GREEN}Initial staging state restored successfully.${RESET}`);
    } catch {
      log(`${RED}Failed to restore staging state.${RESET}`);
      log(`${YELLOW}Manual recovery: Review 'git status' and 'git log' to assess state.${RESET}`);
      log(`${YELLOW}Previous ${formatCount(committed)} commits were completed successfully.${RESET}`);
    }
    return;
  }

  log(`${YELLOW}Manual recovery required: Check 'git status' and 'git log'.${RESET}`);
}