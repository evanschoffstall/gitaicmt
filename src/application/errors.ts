/**
 * Custom error classes for structured error handling
 */

/** Base error class for all gitaicmt errors */
abstract class GitAICmtError extends Error {
  abstract code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Configuration validation or loading failed */
export class ConfigError extends GitAICmtError {
  code = "CONFIG_ERROR";

  constructor(
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}

/** Git command execution failed */
export class GitCommandError extends GitAICmtError {
  code = "GIT_COMMAND_FAILED";

  constructor(
    message: string,
    public command: string,
    public exitCode?: number,
  ) {
    super(message);
  }
}

/** Invalid file path detected (potential security issue) */
export class InvalidPathError extends GitAICmtError {
  code = "INVALID_PATH";

  constructor(
    message: string,
    public path: string,
  ) {
    super(message);
  }
}

/** OpenAI API call failed */
export class OpenAIError extends GitAICmtError {
  code = "OPENAI_ERROR";

  constructor(
    message: string,
    public cause?: Error,
  ) {
    super(message);
  }
}

/** OpenAI API timeout */
export class OpenAITimeoutError extends OpenAIError {
  code = "OPENAI_TIMEOUT";

  constructor(timeout: number) {
    super(`OpenAI API request timed out after ${String(timeout)}ms`);
  }
}

/** AI response validation failed */
export class ValidationError extends GitAICmtError {
  code = "VALIDATION_ERROR";

  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
