import { wrapTerminalTextBlock } from "./terminal/line-wrapping.js";
import { writeTerminalLines } from "./terminal/output-ui.js";
import { resolveLogWidth } from "./viewport.js";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export function die(message: string): never {
  writeTerminalLines(
    wrapTerminalTextBlock(`${RED}error:${RESET} ${message}`, resolveLogWidth()),
  );
  process.exit(1);
}