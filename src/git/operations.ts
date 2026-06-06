import { spawnSync } from "node:child_process";

import { DIFF_CONTEXT_LINES } from "../application/constants.js";
import { GitCommandError } from "../application/errors.js";
import {
  type CommitInputValidationOptions,
  validateCommitInput,
} from "./commit-input-validation.js";
import { createCommitFailure, createGitCommandFailure } from "./failures.js";
import { sanitizeGitOutput } from "./output-sanitization.js";
import { sanitizeFilePath } from "./path-validation.js";
import { createGitProcessEnv } from "./process-environment.js";
import { didGitSpawnSucceed } from "./spawn-success.js";
import { runGitCommand } from "./subprocess.js";

const CANONICAL_DIFF_PREFIX_ARGS = ["--src-prefix=a/", "--dst-prefix=b/"];

// ============================================================================
// Repository Validation
// ============================================================================

/**
 * Commit with a message (supports multi-line subject + body via stdin).
 *
 * This intentionally respects the repository's configured commit-signing
 * policy instead of overriding it at the command level.
 *
 * @param message - The commit message (can include newlines for body)
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @param validationOptions - Explicit validation overrides for replay flows.
 * @throws {GitCommandError} If message is empty or commit fails
 */
export function commitWithMessage(
  message: string,
  cwd?: string,
  validationOptions: CommitInputValidationOptions = {},
): { stderr: string; stdout: string } {
  const validatedMessage = validateCommitInput(message, validationOptions);

  const dir = cwd ?? process.cwd();
  const result = spawnSync("git", ["commit", "-F", "-"], {
    cwd: dir,
    encoding: "utf-8",
    env: createGitProcessEnv(),
    input: validatedMessage,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw createCommitFailure(
      result.status,
      result.stderr.trim(),
      result.error?.message,
    );
  }

  return {
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

/**
 * Get staged diff with specified context lines
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @returns The unified diff output from git diff --cached
 * @throws {GitCommandError} If git command fails
 */
export function getStagedDiff(cwd?: string): string {
  return execGit(
    [
      "diff",
      "--cached",
      ...CANONICAL_DIFF_PREFIX_ARGS,
      `--unified=${String(DIFF_CONTEXT_LINES)}`,
    ],
    {
      cwd,
    },
  );
}

/**
 * Get list of currently staged file paths
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @returns Array of staged file paths
 * @throws {GitCommandError} If git command fails
 */
export function getStagedFiles(cwd?: string): string[] {
  const out = execGit(["diff", "--cached", "--name-only"], { cwd });
  return out.trim().split("\n").filter(Boolean);
}

/**
 * Get an exact staged patch including binary payloads for recovery.
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @returns The staged patch output from git diff --cached --binary
 * @throws {GitCommandError} If git command fails
 */
export function getStagedPatch(cwd?: string): string {
  return execGit(
    [
      "diff",
      "--cached",
      "--binary",
      ...CANONICAL_DIFF_PREFIX_ARGS,
      `--unified=${String(DIFF_CONTEXT_LINES)}`,
    ],
    {
      cwd,
    },
  );
}

/**
 * Check whether the current repository already has at least one commit.
 * This avoids relying on localized git error text when HEAD does not exist yet.
 */
export function hasCommitHistory(cwd?: string): boolean {
  return didGitSpawnSucceed(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
}

/**
 * Check if there are any staged changes
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @returns true if there are staged changes, false otherwise
 * @throws {GitCommandError} If git command fails
 */
export function hasStagedChanges(cwd?: string): boolean {
  const out = execGit(["diff", "--cached", "--name-only"], { cwd });
  return out.trim().length > 0;
}

/**
 * Check if the current directory is inside a git repository
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @returns true if inside a git repository, false otherwise
 */
export function isGitRepository(cwd?: string): boolean {
  return didGitSpawnSucceed(["rev-parse", "--git-dir"], cwd);
}

// ============================================================================
// Safe Git Execution
// ============================================================================

/**
 * Check whether a path currently exists in the Git index.
 *
 * This is used by selective staging to detect when a rename has already been
 * committed in an earlier split commit, so later hunks can be staged against
 * the new path instead of replaying the original rename header.
 */
export function isPathTrackedInIndex(path: string, cwd?: string): boolean {
  return didGitSpawnSucceed(["ls-files", "--error-unmatch", "--", path], cwd);
}

/**
 * Unstage all changes (reset HEAD)
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @throws {GitCommandError} If git command fails (except for empty staging area)
 */
export function resetStaging(cwd?: string): void {
  if (!hasStagedChanges(cwd)) {
    return;
  }

  if (!hasCommitHistory(cwd)) {
    execGit(["rm", "--cached", "-r", "--", "."], { cwd });
    return;
  }

  execGit(["reset", "HEAD", "--", "."], { cwd });
}

/**
 * Restore an exact staged patch via git apply --cached.
 * Supports multi-file and binary patches captured from git diff --cached --binary.
 * @param patchContent - The exact staged patch content
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @throws {GitCommandError} If patch is empty or git apply fails
 */
export function restoreStagedPatch(patchContent: string, cwd?: string): void {
  if (!patchContent || patchContent.trim().length === 0) {
    throw new GitCommandError(
      "Cannot restore empty staged patch",
      "git apply --cached",
    );
  }
  execGit(["apply", "--cached", "-"], {
    cwd,
    input: patchContent,
  });
}

/**
 * Stage all changes (tracked and untracked, respecting .gitignore)
 * Equivalent to `git add -A`
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @throws {GitCommandError} If git command fails
 */
export function stageAll(cwd?: string): void {
  execGit(["add", "-A"], { cwd });
}

// ============================================================================
// Diff Operations
// ============================================================================

/**
 * Stage specific files by path
 * @param paths - Array of file paths to stage (will be sanitized)
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @throws {InvalidPathError} If any file path is invalid
 * @throws {GitCommandError} If git command fails
 */
export function stageFiles(paths: string[], cwd?: string): void {
  if (paths.length === 0) return;

  // Validate and sanitize all paths first
  const safe = paths.map(sanitizeFilePath);

  // Stage all files in one command using -- separator for safety
  execGit(["add", "--", ...safe], { cwd });
}

/**
 * Stage a specific hunk by applying a patch via `git apply --cached`
 * Used for selective hunk-level staging
 * @param patchContent - The patch content in unified diff format
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @throws {GitCommandError} If patch is empty or git apply fails
 */
export function stagePatch(patchContent: string, cwd?: string): void {
  if (!patchContent || patchContent.trim().length === 0) {
    throw new GitCommandError("Cannot stage empty patch", "git apply --cached");
  }
  execGit(["apply", "--cached", "--unidiff-zero", "-"], {
    cwd,
    input: patchContent,
  });
}

// ============================================================================
// Staging Operations
// ============================================================================

/**
 * Execute a git command safely with error handling
 * All git operations should use this function to ensure consistent error handling
 * @param args - Array of command arguments (avoids shell injection)
 * @param options - Optional configuration
 * @param options.cwd - Working directory (defaults to process.cwd())
 * @param options.input - Input to pipe to the command via stdin
 * @param options.maxBuffer - Maximum stdout/stderr buffer size in bytes
 * @returns The stdout output from the git command (sanitized)
 * @throws {GitCommandError} If command exits with non-zero status
 */
function execGit(
  args: string[],
  options?: { cwd?: string; input?: string; maxBuffer?: number },
): string {
  const dir = options?.cwd ?? process.cwd();
  try {
    const result = runGitCommand(args, dir, options);
    if (result.status !== 0) {
      throw createGitCommandFailure(
        args,
        result.status,
        result.stderr,
        result.error?.message,
      );
    }
    // Sanitize output to remove malicious escape sequences
    return sanitizeGitOutput(result.stdout);
  } catch (err: unknown) {
    if (err instanceof GitCommandError) {
      throw err;
    }

    const e = err as { message?: string; status?: number; stderr?: string };
    throw createGitCommandFailure(args, e.status, e.stderr ?? e.message ?? "");
  }
}
