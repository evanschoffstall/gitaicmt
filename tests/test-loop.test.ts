const { describe, expect, test } = await import("bun:test");

import { parseLoopArgs } from "../scripts/test-loop.ts";

describe("test-loop", () => {
  test("uses bun test by default", () => {
    expect(parseLoopArgs([])).toEqual({
      command: ["bun", "test"],
      delayMs: 250,
    });
  });

  test("parses delay-ms with separate value", () => {
    expect(parseLoopArgs(["--delay-ms", "1000"])).toEqual({
      command: ["bun", "test"],
      delayMs: 1000,
    });
  });

  test("parses delay-ms with equals syntax and custom command", () => {
    expect(
      parseLoopArgs([
        "--delay-ms=5",
        "--",
        "bun",
        "test",
        "tests/terminal-ui.test.ts",
      ]),
    ).toEqual({
      command: ["bun", "test", "tests/terminal-ui.test.ts"],
      delayMs: 5,
    });
  });

  test("parses positional custom commands without a double dash", () => {
    expect(parseLoopArgs(["bun", "test", "tests/terminal-ui.test.ts"])).toEqual(
      {
        command: ["bun", "test", "tests/terminal-ui.test.ts"],
        delayMs: 250,
      },
    );
  });

  test("rejects invalid delay-ms values", () => {
    expect(() => parseLoopArgs(["--delay-ms", "-1"])).toThrow(
      "Invalid --delay-ms value: -1",
    );
  });
});
