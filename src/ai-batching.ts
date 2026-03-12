import { MAX_FILES_PER_BATCH, MAX_GROUPING_PROMPT_LINES } from "./constants.js";

type FileDiff = import("./diff.js").FileDiff;

export function batchFilesForGrouping(files: FileDiff[]): FileDiff[][] {
  const batches: FileDiff[][] = [];
  let currentBatch: FileDiff[] = [];
  let currentLines = 12;

  for (const file of files) {
    const fileLines = estimateFilePromptLines(file);
    const wouldOverflow =
      currentBatch.length > 0 &&
      (currentBatch.length >= MAX_FILES_PER_BATCH ||
        currentLines + fileLines > MAX_GROUPING_PROMPT_LINES);

    if (wouldOverflow) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLines = 12;
    }

    currentBatch.push(file);
    currentLines += fileLines;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

export function batchingMakesProgress(
  files: FileDiff[],
  batches: FileDiff[][],
): boolean {
  return (
    batches.length > 1 || batches.some((batch) => batch.length < files.length)
  );
}

export function shouldBatchFiles(files: FileDiff[]): boolean {
  return (
    files.length > MAX_FILES_PER_BATCH ||
    estimateGroupingPromptLines(files) > MAX_GROUPING_PROMPT_LINES
  );
}

function estimateFilePromptLines(file: FileDiff): number {
  const hunkLines = file.hunks.reduce(
    (total, hunk) => total + hunk.lines.length + 1,
    0,
  );
  const diffHeaderLines = 3;
  const referenceLines = file.hunks.length === 0 ? 1 : file.hunks.length + 1;
  return diffHeaderLines + referenceLines + hunkLines;
}

function estimateGroupingPromptLines(files: FileDiff[]): number {
  const promptOverheadLines = 12 + files.length;
  return (
    promptOverheadLines +
    files.reduce((total, file) => total + estimateFilePromptLines(file), 0)
  );
}
