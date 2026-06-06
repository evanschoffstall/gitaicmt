import {
  resolveResumeOptions,
  type ResumeCommand,
  type ResumeSelection,
} from "./resume/index.js";

/**
 * Parsed CLI options derived from argv.
 */
export interface CliOptions {
  breakingMode: BreakingChangeMode;
  command: string;
  hasEnforceCommitBodyFlag: boolean;
  hasForceFlag: boolean;
  hasGlobalFlag: boolean;
  hasNoTokenCheckFlag: boolean;
  hasValidOnlyFlag: boolean;
  hasYFlag: boolean;
  outputMode: OutputMode;
  resumeCommand: ResumeCommand;
  resumeHash: null | string;
  resumeSelection: ResumeSelection;
}

export type OutputMode = "off" | "summary" | "trace";
export type { ResumeSelection };

type BreakingChangeMode =
  import("../commit-planning/prompts/index.js").BreakingChangeMode;

/**
 * Parse command-line arguments into the options shape used by the CLI.
 *
 * Command selection remains based on the first positional token so existing
 * aliases keep their current behavior while the resume hash rides alongside it.
 *
 * @param args - Raw process arguments after the executable path.
 * @returns Normalized CLI options.
 */
export function parseCliOptions(args: string[]): CliOptions {
  const positionalArgs = collectPositionalArgs(args);
  const resumeOptions = resolveResumeOptions(args, positionalArgs);
  const hasBreakingFlag = hasAnyFlag(args, ["-b", "--breaking"]);
  const hasNoBreakingFlag = hasAnyFlag(args, ["-n", "--no-breaking"]);
  const hasTraceFlag = hasAnyFlag(args, ["--trace"]);
  const hasVerboseFlag = hasAnyFlag(args, ["-v", "--verbose"]);
  const hasForceFlag = hasAnyFlag(args, ["--force"]);
  const hasValidOnlyFlag = hasAnyFlag(args, ["--valid-only"]);

  if (hasForceFlag && hasValidOnlyFlag) {
    throw new Error(
      "--force and --valid-only are mutually exclusive. Use only one resume hash-check mode.",
    );
  }

  return {
    breakingMode: resolveBreakingMode(hasBreakingFlag, hasNoBreakingFlag),
    command: resolveCommand(args),
    hasEnforceCommitBodyFlag: hasAnyFlag(args, ["--enforce-commit-body"]),
    hasForceFlag,
    hasGlobalFlag: hasAnyFlag(args, ["--global"]),
    hasNoTokenCheckFlag: hasAnyFlag(args, ["--no-token-check"]),
    hasValidOnlyFlag,
    hasYFlag: hasAnyFlag(args, ["-y", "--yes"]),
    outputMode: hasTraceFlag ? "trace" : hasVerboseFlag ? "summary" : "off",
    resumeCommand: resumeOptions.resumeCommand,
    resumeHash: resumeOptions.resumeHash,
    resumeSelection: resumeOptions.resumeSelection,
  };
}

function collectPositionalArgs(args: string[]): string[] {
  const positionalArgs: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? "";
    if (isResumeValueFlag(argument)) {
      index += 1;
      continue;
    }
    if (hasInlineResumeValue(argument) || argument.startsWith("-")) {
      continue;
    }

    positionalArgs.push(argument);
  }

  return positionalArgs;
}

function hasAnyFlag(args: string[], candidates: string[]): boolean {
  return candidates.some((candidate) => args.includes(candidate));
}

function hasInlineResumeValue(argument: string): boolean {
  return ["--from=", "--only=", "--range="].some((prefix) =>
    argument.startsWith(prefix),
  );
}

function isResumeValueFlag(argument: string): boolean {
  return (
    argument === "--from" || argument === "--only" || argument === "--range"
  );
}

function resolveBreakingMode(
  hasBreakingFlag: boolean,
  hasNoBreakingFlag: boolean,
): BreakingChangeMode {
  if (hasNoBreakingFlag) {
    return "disabled";
  }

  return hasBreakingFlag ? "sensitive" : "normal";
}

function resolveCommand(args: string[]): string {
  const flaggedCommand = [
    { command: "version", flags: ["--version"] },
    { command: "help", flags: ["-h", "--help"] },
    { command: "plan", flags: ["--plan"] },
  ].find(({ flags }) => flags.some((flag) => args.includes(flag)));

  return flaggedCommand
    ? flaggedCommand.command
    : (collectPositionalArgs(args)[0] ?? "");
}
