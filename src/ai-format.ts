type FileDiff = import("./diff.js").FileDiff;

export function formatLabeledDiff(
  file: FileDiff,
  formatFileDiff: (f: FileDiff) => string,
): string {
  if (file.hunks.length <= 1) {
    return formatFileDiff(file);
  }

  const parts: string[] = [
    `--- ${file.oldPath ?? file.path}`,
    `+++ ${file.path}`,
  ];
  for (let i = 0; i < file.hunks.length; i++) {
    const hunk = file.hunks[i];
    parts.push(`[Hunk ${formatScalar(i)}] ${hunk.header}`);
    parts.push(...hunk.lines);
  }
  return parts.join("\n");
}

export function formatScalar(value: boolean | number): string {
  return String(value);
}
