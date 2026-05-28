/**
 * Parsed CLI options derived from argv.
 */
export interface CliOptions {
  breakingMode: BreakingChangeMode;
  command: string;
  hasForceFlag: boolean;
  hasIgnoreMessageBodyFlag: boolean;
  hasNoTokenCheckFlag: boolean;
  hasValidOnlyFlag: boolean;
  hasYFlag: boolean;
  outputMode: OutputMode;
  resumeHash: null | string;
  resumeSelection: ResumeSelection;
}

export type OutputMode = "off" | "summary" | "trace";
export type ResumeSelection =
  | { endIndex: number; kind: "range"; startIndex: number }
  | { indices: number[]; kind: "only" }
  | { kind: "all" }
  | { kind: "from"; startIndex: number };

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
  const firstPositionalArg = positionalArgs[0] ?? "";
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
    hasForceFlag,
    hasIgnoreMessageBodyFlag: hasAnyFlag(args, ["--ignore-message-body"]),
    hasNoTokenCheckFlag: hasAnyFlag(args, ["--no-token-check"]),
    hasValidOnlyFlag,
    hasYFlag: hasAnyFlag(args, ["-y", "--yes"]),
    outputMode: hasTraceFlag ? "trace" : hasVerboseFlag ? "summary" : "off",
    resumeHash:
      firstPositionalArg === "resume" || firstPositionalArg === "r"
        ? (positionalArgs[1] ?? null)
        : null,
    resumeSelection: resolveResumeSelection(args),
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

function parseOnlySelection(value: string): ResumeSelection {
  const parts = value.split(",");
  const indices: number[] = [];
  const seenIndexes = new Set<number>();

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part.length === 0) {
      throw new Error(
        "--only requires a comma-separated list of positive 1-based indexes.",
      );
    }

    const index = parsePositiveIndex(part, "--only");
    if (seenIndexes.has(index)) {
      continue;
    }

    seenIndexes.add(index);
    indices.push(index);
  }

  if (indices.length === 0) {
    throw new Error(
      "--only requires a comma-separated list of positive 1-based indexes.",
    );
  }

  return { indices, kind: "only" };
}

function parsePositiveIndex(value: string, flagName: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${flagName} requires a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flagName} requires a positive integer.`);
  }

  return parsed;
}

function parseResumeRange(value: string): ResumeSelection {
  const match = /^(\d+)\.\.(\d+)$/u.exec(value);
  if (!match) {
    throw new Error(
      "--range requires the form <start>..<end> using positive 1-based indexes.",
    );
  }

  const [, startValue, endValue] = match;
  const startIndex = parsePositiveIndex(startValue, "--range");
  const endIndex = parsePositiveIndex(endValue, "--range");
  if (startIndex > endIndex) {
    throw new Error(
      "--range requires the start index to be less than or equal to the end index.",
    );
  }

  return { endIndex, kind: "range", startIndex };
}

function readFlagValue(
  args: string[],
  flagName: "--from" | "--only" | "--range",
): null | string {
  let value: null | string = null;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? "";
    if (argument === flagName) {
      value = storeFlagValue(
        value,
        readFollowingFlagValue(args, index, flagName),
        flagName,
      );
      index += 1;
      continue;
    }

    const inlineValue = readInlineFlagValue(argument, flagName);
    if (inlineValue === null) {
      continue;
    }

    value = storeFlagValue(value, inlineValue, flagName);
  }

  return value;
}

function readFollowingFlagValue(
  args: string[],
  index: number,
  flagName: string,
): string {
  const nextArgument = args[index + 1] ?? "";
  if (nextArgument.length === 0 || nextArgument.startsWith("-")) {
    throw new Error(`${flagName} requires a value.`);
  }

  return nextArgument;
}

function readInlineFlagValue(
  argument: string,
  flagName: string,
): null | string {
  const inlinePrefix = `${flagName}=`;
  if (!argument.startsWith(inlinePrefix)) {
    return null;
  }

  const inlineValue = argument.slice(inlinePrefix.length);
  if (inlineValue.length === 0) {
    throw new Error(`${flagName} requires a value.`);
  }

  return inlineValue;
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

function resolveResumeSelection(args: string[]): ResumeSelection {
  const fromValue = readFlagValue(args, "--from");
  const onlyValue = readFlagValue(args, "--only");
  const rangeValue = readFlagValue(args, "--range");
  const providedSelections = [fromValue, onlyValue, rangeValue].filter(
    (value) => value !== null,
  ).length;

  if (providedSelections === 0) {
    return { kind: "all" };
  }
  if (providedSelections > 1) {
    throw new Error(
      "Resume selection flags are mutually exclusive. Use only one of --from, --only, or --range.",
    );
  }
  if (fromValue !== null) {
    return {
      kind: "from",
      startIndex: parsePositiveIndex(fromValue, "--from"),
    };
  }
  if (onlyValue !== null) {
    return parseOnlySelection(onlyValue);
  }

  return parseResumeRange(rangeValue ?? "");
}

function storeFlagValue(
  currentValue: null | string,
  nextValue: string,
  flagName: string,
): string {
  if (currentValue !== null) {
    throw new Error(`${flagName} may only be provided once.`);
  }

  return nextValue;
}
