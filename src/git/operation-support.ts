import { spawnSync } from "node:child_process";

import {
  GIT_MAX_BUFFER,
  MAX_PATH_LENGTH,
} from "../application/constants.js";
import { GitCommandError, InvalidPathError } from "../application/errors.js";
import { validateCommitMessage } from "../commit-messages/formatting.js";

const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${String.fromCodePoint(0x1b)}\\[[0-9;]*[A-Za-z]`,
  "gu",
);
const CONTROL_CHARACTER = /\p{Cc}/gu;
const FORBIDDEN_PATH_CONTROL_CHARACTERS = /\p{Cc}/u;
const SAFE_LINE_CONTROL_CHARACTERS = new Set(["\t", "\n", "\r"]);
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[/\\]/u;

export function createCommitFailure(
  status: null | number,
  stderr: string,
  errorMessage?: string,
): GitCommandError {
  const exitCode = status ?? 1;
  const detail = [stderr, errorMessage]
    .filter((part) => part && part.length > 0)
    .join("\n");
  return new GitCommandError(
    `Git commit failed (exit ${String(exitCode)}): ${detail.length > 0 ? detail : "unknown error"}`,
    "git commit -F -",
    exitCode,
  );
}

export function createGitCommandFailure(
  args: string[],
  status: null | number | undefined,
  stderr: string,
  errorMessage?: string,
): GitCommandError {
  const exitCode = status ?? 1;
  const detail = stderr.length > 0 ? stderr : (errorMessage ?? "Git command failed");
  return new GitCommandError(
    `Git command failed (exit ${String(exitCode)}): git ${args.join(" ")}\n${detail}`,
    `git ${args.join(" ")}`,
    exitCode,
  );
}

export function runGitCommand(
  args: string[],
  cwd: string,
  options?: { input?: string; maxBuffer?: number },
) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    input: options?.input,
    maxBuffer: options?.maxBuffer ?? GIT_MAX_BUFFER,
    stdio: options?.input ? ["pipe", "pipe", "pipe"] : "pipe",
  });
}

export function sanitizeFilePath(path: string): string {
  if (path.trim().length === 0) {
    throw new InvalidPathError(`Invalid file path is empty`, path);
  }
  if (FORBIDDEN_PATH_CONTROL_CHARACTERS.test(path)) {
    throw new InvalidPathError(
      `Invalid file path contains control characters`,
      path,
    );
  }
  if (path.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(path)) {
    throw new InvalidPathError(
      `Invalid file path (absolute path not allowed)`,
      path,
    );
  }
  if (path.startsWith("-")) {
    throw new InvalidPathError(`Invalid file path starts with dash`, path);
  }
  if (path.length > MAX_PATH_LENGTH) {
    throw new InvalidPathError(`File path exceeds maximum length`, path);
  }

  const normalized = normalizePath(path);
  if (normalized.length === 0) {
    throw new InvalidPathError(`Invalid file path is empty`, path);
  }
  if (normalized.startsWith("..")) {
    throw new InvalidPathError(`Path traversal attempt detected`, path);
  }

  return normalized;
}

export function sanitizeGitOutput(output: string): string {
  return stripUnsafeControlCharacters(stripAnsiEscapeSequences(output));
}

export function validateCommitInput(message: string): string {
  if (!message || message.trim().length === 0) {
    throw new GitCommandError("Cannot commit with empty message", "git commit");
  }

  try {
    return validateCommitMessage(message);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GitCommandError(
      `Cannot commit with invalid message: ${reason}`,
      "git commit -F -",
    );
  }
}

function normalizePath(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === "..") {
      if (resolved.length === 0) {
        throw new InvalidPathError(
          `Path traversal attempt detected: ${path}`,
          path,
        );
      }
      resolved.pop();
      continue;
    }

    if (segment !== ".") {
      resolved.push(segment);
    }
  }

  return resolved.join("/");
}

function stripAnsiEscapeSequences(output: string): string {
  return output.replace(ANSI_ESCAPE_SEQUENCE, "");
}

function stripUnsafeControlCharacters(output: string): string {
  return output.replace(CONTROL_CHARACTER, (char) =>
    SAFE_LINE_CONTROL_CHARACTERS.has(char) ? char : "",
  );
}