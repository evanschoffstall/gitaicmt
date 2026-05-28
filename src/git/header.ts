const DEV_NULL_PATH = "/dev/null";
const DIFF_GIT_PREFIX = "diff --git ";

const GIT_QUOTED_PATH_ESCAPE_BYTES = {
  '"': 0x22,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
} as const;

export const DIFF_NEW_FILE_MARKER = "+++ ";
export const DIFF_OLD_FILE_MARKER = "--- ";
export const DIFF_DEV_NULL_PATH = DEV_NULL_PATH;

export function encodeGitQuotedPath(path: string): string {
  let needsQuoting = false;
  let encodedPath = "";

  for (const byte of Buffer.from(path)) {
    if (byte === 0x22) {
      encodedPath += '\\"';
      needsQuoting = true;
      continue;
    }
    if (byte === 0x5c) {
      encodedPath += "\\\\";
      needsQuoting = true;
      continue;
    }
    if (byte === 0x09) {
      encodedPath += "\\t";
      needsQuoting = true;
      continue;
    }
    if (byte === 0x0a) {
      encodedPath += "\\n";
      needsQuoting = true;
      continue;
    }
    if (byte === 0x0d) {
      encodedPath += "\\r";
      needsQuoting = true;
      continue;
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      encodedPath += String.fromCharCode(byte);
      continue;
    }

    encodedPath += `\\${byte.toString(8).padStart(3, "0")}`;
    needsQuoting = true;
  }

  return needsQuoting ? `"${encodedPath}"` : encodedPath;
}

export function normalizeDiffPath(rawPath: string): string {
  const trimmedPath = rawPath.trim();
  return isQuotedPath(trimmedPath)
    ? decodeGitQuotedPath(trimmedPath)
    : trimmedPath;
}

export function parseFileHeader(
  line: string,
): null | { newPath: string; oldPath: string } {
  if (!line.startsWith(DIFF_GIT_PREFIX)) {
    return null;
  }

  const pair = splitDiffHeaderPaths(line.slice(DIFF_GIT_PREFIX.length));
  if (!pair) {
    return null;
  }

  const [rawOldPath, rawNewPath] = pair;
  return {
    newPath: stripCanonicalDiffPrefix(normalizeDiffPath(rawNewPath), "b/"),
    oldPath: stripCanonicalDiffPrefix(normalizeDiffPath(rawOldPath), "a/"),
  };
}

export function parseUnifiedDiffPathLine(
  line: string,
  marker: string,
): null | string {
  if (!line.startsWith(marker)) {
    return null;
  }

  const path = normalizeDiffPath(line.slice(marker.length));
  if (path.length === 0) {
    return null;
  }
  if (path === DEV_NULL_PATH) {
    return path;
  }
  if (marker === DIFF_OLD_FILE_MARKER) {
    return stripCanonicalDiffPrefix(path, "a/");
  }
  return marker === DIFF_NEW_FILE_MARKER
    ? stripCanonicalDiffPrefix(path, "b/")
    : path;
}

function appendLiteralCharacter(bytes: number[], character: string): void {
  bytes.push(...Buffer.from(character));
}

function decodeGitQuotedPath(path: string): string {
  const bytes: number[] = [];
  const content = path.slice(1, -1);

  for (let index = 0; index < content.length; index++) {
    const character = content.at(index);
    if (character === undefined) {
      continue;
    }
    if (character !== "\\") {
      appendLiteralCharacter(bytes, character);
      continue;
    }

    const escapeParse = parseEscapedPathByte(content, index);
    if (!escapeParse) {
      bytes.push(0x5c);
      continue;
    }
    bytes.push(...escapeParse.bytes);
    index = escapeParse.nextIndex;
  }

  return Buffer.from(bytes).toString("utf8");
}

function getGitQuotedPathEscapeByte(character: string): number | undefined {
  return GIT_QUOTED_PATH_ESCAPE_BYTES[
    character as keyof typeof GIT_QUOTED_PATH_ESCAPE_BYTES
  ];
}

function isQuotedPath(path: string): boolean {
  return path.length >= 2 && path.startsWith('"') && path.endsWith('"');
}

function parseEscapedPathByte(
  content: string,
  index: number,
): null | { bytes: number[]; nextIndex: number } {
  const escaped = content.at(index + 1);
  if (escaped === undefined) {
    return null;
  }

  const escapeByte = getGitQuotedPathEscapeByte(escaped);
  if (escapeByte !== undefined) {
    return { bytes: [escapeByte], nextIndex: index + 1 };
  }

  const octalDigits = /^[0-7]{1,3}/u.exec(
    content.slice(index + 1, index + 4),
  )?.[0];
  if (octalDigits) {
    return {
      bytes: [Number.parseInt(octalDigits, 8)],
      nextIndex: index + octalDigits.length,
    };
  }

  return { bytes: [...Buffer.from(escaped)], nextIndex: index + 1 };
}

function parseQuotedDiffHeaderPaths(
  remainder: string,
): [string, string] | null {
  if (!remainder.startsWith('"')) {
    return null;
  }

  const firstToken = readQuotedDiffPathToken(remainder, 0);
  if (!firstToken) {
    return null;
  }

  const separator = /^\s+/u.exec(remainder.slice(firstToken.nextIndex));
  if (!separator) {
    return null;
  }

  const secondToken = readQuotedDiffPathToken(
    remainder,
    firstToken.nextIndex + separator[0].length,
  );
  if (
    !secondToken ||
    remainder.slice(secondToken.nextIndex).trim().length > 0
  ) {
    return null;
  }

  return [firstToken.token, secondToken.token];
}

function readQuotedDiffPathToken(
  text: string,
  startIndex: number,
): null | { nextIndex: number; token: string } {
  if (text[startIndex] !== '"') {
    return null;
  }

  let index = startIndex + 1;
  let isEscaped = false;
  while (index < text.length) {
    const character = text[index];
    if (!isEscaped && character === '"') {
      return { nextIndex: index + 1, token: text.slice(startIndex, index + 1) };
    }

    isEscaped = !isEscaped && character === "\\";
    index++;
  }

  return null;
}

function splitDiffHeaderPaths(remainder: string): [string, string] | null {
  return (
    parseQuotedDiffHeaderPaths(remainder) ??
    splitPrefixedDiffHeaderPaths(remainder) ??
    splitSimpleDiffHeaderPaths(remainder)
  );
}

function splitPrefixedDiffHeaderPaths(
  remainder: string,
): [string, string] | null {
  if (remainder.startsWith("a/")) {
    const separatorIndex = remainder.lastIndexOf(" b/");
    if (separatorIndex > 0) {
      return [
        remainder.slice(0, separatorIndex),
        remainder.slice(separatorIndex + 1),
      ];
    }
  }

  if (remainder.startsWith("b/")) {
    const separatorIndex = remainder.lastIndexOf(" a/");
    if (separatorIndex > 0) {
      return [
        remainder.slice(separatorIndex + 1),
        remainder.slice(0, separatorIndex),
      ];
    }
  }

  return null;
}

function splitSimpleDiffHeaderPaths(
  remainder: string,
): [string, string] | null {
  const separatorIndex = remainder.indexOf(" ");
  return separatorIndex === -1
    ? null
    : [remainder.slice(0, separatorIndex), remainder.slice(separatorIndex + 1)];
}

function stripCanonicalDiffPrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
