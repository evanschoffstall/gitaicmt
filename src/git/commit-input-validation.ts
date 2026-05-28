import { GitCommandError } from "../application/errors.js";
import { validateCommitMessage } from "../commit-messages/formatting.js";
import { normalizeConventionalSubjectScope } from "../commit-messages/subject-parser.js";

/**
 * Commit-message validation controls used when replaying saved messages.
 *
 * `ignoreMessageBody` exists for explicit recovery flows such as resuming a
 * legacy saved plan whose messages predate current body requirements.
 */
export interface CommitInputValidationOptions {
  ignoreMessageBody?: boolean;
}

/**
 * Validate and normalize a commit message before piping it to `git commit`.
 *
 * The default path enforces the full conventional subject and body contract.
 * Recovery flows may explicitly opt into subject-only normalization to replay
 * legacy saved messages without weakening the default validation path.
 */
export function validateCommitInput(
  message: string,
  options: CommitInputValidationOptions = {},
): string {
  if (!message || message.trim().length === 0) {
    throw new GitCommandError("Cannot commit with empty message", "git commit");
  }

  try {
    return options.ignoreMessageBody
      ? normalizeCommitInputIgnoringBody(message)
      : validateCommitMessage(message);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GitCommandError(
      `Cannot commit with invalid message: ${reason}`,
      "git commit -F -",
    );
  }
}

/**
 * Normalize only the subject line and newline shape while leaving any saved
 * body content untouched. This is intentionally reserved for explicit bypass
 * flows so legacy subject-only messages remain replayable.
 */
function normalizeCommitInputIgnoringBody(message: string): string {
  const normalized = message.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    throw new Error("Commit message cannot be empty");
  }

  const lines = normalized.split("\n");
  const subject = normalizeConventionalSubjectScope(lines[0]?.trim() ?? "");
  if (subject.length === 0) {
    throw new Error("Commit message subject cannot be empty");
  }

  return lines.length === 1 ? subject : [subject, ...lines.slice(1)].join("\n");
}
