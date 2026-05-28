#!/usr/bin/env bun

type AiOutputEvent =
  import("../commit-planning/orchestration.js").AiOutputEvent;
type BreakingChangeMode =
  import("../commit-planning/prompts/index.js").BreakingChangeMode;
type CliOptions = import("./options.js").CliOptions;
type OutputMode = import("./options.js").OutputMode;
type PlannerNotices = typeof import("./planner-notices.js");
type PlannerNoticeState = import("./planner-notices.js").PlannerNoticeState;

type SessionDisplay = typeof import("./session-display.js");

// -------- Helpers --------

const VERSION = "1.0.0";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

type CommandHandler = () => Promise<void> | void;
type LazyCommandHandler = (
  plannerNoticeState: PlannerNoticeState,
) => Promise<void> | void;

const HELP_COMMAND_ROWS = [
  ["gitaicmt", "Detect changes, show the plan, confirm, then commit"],
  ["plan", "Preview planned commit groups without committing"],
  [
    "resume <hash>",
    "Reuse a saved plan bundle; optional --only/--from/--range runs a subset",
  ],
  ["single", "Generate one commit for all staged changes"],
  ["gen", "Generate one commit message to stdout"],
  ["init", "Create gitaicmt.config.json in the current directory"],
  ["help", "Show this help output"],
  ["version", "Show the installed version"],
] as const;

const HELP_FLAG_ROWS = [
  ["-b, --breaking", "Increase sensitivity for breaking contracts"],
  ["-n, --no-breaking", "Disable release-impact metadata"],
  ["-y, --yes", "Skip confirmation prompts"],
  ["-v, --verbose", "Show concise planning diagnostics"],
  ["--trace", "Show raw intermediate AI payloads"],
  ["--force", "Resume even when staged hash checks do not match"],
  [
    "--valid-only",
    "Resume only commits whose saved file or hunk hashes still match",
  ],
  [
    "--ignore-message-body",
    "Resume legacy saved commits without enforcing body validation",
  ],
  ["--only <n[,m...]>", "Resume and execute only the listed commit numbers"],
  ["--from <n>", "Resume and execute commits n through the end"],
  ["--range <a>..<b>", "Resume and execute commits a through b (inclusive)"],
  ["--no-token-check", "Skip the high-token confirmation prompt for one run"],
  ["-h, --help", "Show help"],
  ["--version", "Show version information"],
] as const;

const HELP_CONFIG_ROWS = [
  ["OPENAI_API_KEY", "Preferred API key source"],
  ["gitaicmt.config.json", "Project-local configuration file"],
  [".gitaicmt.json", "Legacy local configuration file name"],
] as const;

async function cmdHelp(): Promise<void> {
  const log = await createWrappedLogger();

  log(`${BOLD}gitaicmt${RESET} — AI-powered git commits`);
  log("");
  logHelpSection(log, "Usage", [["gitaicmt [command] [flags]", ""]]);
  logHelpSection(log, "Commands", HELP_COMMAND_ROWS);
  logHelpSection(log, "Flags", HELP_FLAG_ROWS);
  logHelpSection(log, "Config", HELP_CONFIG_ROWS);
}

async function cmdInit(): Promise<void> {
  const { initConfig } = await import("../application/config/index.js");
  const configPath = initConfig();
  writeRawLine(`${GREEN}Created config:${RESET} ${configPath}`);
}

function cmdVersion() {
  writeRawLine(`gitaicmt v${VERSION}`);
}

function createCommandHandlers(
  options: CliOptions,
): Map<string, CommandHandler> {
  const skipTokenCheck = options.hasYFlag || options.hasNoTokenCheckFlag;
  const commitHandler = createCommitHandler(options);
  const generateHandler = createGenerateHandler(
    options.outputMode,
    skipTokenCheck,
    options.breakingMode,
  );
  const planHandler = createPlanHandler(
    options.outputMode,
    skipTokenCheck,
    options.breakingMode,
  );
  const resumeHandler = createResumeHandler(options);
  const singleCommitHandler = createSingleCommitHandler(
    options.outputMode,
    skipTokenCheck,
    options.breakingMode,
  );

  const handlers = new Map<string, CommandHandler>([
    ["", commitHandler],
    ["--help", cmdHelp],
    ["--version", cmdVersion],
    ["-h", cmdHelp],
    ["c", commitHandler],
    ["commit", commitHandler],
    ["g", generateHandler],
    ["gen", generateHandler],
    ["generate", generateHandler],
    ["help", cmdHelp],
    ["init", cmdInit],
    ["p", planHandler],
    ["plan", planHandler],
    ["r", resumeHandler],
    ["resume", resumeHandler],
    ["s", singleCommitHandler],
    ["single", singleCommitHandler],
    ["version", cmdVersion],
  ]);
  return handlers;
}

function createCommitHandler(options: CliOptions): CommandHandler {
  return () => {
    const commandModule = import("./execution-flow.js");
    return runExecutionCommand(options.outputMode, async (noticeState) => {
      const { cmdCommit } = await commandModule;
      await cmdCommit(
        options.hasYFlag,
        options.hasNoTokenCheckFlag,
        noticeState,
        options.breakingMode,
      );
    });
  };
}

