import { withThinkingIndicator } from "../src/terminal-ui.js";

interface SignalSource {
  off(event: StopSignal, listener: (signal: StopSignal) => void): void;
  once(event: StopSignal, listener: (signal: StopSignal) => void): void;
}

type StopSignal = "SIGINT" | "SIGTERM";

export async function runThinkingPreview(): Promise<void> {
  process.stderr.write(
    "Previewing thinking indicator. Press Ctrl+C to stop.\n",
  );

  const signal = await withThinkingIndicator(() => waitForStopSignal(), {
    enabled: true,
  });

  process.stderr.write(`\nStopped thinking preview on ${signal}.\n`);
}

export function waitForStopSignal(
  signalSource: SignalSource = process,
): Promise<StopSignal> {
  return new Promise<StopSignal>((resolve) => {
    const handleSignal = (signal: StopSignal) => {
      signalSource.off("SIGINT", handleSignal);
      signalSource.off("SIGTERM", handleSignal);
      resolve(signal);
    };

    signalSource.once("SIGINT", handleSignal);
    signalSource.once("SIGTERM", handleSignal);
  });
}

if (import.meta.main) {
  runThinkingPreview().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exit(1);
  });
}
