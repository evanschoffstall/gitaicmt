import { GitCommandError } from "../application/errors.js";
import { createGitCommandFailure } from "./failures.js";
import { sanitizeGitOutput } from "./output-sanitization.js";
import { didGitSpawnSucceed } from "./spawn-success.js";
import { runGitCommand } from "./subprocess.js";

/**
 * Resolve the current HEAD commit when one exists.
 *
 * New repositories may not have any commits yet, so resume validation needs a
 * nullable result instead of treating that case as an exception.
 *
 * @param cwd - Optional working directory (defaults to process.cwd()).
 * @returns Current HEAD commit SHA, or null when the repository has no commits.
 * @throws {GitCommandError} If git fails for reasons other than a missing HEAD.
 */
export function getHeadCommit(cwd?: string): null | string {
  if (!hasCommitHistory(cwd)) {
    return null;
  }

  return execRepositoryGit(["rev-parse", "HEAD"], cwd).trim();
}

/**
 * Resolve the canonical repository root for the current working directory.
 *
 * Resume bundles are repository-scoped. Returning the git-reported top-level
 * path prevents a saved hash from being replayed against a different checkout.
 *
 * @param cwd - Optional working directory (defaults to process.cwd()).
 * @returns Absolute repository root path reported by git.
 * @throws {GitCommandError} If git cannot resolve the repository root.
 */
export function getRepositoryRoot(cwd?: string): string {
  return execRepositoryGit(["rev-parse", "--show-toplevel"], cwd).trim();
}

function execRepositoryGit(args: string[], cwd?: string): string {
  const directory = cwd ?? process.cwd();
  try {
    const result = runGitCommand(args, directory);
    if (result.status !== 0) {
      throw createGitCommandFailure(
        args,
        result.status,
        result.stderr,
        result.error?.message,
      );
    }

    return sanitizeGitOutput(result.stdout);
  } catch (error: unknown) {
    if (error instanceof GitCommandError) {
      throw error;
    }

    const failure = error as {
      message?: string;
      status?: number;
      stderr?: string;
    };
    throw createGitCommandFailure(
      args,
      failure.status,
      failure.stderr ?? failure.message ?? "",
    );
  }
}

function hasCommitHistory(cwd?: string): boolean {
  return didGitSpawnSucceed(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
}
