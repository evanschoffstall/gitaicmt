import { describe, expect, test } from "bun:test";

import { resolveTerminalColumns } from "../src/cli/terminal-columns.js";

describe("terminal geometry", () => {
  test("prefers direct stream columns when available", () => {
    expect(
      resolveTerminalColumns({
        fallbackColumns: 100,
        streams: [{ columns: 132 }],
      }),
    ).toBe(132);
  });

  test("falls back to getWindowSize when columns are unavailable", () => {
    expect(
      resolveTerminalColumns({
        fallbackColumns: 100,
        streams: [{ getWindowSize: () => [118, 40] }],
      }),
    ).toBe(118);
  });

  test("uses environment COLUMNS when streams do not report size", () => {
    expect(
      resolveTerminalColumns({
        environment: { COLUMNS: "91" },
        fallbackColumns: 100,
        streams: [{ columns: 0 }],
      }),
    ).toBe(91);
  });

  test("returns fallback when no universal source reports terminal width", () => {
    expect(
      resolveTerminalColumns({
        environment: { COLUMNS: "" },
        fallbackColumns: 100,
        streams: [{ columns: 0, getWindowSize: () => [0, 0] }],
      }),
    ).toBe(100);
  });
});