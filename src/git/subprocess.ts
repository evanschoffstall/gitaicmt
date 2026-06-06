import { spawnSync } from "node:child_process";

import { GIT_MAX_BUFFER } from "../application/constants.js";
import { createGitProcessEnv } from "./process-environment.js";

export function runGitCommand(
  args: string[],
  cwd: string,
  options?: { input?: string; maxBuffer?: number },
) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: createGitProcessEnv(),
    input: options?.input,
    maxBuffer: options?.maxBuffer ?? GIT_MAX_BUFFER,
    stdio: options?.input ? ["pipe", "pipe", "pipe"] : "pipe",
  });
}
