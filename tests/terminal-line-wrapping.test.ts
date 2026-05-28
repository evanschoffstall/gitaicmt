import { describe, expect, test } from "bun:test";

import {
  stripAnsi,
  visibleLineLength,
  wrapTerminalTextBlock,
  wrapTerminalTextLine,
} from "../src/cli/terminal/line-wrapping.js";

describe("terminal line wrapping", () => {
  test("measures visible width without ANSI escapes", () => {
    expect(visibleLineLength("\x1b[31merror:\x1b[0m message")).toBe(14);
    expect(stripAnsi("\x1b[2mwrapped\x1b[0m")).toBe("wrapped");
  });

  test("wraps ANSI-colored lines by visible width", () => {
    expect(
      wrapTerminalTextLine(
        "\x1b[2mestimated tokens: baseline estimate conservatively exceeds threshold\x1b[0m",
        28,
      ).every((line) => visibleLineLength(line) <= 28),
    ).toBe(true);
  });

  test("preserves indentation on continuation lines", () => {
    expect(
      wrapTerminalTextLine(
        "  No staged changes detected, auto-staging all changes...",
        24,
      ),
    ).toEqual([
      "  No staged changes",
      "  detected, auto-staging",
      "  all changes...",
    ]);
  });

  test("splits long plain tokens on very small screens", () => {
    expect(wrapTerminalTextLine("src/cli/main.ts", 12)).toEqual([
      "src/cli/main",
      ".ts",
    ]);
  });

  test("wraps newline-delimited blocks while preserving blank lines", () => {
    expect(
      wrapTerminalTextBlock("Header\n\nA very long line to wrap", 12),
    ).toEqual(["Header", "", "A very long", "line to wrap"]);
  });
});
