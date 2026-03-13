/**
 * Git operations module - isolates all git command execution
 * Provides safe, testable interface for git interactions
 */

import { spawnSync } from "node:child_process";

import { validateCommitMessage } from "./ai-format.js";
import {
  DIFF_CONTEXT_LINES,
  GIT_MAX_BUFFER,
  MAX_PATH_LENGTH,
} from "./constants.js";
import { GitCommandError, InvalidPathError } from "./errors.js";

const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${String.fromCodePoint(0x1b)}\\[[0-9;]*[A-Za-z]`,
  "gu",
);
const CONTROL_CHARACTER = /\p{Cc}/gu;
const FORBIDDEN_PATH_CONTROL_CHARACTERS = /\p{Cc}/u;
const SAFE_LINE_CONTROL_CHARACTERS = new Set(["\t", "\n", "\r"]);

// ============================================================================
// Repository Validation
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

  let validatedMessage: string;
  try {
    validatedMessage = validateCommitMessage(message);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GitCommandError(
      `Cannot commit with invalid message: ${reason}`,
      "git commit -F -",
    );
  }

  const dir = cwd ?? process.cwd();
  const result = spawnSync("git", ["commit", "-F", "-"], {
    cwd: dir,
    encoding: "utf-8",
    input: validatedMessage,
    stdio: ["pipe", "inherit", "inherit"],
  });

  if (result.status !== 0) {
    const exitCode = result.status ?? 1;
    const errorMessage = result.error?.message ?? "unknown error";
    throw new GitCommandError(
      `Git commit failed (exit ${String(exitCode)}): ${errorMessage}`,
      "git commit -F -",
      exitCode,
    );
  }
}

// ============================================================================
// Path Validation
// ============================================================================

/**
 * Get staged diff with specified context lines
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @returns The unified diff output from git diff --cached
 * @throws {GitCommandError} If git command fails
 */
export function getStagedDiff(cwd?: string): string {
  return execGit(
    ["diff", "--cached", `--unified=${String(DIFF_CONTEXT_LINES)}`],
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
    ["diff", "--cached", "--binary", `--unified=${String(DIFF_CONTEXT_LINES)}`],
    {
      cwd,
    },
  );
}

// ============================================================================
// Safe Git Execution
// ============================================================================

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
// Diff Operations
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

// ============================================================================
// Staging Operations
// ============================================================================

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

function containsForbiddenPathControlCharacters(path: string): boolean {
  return FORBIDDEN_PATH_CONTROL_CHARACTERS.test(path);
}

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
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      input: options?.input,
      maxBuffer: options?.maxBuffer ?? GIT_MAX_BUFFER,
      stdio: options?.input ? ["pipe", "pipe", "pipe"] : "pipe",
    });
    if (result.status !== 0) {
      const exitCode = result.status ?? 1;
      const stderr = result.stderr;
      const errorMessage =
        stderr.length > 0
          ? stderr
          : (result.error?.message ?? "Git command failed");

      throw new GitCommandError(
        `Git command failed (exit ${String(exitCode)}): git ${args.join(" ")}\n${errorMessage}`,
        `git ${args.join(" ")}`,
        exitCode,
      );
    }
    // Sanitize output to remove malicious escape sequences
    return sanitizeGitOutput(result.stdout);
  } catch (err: unknown) {
    if (err instanceof GitCommandError) {
      throw err;
    }

    const e = err as { message?: string; status?: number; stderr?: string };
    const stderr = e.stderr ?? e.message ?? "";
    const status = e.status ?? 1;
    throw new GitCommandError(
      `Git command failed (exit ${String(status)}): git ${args.join(" ")}\n${stderr}`,
      `git ${args.join(" ")}`,
      status,
    );
  }
}

/**
 * Normalize a path by resolving relative segments and removing redundancies.
 * Does NOT resolve symlinks (we want to preserve git's view).
 */
function normalizePath(path: string): string {
  // Split into segments and resolve .. and .
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const resolved: string[] = [];

  for (const seg of segments) {
    if (seg === "..") {
      // Attempting to go above root is suspicious
      if (resolved.length === 0) {
        throw new InvalidPathError(
          `Path traversal attempt detected: ${path}`,
          path,
        );
      }
      resolved.pop();
    } else if (seg !== ".") {
      resolved.push(seg);
    }
  }

  return resolved.join("/");
}

/**
 * Validate and sanitize file paths to prevent command injection and path traversal.
 * @throws {InvalidPathError} If path contains dangerous characters or patterns
 */
function sanitizeFilePath(path: string): string {
  // Prevent all forms of null bytes and control characters
  if (containsForbiddenPathControlCharacters(path)) {
    throw new InvalidPathError(
      `Invalid file path contains control characters`,
      path,
    );
  }

  // Remove any shell metacharacters and dangerous patterns
  // Blocklist: ; | & $ ` ( ) { } < > \ ' " * ? ~ ! #
  // Note: [] are allowed (used in Next.js dynamic routes like [slug])
  // Safe because we use spawnSync with array args (no shell interpretation)
  if (
    /[;|&$`(){}<>\\'"`*?~!#]/.test(path) ||
    path.includes("$(") ||
    path.includes("${")
  ) {
    throw new InvalidPathError(
      `Invalid file path contains shell metacharacters`,
      path,
    );
  }

  // Prevent absolute paths (git staging should be relative to repo root)
  if (path.startsWith("/")) {
    throw new InvalidPathError(
      `Invalid file path (absolute path not allowed)`,
      path,
    );
  }

  // Prevent leading dash (could be interpreted as flags)
  if (path.startsWith("-")) {
    throw new InvalidPathError(`Invalid file path starts with dash`, path);
  }

  // Maximum path length check (prevent DoS)
  if (path.length > MAX_PATH_LENGTH) {
    throw new InvalidPathError(`File path exceeds maximum length`, path);
  }

  // Normalize to resolve .. and . segments, catching traversal attempts
  const normalized = normalizePath(path);

  // Final check: ensure no attempts to escape repo root
  if (normalized.startsWith("..")) {
    throw new InvalidPathError(`Path traversal attempt detected`, path);
  }

  return normalized;
}

/**
 * Sanitize git command output to remove potentially malicious escape sequences.
 * Git output can contain ANSI codes, control characters, and other terminal escapes.
 */
function sanitizeGitOutput(output: string): string {
  return stripUnsafeControlCharacters(stripAnsiEscapeSequences(output));
}

// ============================================================================
// Commit Operations
// ============================================================================

function stripAnsiEscapeSequences(output: string): string {
  return output.replace(ANSI_ESCAPE_SEQUENCE, "");
}

function stripUnsafeControlCharacters(output: string): string {
  return output.replace(CONTROL_CHARACTER, (char) =>
    SAFE_LINE_CONTROL_CHARACTERS.has(char) ? char : "",
  );
}
