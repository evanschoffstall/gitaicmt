/**
 * Resume-specific CLI parsing output consumed by the top-level option parser.
 */
export interface ParsedResumeOptions {
  resumeCommand: ResumeCommand;
  resumeHash: null | string;
  resumeSelection: ResumeSelection;
}

/**
 * Supported resume subcommands.
 */
export type ResumeCommand = "execute" | "list";

/**
 * Normalized saved-plan selection supplied to `resume <hash>` execution.
 */
export type ResumeSelection =
  | { endIndex: number; kind: "range"; startIndex: number }
  | { indices: number[]; kind: "only" }
  | { kind: "all" }
  | { kind: "from"; startIndex: number };

/**
 * Parse resume-specific subcommands and selection flags from the raw CLI args.
 */
export function resolveResumeOptions(
  args: string[],
  positionalArgs: string[],
): ParsedResumeOptions {
  const resumeCommand = resolveResumeCommand(positionalArgs);

  return {
    resumeCommand,
    resumeHash:
      resumeCommand === "execute" && isResumeCommand(positionalArgs[0] ?? "")
        ? (positionalArgs[1] ?? null)
        : null,
    resumeSelection: resolveResumeSelection(args),
  };
}

function isResumeCommand(argument: string): boolean {
  return argument === "resume" || argument === "r";
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

function resolveResumeCommand(positionalArgs: string[]): ResumeCommand {
  if (!isResumeCommand(positionalArgs[0] ?? "")) {
    return "execute";
  }

  return positionalArgs[1] === "list" ? "list" : "execute";
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
