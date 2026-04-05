import { hasCommitHistory, hasStagedChanges, isGitRepository, stageAll } from "../git/operations.js";
import { die } from "./fatal.js";
import { log } from "./session-display.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function ensureStaged(): void {
  if (!isGitRepository()) {
    die("Not a git repository. Run 'git init' first or cd into a git repository.");
  }
  if (!hasCommitHistory()) {
    die("Git repository has no commits yet. Create an initial commit first:\n  git commit --allow-empty -m 'Initial commit'");
  }

  try {
    if (hasStagedChanges()) {
      return;
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      die(error.message);
    }
    throw error;
  }

  log(`${DIM}No staged changes detected, auto-staging all changes...${RESET}`);
  stageAll();
  if (!hasStagedChanges()) {
    die("No changes to commit.");
  }
}