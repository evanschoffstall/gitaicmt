import { resolveTerminalColumns } from "./terminal/columns.js";

const DEFAULT_VERBOSE_WIDTH = 100;

export function resolveDisplayWidth(): number {
  return Math.max(24, resolveSharedTerminalWidth() - 6);
}

export function resolveLogWidth(): number {
  return Math.max(20, resolveSharedTerminalWidth() - 1);
}

export function resolveVerboseWidth(): number {
  return Math.max(24, resolveSharedTerminalWidth() - 14);
}

function resolveSharedTerminalWidth(): number {
  return resolveTerminalColumns({
    fallbackColumns: DEFAULT_VERBOSE_WIDTH,
    streams: [process.stderr, process.stdout],
  });
}
