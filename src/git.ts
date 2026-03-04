/**
 * Git operations module - isolates all git command execution
 * Provides safe, testable interface for git interactions
 */

import { spawnSync } from "node:child_process";
import { GIT_MAX_BUFFER } from "./constants.js";
import { GitCommandError, InvalidPathError } from "./errors.js";

// ============================================================================
// Repository Validation
// ============================================================================

/**
 * Check if the current directory is inside a git repository
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @returns true if inside a git repository, false otherwise
 */
export function isGitRepository(cwd?: string): boolean {
  try {
    const result = spawnSync("git", ["rev-parse", "--git-dir"], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Check if process executed successfully
    if (result.error) {
      return false;
    }
    return result.status === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Path Validation
// ============================================================================

/**
 * Validate and sanitize file paths to prevent command injection
 * @throws {InvalidPathError} If path contains dangerous characters or patterns
 */
export function sanitizeFilePath(path: string): string {
  // Prevent all forms of null bytes and control characters
  if (/[\x00-\x1f\x7f]/.test(path)) {
    throw new InvalidPathError(
      `Invalid file path contains control characters: ${path}`,
      path,
    );
  }

  // Remove any shell metacharacters and dangerous patterns
  // Comprehensive blocklist: ; | & $ ` ( ) { } [ ] < > \ ' " * ? ~ ! #
  if (
    /[;|&$`(){}[\]<>\\'"`*?~!#]/.test(path) ||
    path.includes("$(") ||
    path.includes("${") ||
    path.includes("\${")
  ) {
    throw new InvalidPathError(
      `Invalid file path contains shell metacharacters: ${path}`,
      path,
    );
  }

  // Prevent path traversal to absolute paths outside repo
  if (path.startsWith("/") || /\.{2}[\\/]/.test(path)) {
    throw new InvalidPathError(
      `Invalid file path (absolute or path traversal): ${path}`,
      path,
    );
  }

  // Prevent leading dash (could be interpreted as flags)
  if (path.startsWith("-")) {
    throw new InvalidPathError(
      `Invalid file path starts with dash: ${path}`,
      path,
    );
  }

  // Maximum path length check (prevent DoS)
  if (path.length > 4096) {
    throw new InvalidPathError(
      `File path exceeds maximum length: ${path.slice(0, 100)}...`,
      path,
    );
  }

  return path;
}

// ============================================================================
// Safe Git Execution
// ============================================================================

/**
 * Execute a git command safely with error handling
 * All git operations should use this function to ensure consistent error handling
 * @param args - Array of command arguments (avoids shell injection)
 * @param options - Optional configuration
 * @param options.cwd - Working directory (defaults to process.cwd())
 * @param options.input - Input to pipe to the command via stdin
 * @param options.maxBuffer - Maximum stdout/stderr buffer size in bytes
 * @returns The stdout output from the git command
 * @throws {GitCommandError} If command exits with non-zero status
 */
export function execGit(
  args: string[],
  options?: { cwd?: string; input?: string; maxBuffer?: number },
): string {
  const dir = options?.cwd ?? process.cwd();
  try {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: options?.maxBuffer ?? GIT_MAX_BUFFER,
      input: options?.input,
      stdio: options?.input ? ["pipe", "pipe", "pipe"] : "pipe",
    });
    if (result.status !== 0) {
      throw {
        status: result.status,
        stderr: result.stderr,
        message: result.stderr || result.error?.message || "Git command failed",
      };
    }
    return result.stdout as string;
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; stderr?: string };
    const stderr = e.stderr || "";
    const status = e.status || 1;
    throw new GitCommandError(
      `Git command failed (exit ${status}): git ${args.join(" ")}\n${stderr}`,
      `git ${args.join(" ")}`,
      status,
    );
  }
}

// ============================================================================
// Diff Operations
// ============================================================================

/**
 * Get staged diff with specified context lines
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @returns The unified diff output from git diff --cached
 * @throws {GitCommandError} If git command fails
 */
export function getStagedDiff(cwd?: string): string {
  return execGit(["diff", "--cached", "--unified=3"], { cwd });
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
 * Get the unstaged working-tree diff for a specific file
 * @param filePath - Path to the file (will be sanitized)
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @returns The unified diff output for the file
 * @throws {InvalidPathError} If file path is invalid
 * @throws {GitCommandError} If git command fails
 */
export function getFileWorkingDiff(filePath: string, cwd?: string): string {
  const safe = sanitizeFilePath(filePath);
  return execGit(["diff", "--", safe], { cwd });
}

// ============================================================================
// Staging Operations
// ============================================================================

/**
 * Unstage all changes (reset HEAD)
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @throws {GitCommandError} If git command fails (except for empty staging area)
 */
export function resetStaging(cwd?: string): void {
  try {
    execGit(["reset", "HEAD", "--", "."], { cwd });
  } catch (err) {
    // Only ignore "nothing to reset" errors
    if (err instanceof GitCommandError) {
      // Git returns 0 for empty reset, but check message just in case
      const msg = err.message.toLowerCase();
      if (
        msg.includes("no changes") ||
        msg.includes("nothing to reset") ||
        msg.includes("did not match any files")
      ) {
        return; // Safe to ignore
      }
    }
    // Re-throw unexpected errors (permission denied, repo corruption, etc.)
    throw err;
  }
}

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
 * Stage all changes (tracked and untracked, respecting .gitignore)
 * Equivalent to `git add -A`
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @throws {GitCommandError} If git command fails
 */
export function stageAll(cwd?: string): void {
  execGit(["add", "-A"], { cwd });
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
// Commit Operations
// ============================================================================

/**
 * Commit with a message (supports multi-line subject + body via stdin)
 * @param message - The commit message (can include newlines for body)
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @throws {GitCommandError} If message is empty or commit fails
 */
export function commitWithMessage(message: string, cwd?: string): void {
  if (!message || message.trim().length === 0) {
    throw new GitCommandError("Cannot commit with empty message", "git commit");
  }

  const dir = cwd ?? process.cwd();
  const result = spawnSync("git", ["commit", "-F", "-"], {
    cwd: dir,
    input: message,
    encoding: "utf-8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  
  if (result.status !== 0) {
    throw new GitCommandError(
      `Git commit failed (exit ${result.status}): ${result.error?.message || "unknown error"}`,
      "git commit -F -",
      result.status || 1,
    );
  }
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
