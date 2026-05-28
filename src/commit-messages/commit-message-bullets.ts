/** Detect an indented continuation line that belongs to the preceding bullet. */
export function isBulletContinuationLine(
  line: string,
  previousLineWasBullet: boolean,
): boolean {
  return /^\s{2,}\S/.test(line) && previousLineWasBullet;
}

/** Detect a conventional bullet line in the commit body. */
export function isBulletLine(line: string): boolean {
  return /^\s*-\s+\S/.test(line);
}

/** Remove only trailing blank lines so commit body validation preserves meaningful spacing. */
export function trimTrailingBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed.at(-1)?.trim() === "") {
    trimmed.pop();
  }
  return trimmed;
}
