#!/usr/bin/env node

import { initConfig } from "../application/config/index.js";
import {
  type AiOutputEvent,
  setAiOutputObserver,
} from "../commit-planning/orchestration.js";
import { cmdCommit, cmdCommitSingle, cmdGenerate, cmdPlan } from "./execution-flow.js";
import { die } from "./fatal.js";
import {
  createPlannerNoticeState,
  recordPlannerNotice,
} from "./planner-notices.js";
import {
  configureOutputMode,
  hasVisibleOutputMode,
  log,
  logVerboseAiOutput,
  type OutputMode,
} from "./session-display.js";

// -------- Helpers --------

const VERSION = "1.0.0";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const plannerNoticeState = createPlannerNoticeState();

interface CliOptions {
  command: string;
  hasNoTokenCheckFlag: boolean;
  hasYFlag: boolean;
  outputMode: OutputMode;
}

type CommandHandler = () => Promise<void> | void;

function cmdHelp() {
  log(`${BOLD}gitaicmt${RESET} — AI-powered git commits`);
  log("");
  log(`${CYAN}Usage:${RESET}`);
  log("  gitaicmt [command] [flags]");
  log("");
  log(`${CYAN}Commands:${RESET}`);
  log("  gitaicmt         Detect changes, show the plan, confirm, then commit");
  log("  plan             Preview planned commit groups without committing");
  log("  single           Generate one commit for all staged changes");
  log("  gen              Generate one commit message to stdout");
  log("  init             Create gitaicmt.config.json in the current directory");
  log("  help             Show this help output");
  log("  version          Show the installed version");
  log("");
  log(`${CYAN}Flags:${RESET}`);
  log("  -y, --yes             Skip confirmation prompts");
  log("  -v, --verbose         Show concise planning diagnostics");
  log("  --trace               Show raw intermediate AI payloads");
  log("  --no-token-check      Skip the high-token confirmation prompt for one run");
  log("  -h, --help            Show help");
  log("  --version             Show version information");
  log("");
  log(`${CYAN}Config:${RESET}`);
  log("  OPENAI_API_KEY        Preferred API key source");
  log("  gitaicmt.config.json  Project-local configuration file");
  log("  .gitaicmt.json        Legacy local configuration file name");
}

function cmdInit() {
  const configPath = initConfig();
  log(`${GREEN}Created config:${RESET} ${configPath}`);
}

function cmdVersion() {
  log(`gitaicmt v${VERSION}`);
}

function createCommandHandlers(options: CliOptions): Map<string, CommandHandler> {
  const skipTokenCheck = options.hasYFlag || options.hasNoTokenCheckFlag;
  const handlers = new Map<string, CommandHandler>([
    ["", () => cmdCommit(options.hasYFlag, options.hasNoTokenCheckFlag, plannerNoticeState)],
    ["--help", cmdHelp],
    ["--version", cmdVersion],
    ["-h", cmdHelp],
    ["c", () => cmdCommit(options.hasYFlag, options.hasNoTokenCheckFlag, plannerNoticeState)],
    ["commit", () => cmdCommit(options.hasYFlag, options.hasNoTokenCheckFlag, plannerNoticeState)],
    ["g", () => cmdGenerate(skipTokenCheck)],
    ["gen", () => cmdGenerate(skipTokenCheck)],
    ["generate", () => cmdGenerate(skipTokenCheck)],
    ["help", cmdHelp],
    ["init", cmdInit],
    ["p", () => cmdPlan(skipTokenCheck, plannerNoticeState)],
    ["plan", () => cmdPlan(skipTokenCheck, plannerNoticeState)],
    ["s", () => cmdCommitSingle(skipTokenCheck)],
    ["single", () => cmdCommitSingle(skipTokenCheck)],
    ["version", cmdVersion],
  ]);
  return handlers;
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  configureOutputMode(options.outputMode);
  setAiOutputObserver(observeAiOutput);

  const handler = createCommandHandlers(options).get(options.command);
  if (!handler) {
    die(`Unknown command: ${options.command}. Run 'gitaicmt help' for usage.`);
  }
  await handler();
}

function observeAiOutput(event: AiOutputEvent): void {
  recordPlannerNotice(plannerNoticeState, event);

  if (hasVisibleOutputMode()) {
    logVerboseAiOutput(event);
  }
}

function parseCliOptions(args: string[]): CliOptions {
  const hasYFlag = args.includes("-y") || args.includes("--yes");
  const hasNoTokenCheckFlag = args.includes("--no-token-check");
  const hasVerboseFlag = args.includes("-v") || args.includes("--verbose");
  const hasTraceFlag = args.includes("--trace");

  return {
    command: resolveCommand(args),
    hasNoTokenCheckFlag,
    hasYFlag,
    outputMode: hasTraceFlag ? "trace" : hasVerboseFlag ? "summary" : "off",
  };
}

function resolveCommand(args: string[]): string {
  if (args.includes("--version")) {
    return "version";
  }
  if (args.includes("-h") || args.includes("--help")) {
    return "help";
  }
  if (args.includes("--plan")) {
    return "plan";
  }
  return args.find((argument) => !argument.startsWith("-")) ?? "";
}

// Explicitly exit — the OpenAI HTTP agent and any other async handles
// would otherwise keep the process alive indefinitely after completion.
main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    die(err instanceof Error ? err.message : String(err));
  });
