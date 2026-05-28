import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveGitAICmtCacheDirectory } from "../application/cache-paths.js";
import { setTerminalLineObserver } from "./terminal/output-ui.js";

type OutputMode = "off" | "summary" | "trace";

let activeTraceFilePath: null | string = null;

/**
 * Reset or prepare the active trace transcript based on the selected output
 * mode.
 */
export function configureTracePersistence(mode: OutputMode): void {
  if (mode !== "trace") {
    activeTraceFilePath = null;
    setTerminalLineObserver(null);
    return;
  }

  activeTraceFilePath = createTraceSessionFilePath();

  try {
    writeFileSync(activeTraceFilePath, "", "utf-8");
  } catch {
    activeTraceFilePath = null;
    setTerminalLineObserver(null);
    return;
  }

  setTerminalLineObserver((lines, output) => {
    if (output !== process.stderr || lines.length === 0) {
      return;
    }

    appendTraceLines(lines);
  });
}

/**
 * Resolve the directory that stores persisted trace transcripts for CLI runs.
 */
export function resolveTraceDirectory(): string {
  return resolveGitAICmtCacheDirectory("traces");
}

/**
 * Append rendered terminal lines after stripping ANSI styling so the saved
 * transcript stays readable in editors and plain-text viewers.
 */
function appendTraceLines(lines: string[]): void {
  if (!activeTraceFilePath) {
    return;
  }

  try {
    appendFileSync(
      activeTraceFilePath,
      `${lines.map(sanitizeTerminalLine).join("\n")}\n`,
      "utf-8",
    );
  } catch {
    // Trace capture is diagnostic-only and must never interrupt execution.
  }
}

/**
 * Allocate a fresh trace transcript path under the user cache directory.
 */
function createTraceSessionFilePath(): string {
  const directory = resolveTraceDirectory();
  mkdirSync(directory, { recursive: true });

  return join(
    directory,
    `${formatTraceFileTimestamp(new Date())}-${process.pid}-${randomUUID()}.log`,
  );
}

/**
 * Produce a filename-safe UTC timestamp for persisted trace artifacts.
 */
function formatTraceFileTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

/** Detect the terminating byte for a CSI ANSI escape sequence. */
function isAnsiSequenceTerminator(character: string | undefined): boolean {
  if (!character) {
    return true;
  }

  const codePoint = character.charCodeAt(0);
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

/** Remove terminal control sequences while preserving visible text. */
function sanitizeTerminalLine(line: string): string {
  let sanitizedLine = "";

  for (let index = 0; index < line.length; index++) {
    const character = line[index];

    if (character === "\u001b" && line[index + 1] === "[") {
      index += 2;
      while (index < line.length && !isAnsiSequenceTerminator(line[index])) {
        index += 1;
      }
      continue;
    }

    if (character !== "\r") {
      sanitizedLine += character;
    }
  }

  return sanitizedLine;
}
