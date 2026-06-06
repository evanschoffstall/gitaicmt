import { spawnSync } from "node:child_process";

import { createGitProcessEnv } from "./process-environment.js";

/**
 * Run a git command and report whether it exited successfully.
 *
 * This is used for lightweight repository probes where callers only need a
 * boolean success answer and do not need the richer execGit error surface.
 *
 * @param args - Git command arguments.
 * @param cwd - Optional working directory (defaults to process.cwd()).
 * @returns True when git exited with status 0 and did not raise a spawn error.
 */
export function didGitSpawnSucceed(args: string[], cwd?: string): boolean {
  try {
    const result = spawnSync("git", args, {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
      env: createGitProcessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}
