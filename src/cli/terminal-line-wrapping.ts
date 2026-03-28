/**
 * Terminal line wrapping helpers that preserve ANSI color escapes while
 * wrapping to a narrow visible width.
 */

/** Removes ANSI styling escapes so callers can measure visible width. */
export function stripAnsi(text: string): string {
  let result = "";

  for (let index = 0; index < text.length; ) {
    const escapeLength = getAnsiEscapeLength(text, index);
    if (escapeLength > 0) {
      index += escapeLength;
      continue;
    }

    result += text[index];
    index++;
  }

  return result;
}

/** Returns the visible character width of one terminal line. */
export function visibleLineLength(text: string): number {
  return stripAnsi(text).length;
}

/** Wraps newline-delimited terminal text while preserving existing blank lines. */
export function wrapTerminalTextBlock(
  text: string,
  maxWidth: number,
): string[] {
  return text
    .split("\n")
    .flatMap((line) => wrapTerminalTextLine(line, maxWidth));
}

/** Wraps a possibly ANSI-colored terminal line to the requested visible width. */
export function wrapTerminalTextLine(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || text.length === 0) {
    return [text];
  }

  const leadingAnsi = getLeadingAnsiPrefix(text);
  const afterLeadingAnsi = text.slice(leadingAnsi.length);
  const indentation = getLeadingWhitespace(afterLeadingAnsi);
  const indentationVisibleLength = indentation.length;
  const continuationPrefix = `${leadingAnsi}${indentation}`;
  const content = afterLeadingAnsi.slice(indentation.length);
  const tokens = content.match(/\S+/gu) ?? [];

  if (tokens.length === 0) {
    return [text];
  }

  const lines: string[] = [];
  let currentLine = continuationPrefix;
  let currentVisibleLength = indentationVisibleLength;
  let hasContent = false;

  for (const token of tokens) {
    for (const segment of splitTokenToWidth(
      token,
      Math.max(1, maxWidth - indentationVisibleLength),
    )) {
      const segmentVisibleLength = visibleLineLength(segment);
      const candidateVisibleLength = hasContent
        ? currentVisibleLength + 1 + segmentVisibleLength
        : currentVisibleLength + segmentVisibleLength;

      if (!hasContent) {
        currentLine += segment;
        currentVisibleLength += segmentVisibleLength;
        hasContent = true;
        continue;
      }

      if (candidateVisibleLength <= maxWidth) {
        currentLine += ` ${segment}`;
        currentVisibleLength = candidateVisibleLength;
        continue;
      }

      lines.push(currentLine);
      currentLine = `${continuationPrefix}${segment}`;
      currentVisibleLength = indentationVisibleLength + segmentVisibleLength;
      hasContent = true;
    }
  }

  lines.push(currentLine);
  return lines;
}

/** Returns the span of one ANSI SGR escape at the provided offset. */
function getAnsiEscapeLength(text: string, startIndex: number): number {
  if (text.charCodeAt(startIndex) !== 0x1b || text[startIndex + 1] !== "[") {
    return 0;
  }

  let index = startIndex + 2;
  while (index < text.length) {
    const codePoint = text.charCodeAt(index);
    const isDigit = codePoint >= 48 && codePoint <= 57;
    if (!isDigit && text[index] !== ";") {
      return text[index] === "m" ? index - startIndex + 1 : 0;
    }
    index++;
  }

  return 0;
}

/** Returns the leading ANSI style prefix at the start of one terminal line. */
function getLeadingAnsiPrefix(text: string): string {
  let prefix = "";

  for (let index = 0; index < text.length; ) {
    const escapeLength = getAnsiEscapeLength(text, index);
    if (escapeLength === 0) {
      break;
    }

    prefix += text.slice(index, index + escapeLength);
    index += escapeLength;
  }

  return prefix;
}

/** Returns the leading ASCII whitespace prefix for indentation. */
function getLeadingWhitespace(text: string): string {
  let index = 0;
  while (index < text.length && /\s/u.test(text[index] ?? "")) {
    index++;
  }

  return text.slice(0, index);
}

function splitPlainToken(token: string, maxWidth: number): [string, string] {
  if (token.length <= maxWidth) {
    return [token, ""];
  }

  return [token.slice(0, maxWidth), token.slice(maxWidth)];
}

function splitTokenToWidth(token: string, maxWidth: number): string[] {
  if (visibleLineLength(token) <= maxWidth || token.includes("\x1b[")) {
    return [token];
  }

  const segments: string[] = [];
  let remainingToken = token;

  while (remainingToken.length > 0) {
    const [chunk, rest] = splitPlainToken(remainingToken, maxWidth);
    segments.push(chunk);
    remainingToken = rest;
  }

  return segments;
}