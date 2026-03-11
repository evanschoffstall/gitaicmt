import { getPlanningAffinityKey } from "./ai-paths.js";
import { MAX_FILES_PER_BATCH, MAX_GROUPING_PROMPT_LINES } from "./constants.js";

type FileDiff = import("./diff.js").FileDiff;

export function batchFilesForGrouping(files: FileDiff[]): FileDiff[][] {
  const indexedFiles = files.map((file, index) => ({
    file,
    index,
    key: getPlanningAffinityKey(file.path),
  }));
  indexedFiles.sort((left, right) => {
    if (left.key === right.key) {
      return left.index - right.index;
    }
    return left.key.localeCompare(right.key);
  });

  const batches: FileDiff[][] = [];
  let currentBatch: FileDiff[] = [];
  let currentLines = 12;

  for (const entry of indexedFiles) {
    const fileLines = estimateFilePromptLines(entry.file);
    const wouldOverflow =
      currentBatch.length > 0 &&
      (currentBatch.length >= MAX_FILES_PER_BATCH ||
        currentLines + fileLines > MAX_GROUPING_PROMPT_LINES);

    if (wouldOverflow) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLines = 12;
    }

    currentBatch.push(entry.file);
    currentLines += fileLines;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
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
  const categoryHeaderLines = 1;
  return diffHeaderLines + referenceLines + categoryHeaderLines + hunkLines;
}

function estimateGroupingPromptLines(files: FileDiff[]): number {
  const promptOverheadLines = 12 + files.length;
  return (
    promptOverheadLines +
    files.reduce((total, file) => total + estimateFilePromptLines(file), 0)
  );
}
