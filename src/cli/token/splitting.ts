/** Shared separator-aware token splitting for narrow terminal rendering. */

/**
 * Splits a token into smaller segments, preferring path-like separators before
 * falling back to hard boundaries.
 */
export function splitTokenBySeparatorPreference(
  token: string,
  maxWidth: number,
): string[] {
  if (token.length <= maxWidth) {
    return [token];
  }

  const segments: string[] = [];
  let remainingToken = token;

  while (remainingToken.length > 0) {
    if (remainingToken.length <= maxWidth) {
      segments.push(remainingToken);
      break;
    }

    const splitIndex = findSeparatorAwareSplitIndex(remainingToken, maxWidth);
    segments.push(remainingToken.slice(0, splitIndex));
    remainingToken = remainingToken.slice(splitIndex);
  }

  return segments;
}

/**
 * Wraps whitespace-separated text to a maximum width while preferring
 * separator-aware splits for oversized tokens.
 */
export function wrapTokenizedTextBySeparatorPreference(
  text: string,
  maxWidth: number,
): string[] {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return [""];
  }

  const parts = trimmedText.split(/\s+/u).filter((part) => part.length > 0);
  const lines: string[] = [];
  let currentLine = "";

  for (const part of parts) {
    for (const segment of splitTokenBySeparatorPreference(part, maxWidth)) {
      const candidate =
        currentLine.length === 0 ? segment : `${currentLine} ${segment}`;
      if (candidate.length <= maxWidth) {
        currentLine = candidate;
        continue;
      }

      if (currentLine.length > 0) {
        lines.push(currentLine);
      }
      currentLine = segment;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

function findSeparatorAwareSplitIndex(token: string, maxWidth: number): number {
  const candidate = token.slice(0, maxWidth);
  const separatorIndexes = ["/", "-", ".", "_"].map((separator) =>
    candidate.lastIndexOf(separator),
  );
  const bestSeparatorIndex = Math.max(...separatorIndexes);

  if (bestSeparatorIndex >= Math.max(3, Math.floor(maxWidth / 3))) {
    return bestSeparatorIndex + 1;
  }

  return maxWidth;
}
