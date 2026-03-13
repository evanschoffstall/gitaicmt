import { waitForStopSignal } from "../scripts/preview-thinking.ts";

const { describe, expect, test } = await import("bun:test");

type StopSignal = "SIGINT" | "SIGTERM";

function createSignalSource() {
  const listeners = new Map<StopSignal, (signal: StopSignal) => void>();
  const removed: StopSignal[] = [];

  return {
    emit(signal: StopSignal) {
      const listener = listeners.get(signal);
      if (!listener) {
        throw new Error(`Missing listener for ${signal}`);
      }
      listener(signal);
    },
    off(event: StopSignal, listener: (signal: StopSignal) => void) {
      if (listeners.get(event) === listener) {
        listeners.delete(event);
      }
      removed.push(event);
    },
    once(event: StopSignal, listener: (signal: StopSignal) => void) {
      listeners.set(event, listener);
    },
    removed,
  };
}

describe("preview-thinking", () => {
  test("waitForStopSignal resolves on SIGINT and cleans up handlers", async () => {
    const signalSource = createSignalSource();

    const pending = waitForStopSignal(signalSource);
    signalSource.emit("SIGINT");

    await expect(pending).resolves.toBe("SIGINT");
    expect(signalSource.removed).toEqual(["SIGINT", "SIGTERM"]);
  });

  test("waitForStopSignal resolves on SIGTERM", async () => {
    const signalSource = createSignalSource();

    const pending = waitForStopSignal(signalSource);
    signalSource.emit("SIGTERM");

    await expect(pending).resolves.toBe("SIGTERM");
  });
});
