const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${String.fromCodePoint(0x1b)}\\[[0-9;]*[A-Za-z]`,
  "gu",
);
const CONTROL_CHARACTER = /\p{Cc}/gu;
const SAFE_LINE_CONTROL_CHARACTERS = new Set(["\t", "\n", "\r"]);

export function sanitizeGitOutput(output: string): string {
  return stripUnsafeControlCharacters(stripAnsiEscapeSequences(output));
}

function stripAnsiEscapeSequences(output: string): string {
  return output.replace(ANSI_ESCAPE_SEQUENCE, "");
}

function stripUnsafeControlCharacters(output: string): string {
  return output.replace(CONTROL_CHARACTER, (char) =>
    SAFE_LINE_CONTROL_CHARACTERS.has(char) ? char : "",
  );
}