function createGenerateHandler(
  outputMode: OutputMode,
  skipTokenCheck: boolean,
  breakingMode: BreakingChangeMode,
): CommandHandler {
  return () => {
    const commandModule = import("./execution-flow.js");
    if (outputMode === "off") {
      return commandModule.then(({ cmdGenerate }) =>
        cmdGenerate(skipTokenCheck, breakingMode),
      );
    }

    return runExecutionCommand(outputMode, async () => {
      const { cmdGenerate } = await commandModule;
      await cmdGenerate(skipTokenCheck, breakingMode);
    });
  };
}

function createPlanHandler(
  outputMode: OutputMode,
  skipTokenCheck: boolean,
  breakingMode: BreakingChangeMode,
): CommandHandler {
  return () => {
    const commandModule = import("./execution-flow.js");
    return runExecutionCommand(outputMode, async (noticeState) => {
      const { cmdPlan } = await commandModule;
      await cmdPlan(skipTokenCheck, noticeState, breakingMode);
    });
  };
}

function createResumeHandler(options: CliOptions): CommandHandler {
  return () => {
    if (!options.resumeHash) {
      return import("./fatal.js").then(({ die }) =>
        die(
          "Missing saved plan bundle hash. Usage: gitaicmt resume <hash> [--force | --valid-only] [--only <n[,m...]> | --from <n> | --range <a>..<b>]",
        ),
      );
    }

    const commandModule = import("./execution-flow.js");
    return runExecutionCommand(options.outputMode, async () => {
      const { cmdResume } = await commandModule;
      await cmdResume(
        options.resumeHash ?? "",
        options.hasYFlag,
        options.hasForceFlag,
        options.hasValidOnlyFlag,
        options.resumeSelection,
        options.hasIgnoreMessageBodyFlag,
      );
    });
  };
}

function createSingleCommitHandler(
  outputMode: OutputMode,
  skipTokenCheck: boolean,
  breakingMode: BreakingChangeMode,
): CommandHandler {
  return () => {
    const commandModule = import("./execution-flow.js");
    if (outputMode === "off") {
      return commandModule.then(({ cmdCommitSingle }) =>
        cmdCommitSingle(skipTokenCheck, breakingMode),
      );
    }

    return runExecutionCommand(outputMode, async () => {
      const { cmdCommitSingle } = await commandModule;
      await cmdCommitSingle(skipTokenCheck, breakingMode);
    });
  };
}

async function createWrappedLogger(): Promise<(message: string) => void> {
  const [
    { wrapTerminalTextBlock },
    { writeTerminalLines },
    { resolveLogWidth },
  ] = await Promise.all([
    import("./terminal/line-wrapping.js"),
    import("./terminal/output-ui.js"),
    import("./viewport.js"),
  ]);

  return (message: string) => {
    writeTerminalLines(wrapTerminalTextBlock(message, resolveLogWidth()));
  };
}

function logHelpSection(
  log: Awaited<ReturnType<typeof createWrappedLogger>>,
  title: string,
  rows: readonly (readonly [string, string])[],
): void {
  log(`${CYAN}${title}:${RESET}`);
  for (const [name, description] of rows) {
    log(description.length > 0 ? `  ${name}  ${description}` : `  ${name}`);
  }
  log("");
}

async function main() {
  const { parseCliOptions } = await import("./options.js");
  const options = parseCliOptions(process.argv.slice(2));

  const handler = createCommandHandlers(options).get(options.command);
  if (!handler) {
    process.stderr.write(
      `${RED}error:${RESET} Unknown command: ${options.command}. Run 'gitaicmt help' for usage.\n`,
    );
    process.exit(1);
  }
  await handler();
}

function observeAiOutput(
  plannerNotices: PlannerNotices,
  sessionDisplay: SessionDisplay,
  plannerNoticeState: PlannerNoticeState,
  event: AiOutputEvent,
): void {
  plannerNotices.recordPlannerNotice(plannerNoticeState, event);

  if (sessionDisplay.hasVisibleOutputMode()) {
    sessionDisplay.logVerboseAiOutput(event);
  }
}

async function runExecutionCommand(
  outputMode: OutputMode,
  invoke: LazyCommandHandler,
): Promise<void> {
  // Keep lightweight commands off the planning import graph; loading it costs
  // visible startup time even when the selected command only prints metadata.
  const [plannerNotices, sessionDisplay, { setAiOutputObserver }] =
    await Promise.all([
      import("./planner-notices.js"),
      import("./session-display.js"),
      import("../commit-planning/orchestration.js"),
    ]);

  const plannerNoticeState = plannerNotices.createPlannerNoticeState();
  sessionDisplay.configureOutputMode(outputMode);
  setAiOutputObserver((event) => {
    observeAiOutput(plannerNotices, sessionDisplay, plannerNoticeState, event);
  });
  await invoke(plannerNoticeState);
}

function writeRawLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

// Explicitly exit — the OpenAI HTTP agent and any other async handles
// would otherwise keep the process alive indefinitely after completion.
main()
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    const { die } = await import("./fatal.js");
    die(err instanceof Error ? err.message : String(err));
  });
