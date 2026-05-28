import { createInterface } from "node:readline";

import { wrapTerminalTextBlock } from "./terminal/line-wrapping.js";
import { writeTerminalLines } from "./terminal/output-ui.js";
import { resolveLogWidth } from "./viewport.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface PromptYesNoOptions {
  defaultOnEof?: boolean;
}

export async function promptYesNo(
  question: string,
  options: PromptYesNoOptions = {},
): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const wrappedQuestionLines = wrapTerminalTextBlock(
    question,
    resolveLogWidth(),
  );
  const defaultOnEof = options.defaultOnEof ?? true;

  try {
    for (;;) {
      const answer = await readPromptAnswer(rl, wrappedQuestionLines);
      if (answer === "__EOF__") {
        writeTerminalLines([""]);
        return defaultOnEof;
      }

      const normalizedAnswer = answer.trim().toLowerCase();
      if (normalizedAnswer === "y" || normalizedAnswer === "yes") {
        return true;
      }
      if (normalizedAnswer === "n" || normalizedAnswer === "no") {
        return false;
      }
    }
  } finally {
    rl.close();
  }
}

function readPromptAnswer(
  rl: ReturnType<typeof createInterface>,
  wrappedQuestionLines: string[],
): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;

    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      process.stdin.off("end", onEnd);
      resolve("__EOF__");
    };

    process.stdin.once("end", onEnd);
    const [promptLine = "", ...leadingLines] = wrappedQuestionLines.slice().reverse();
    if (leadingLines.length > 0) {
      writeTerminalLines(leadingLines.reverse());
    }
    rl.question(`${promptLine} ${DIM}(y/n)${RESET} `, (answer) => {
      if (settled) {
        return;
      }
      settled = true;
      process.stdin.off("end", onEnd);
      resolve(answer);
    });
  });
}