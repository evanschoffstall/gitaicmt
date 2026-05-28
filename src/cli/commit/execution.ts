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

/**
 * Commit execution options used when replaying previously saved plan entries.
 */
export interface CommitExecutionOptions {
  cwd?: string;
  ignoreMessageBody?: boolean;
}

export function executePlannedCommits(
  groups: { files: PlannedCommitFile[]; message: string }[],
  fileMap: Map<string, FileDiff>,
  options: CommitExecutionOptions = {},
): void {
  const startedAtMs = performance.now();
  let committed = 0;

  try {
    for (let index = 0; index < groups.length; index++) {
      committed += executeCommitGroup(groups, fileMap, index, options);
    }

    logCommitCompletion(committed, groups.length, startedAtMs);
  } catch (error) {
    logCommitFailure(committed, groups.length);
    throw error;
  }
}

export function executeSingleCommitMessage(message: string): void {
  renderCommitExecutionResult(commitWithMessage(message));
}

/**
 * Capture the staged patch that existed immediately before a single replay
 * step mutates the index so failures can restore the remaining staged plan.
 */
function captureStagedPatchBeforeGroup(cwd?: string): null | string {
  try {
    return getStagedPatch(cwd);
  } catch {
    log(
      `${YELLOW}Warning: Could not capture staged changes before this commit step for recovery.${RESET}`,
    );
    return null;
  }
}

function executeCommitGroup(
  groups: { files: PlannedCommitFile[]; message: string }[],
  fileMap: Map<string, FileDiff>,
  index: number,
  options: CommitExecutionOptions,
): 0 | 1 {
  const group = groups[index];
  const stagedPatchBeforeGroup = captureStagedPatchBeforeGroup(options.cwd);
  renderCommitGroupHeader(group, groups.length, fileMap, index);

  try {
    resetStaging(options.cwd);
    stageGroupFiles(group.files, fileMap, options.cwd);
    if (!hasStagedChanges(options.cwd)) {
      log(
        `${YELLOW}  (skipped - no stageable changes remain for this group)${RESET}`,
      );
      log("");
      return 0;
    }

    renderCommitExecutionResult(
      commitWithMessage(group.message, options.cwd, {
        ignoreMessageBody: shouldIgnoreMessageBodyDuringExecution(
          group.message,
          options.ignoreMessageBody,
        ),
      }),
    );
    log("");
    return 1;
  } catch (error) {
    restoreStagingAfterFailedCommitStep(stagedPatchBeforeGroup, options.cwd);
    throw error;
  }
}

function isSubjectOnlyCommitMessage(message: string): boolean {
  return message.replace(/\r\n/g, "\n").trim().split("\n").length === 1;
}

function logCommitCompletion(
  committed: number,
  total: number,
  startedAtMs: number,
): void {
  const totalElapsed = ((performance.now() - startedAtMs) / 1000).toFixed(1);
  const skipped = total - committed;
  const skippedNote = skipped > 0 ? `, ${formatCount(skipped)} skipped` : "";
  log(
    `${GREEN}${BOLD}Done:${RESET} ${formatCount(committed)} commit(s) in ${totalElapsed}s${skippedNote}`,
  );
}

function logCommitFailure(committed: number, total: number): void {
  log(
    `${RED}${BOLD}Failed after ${formatCount(committed)}/${formatCount(total)} commits.${RESET}`,
  );
  if (committed > 0) {
    log(
      `${YELLOW}Previous ${formatCount(committed)} commits were completed successfully.${RESET}`,
    );
  }

  log(
    `${YELLOW}Manual recovery: Review 'git status' and 'git log' to assess state.${RESET}`,
  );
}

function renderCommitExecutionResult(result: {
  stderr: string;
  stdout: string;
}): void {
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

/**
 * Restore the staged patch that existed before the failed replay step so the
 * remaining uncommitted plan stays staged instead of being lost by restaging.
 */
function restoreStagingAfterFailedCommitStep(
  stagedPatchBeforeGroup: null | string,
  cwd?: string,
): void {
  if (stagedPatchBeforeGroup === null) {
    return;
  }

  try {
    resetStaging(cwd);
    if (stagedPatchBeforeGroup.trim().length > 0) {
      restoreStagedPatch(stagedPatchBeforeGroup, cwd);
      log(
        `${YELLOW}Restored staged changes that existed before the failed commit step.${RESET}`,
      );
      return;
    }

    log(
      `${YELLOW}Cleared staged changes from the failed commit step because none were staged before it began.${RESET}`,
    );
  } catch {
    log(
      `${RED}Failed to restore the staged changes that existed before the failed commit step.${RESET}`,
    );
  }
}

function shouldIgnoreMessageBodyDuringExecution(
  message: string,
  ignoreMessageBody: boolean | undefined,
): boolean {
  return ignoreMessageBody ?? isSubjectOnlyCommitMessage(message);
}
