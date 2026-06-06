import { GitCommandError } from "../application/errors.js";

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
  const detail =
    stderr.length > 0 ? stderr : (errorMessage ?? "Git command failed");
  return new GitCommandError(
    `Git command failed (exit ${String(exitCode)}): git ${args.join(" ")}\n${detail}`,
    `git ${args.join(" ")}`,
    exitCode,
  );
}
