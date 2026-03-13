import {
  renderThinkingFrame,
  shouldAnimateThinkingIndicator,
  THINKING_GLYPHS,
  THINKING_MESSAGES,
  withThinkingIndicator,
} from "../src/terminal-ui.js";

const { describe, expect, test } = await import("bun:test");

function createWriter(isTTY: boolean) {
  const writes: string[] = [];
  return {
    isTTY,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    writes,
  };
}

const ESC = String.fromCodePoint(0x1b);

function stripAnsi(value: string): string {
  return value
    .replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "")
    .replace(new RegExp(`\\r${ESC}\\[2K`, "g"), "");
}

describe("terminal-ui", () => {
  test("shouldAnimateThinkingIndicator requires a tty", () => {
    expect(shouldAnimateThinkingIndicator(createWriter(true))).toBe(true);
    expect(shouldAnimateThinkingIndicator(createWriter(false))).toBe(false);
  });

  test("renderThinkingFrame uses a rich truecolor gradient", () => {
    const frame = renderThinkingFrame(0);
    const plainFrame = stripAnsi(frame);

    expect(frame).toContain("\x1b[38;2;");
    expect(
      THINKING_MESSAGES.some((message) => plainFrame.includes(`${message}...`)),
    ).toBe(true);
    expect(THINKING_GLYPHS.some((glyph) => frame.includes(glyph))).toBe(true);
    expect(frame).not.toContain("❄");
  });

  test("renderThinkingFrame keeps a stable two-column layout across messages", () => {
    const firstFrame = stripAnsi(renderThinkingFrame(0));
    const laterFrame = stripAnsi(renderThinkingFrame(24));

    expect(firstFrame.length).toBe(laterFrame.length);
    expect(firstFrame[0]?.trim().length).toBe(1);
    expect(firstFrame[1]).toBe(" ");
    expect(laterFrame[0]?.trim().length).toBe(1);
    expect(laterFrame[1]).toBe(" ");
  });

  test("withThinkingIndicator renders a starburst animation and clears it", async () => {
    const writer = createWriter(true);

    const result = await withThinkingIndicator(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "done";
      },
      {
        frameIntervalMs: 1,
        output: writer,
      },
    );

    expect(result).toBe("done");
    expect(
      writer.writes.some((chunk) =>
        THINKING_GLYPHS.some((glyph) => chunk.includes(glyph)),
      ),
    ).toBe(true);
    expect(writer.writes.some((chunk) => chunk.includes("\x1b[38;2;"))).toBe(
      true,
    );
    expect(writer.writes.at(-1)).toContain("\r\x1b[2K");
  });

  test("withThinkingIndicator stays silent when disabled", async () => {
    const writer = createWriter(true);

    await withThinkingIndicator(async () => undefined, {
      enabled: false,
      output: writer,
    });

    expect(writer.writes).toHaveLength(0);
  });
});
