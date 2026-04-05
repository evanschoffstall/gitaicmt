import { loadConfig } from "../../application/config/index.js";
import { formatScalar } from "../../commit-messages/formatting.js";

/**
 * Returns the commit-message format instructions array shared by all prompt
 * builders that ask the model to write a commit message.
 */
export function commitFormatInstructions(): string[] {
  const cfg = loadConfig();
  const parts: string[] = [];
  if (cfg.commit.conventional) {
    parts.push(
      "Use the Conventional Commits format: <type>(<scope>): <description>",
      "Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert.",
      "Choose the most specific type that applies.",
      "Use fix when the change corrects misleading behavior, wrong decisions, broken safeguards, incorrect diagnostics, or other user-visible or operator-visible mistakes, even if it introduces a new internal check, event, or label to do so.",
      "Use feat only when the change primarily introduces a genuinely new capability or workflow, not when it is correcting existing planner or diagnostic behavior.",
    );
  }
  if (cfg.commit.includeScope) {
    parts.push(
      "Include a scope in parentheses reflecting the affected module/area.",
    );
  }
  parts.push(
    `Subject line MUST be <= ${formatScalar(cfg.commit.maxSubjectLength)} characters.`,
    `Language: ${cfg.commit.language}.`,
  );
  parts.push(
    "Write as if an involved, thoughtful senior engineer is committing premium change by hand.",
    "Center the message on why the change is being made; heavily infer the motivating bug, safeguard, product behavior, maintenance goal, or workflow need from the diff whenever it is implied.",
    "Lead with the reason, outcome, or defended behavior the commit introduces, not a flat description of edited files or implementation steps.",
    "Infer the actual subsystem, workflow, or product surface from the file paths, scopes, symbols, and diff content, and name that directly.",
    "Heavily infer from the content to surface the intent a human reviewer would care about, even when the diff mostly shows mechanics.",
    "When one commit covers a broad but cohesive rollout, the subject should name the umbrella outcome or area, not enumerate every mechanism changed.",
    "When one concrete guardrail, heuristic, validation, retry path, cache behavior, or signaling rule dominates the diff, name that dominant mechanism directly in the subject instead of falling back to vague umbrella nouns.",
    "When the diff mostly changes prompt, instruction, or guidance text, name the concrete rule introduced, banned, or clarified in the subject instead of meta wording.",
    "Treat source files that define prompts, heuristics, validators, planner logic, or other runtime behavior as code, not documentation, even when the diff mostly edits prose, examples, JSDoc, or TSDoc inside those files.",
    "Reserve docs for actual documentation artifacts such as README, markdown, or dedicated docs content, not runtime source modules that happen to contain instructional text.",
    "When runtime prompt or planner source changes a rule, safeguard, or decision, avoid meta verbs if the concrete rule being changed can be named directly.",
    "Avoid generic umbrella nouns like flow, pipeline, logic, handling, support, or behavior when the diff supports a more specific mechanism, safeguard, or decision point.",
    "Avoid comma-separated or and-linked subject lists that read like a changelog headline; move secondary details into body bullets.",
    "After the subject, add a blank line then a concise body using bullet points to summarize key changes.",
    "Prefer 2-4 bullets that capture the most important behavioral, architectural, or validation details.",
    "Use the body to justify the subject with impact, constraints, guarantees, or verification details; do not just restate the same wording.",
    "Each bullet should add concrete information beyond the subject; avoid filler, hype, and repetition.",
    "Prefer precise technical verbs and nouns over generic phrases like update, improve, changes, or stuff when the diff supports something more specific.",
    "Badly generic subjects like feat: update tests, chore: improve code, or refactor: tweak prompts are invalid when the diff supports a more exact area.",
    `Wrap body lines at ${formatScalar(cfg.commit.maxBodyLineLength)} characters.`,
    "A subject-only commit message is invalid.",
  );
  parts.push(
    "Do NOT include markdown formatting, code fences, or quotation marks around the message.",
  );
  return parts;
}
