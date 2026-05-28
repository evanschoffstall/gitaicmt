/**
 * Builds a stable non-interactive Git environment for subprocess execution.
 * Temporary repositories used by tests and automated commit flows should not
 * inherit global editor, pager, or signing prompts that can block the process.
 * Hooks still run because they are part of normal commit validation.
 * @returns Environment variables for deterministic Git child processes.
 */
export function createGitProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_EDITOR: process.env.GIT_EDITOR ?? ":",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}
