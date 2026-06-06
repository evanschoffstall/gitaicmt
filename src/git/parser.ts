import type { DiffHunk, FileDiff } from "./models.js";

import {
  DIFF_DEV_NULL_PATH,
  DIFF_NEW_FILE_MARKER,
  DIFF_OLD_FILE_MARKER,
  normalizeDiffPath,
  parseFileHeader,
  parseUnifiedDiffPathLine,
} from "./header.js";

const HUNK_HEADER = /^@@ -([0-9,]+) \+([0-9,]+) @@/;
const STATUS_PREFIXES = [
  "new file",
  "deleted file",
  "similarity index",
  "rename from",
  "rename to",
  "index ",
] as const;

export function parseDiff(raw: string): FileDiff[] {
  if (!raw || typeof raw !== "string") {
    return [];
  }

  const files: FileDiff[] = [];
  const state: {
    current: FileDiff | null;
    currentHunk: DiffHunk | null;
    sawFileLevelChange: boolean;
  } = {
    current: null,
    currentHunk: null,
    sawFileLevelChange: false,
  };

  const flushCurrent = () => {
    if (
      state.current &&
      (state.current.hunks.length > 0 ||
        state.current.status !== "modified" ||
        state.sawFileLevelChange)
    ) {
      files.push(state.current);
    }
  };

  for (const line of raw.split("\n")) {
    if (!line) {
      continue;
    }

    const nextFile = parseNextFile(line, flushCurrent);
    if (nextFile) {
      state.current = nextFile;
      state.currentHunk = null;
      state.sawFileLevelChange = false;
      continue;
    }
    if (!state.current) {
      continue;
    }

    const currentState = {
      current: state.current,
      currentHunk: state.currentHunk,
      sawFileLevelChange: state.sawFileLevelChange,
    };
    handleDiffLine(currentState, line);
    state.current = currentState.current;
    state.currentHunk = currentState.currentHunk;
    state.sawFileLevelChange = currentState.sawFileLevelChange;
  }

  flushCurrent();
  return files;
}

function applyDiffPathUpdate(
  current: FileDiff,
  line: string,
  marker: string,
  target: "oldPath" | "path",
): boolean {
  const updatedPath = parseUnifiedDiffPathLine(line, marker);
  if (updatedPath === null) {
    return false;
  }
  if (updatedPath === DIFF_DEV_NULL_PATH) {
    return true;
  }

  current[target] = updatedPath;
  if (target === "path" && current.oldPath === current.path) {
    current.oldPath = null;
  }
  return true;
}

function applyFileMetadataLine(current: FileDiff, line: string): boolean {
  const metadataAction = classifyMetadataLine(line);
  if (!metadataAction) {
    return false;
  }

  if (metadataAction === "noop") {
    current.metadataLines?.push(line);
    return true;
  }

  if (metadataAction === "added") {
    current.status = "added";
  } else if (metadataAction === "deleted") {
    current.status = "deleted";
  } else {
    current.status = "renamed";
    const oldName = normalizeDiffPath(line.slice("rename from ".length));
    if (oldName) {
      current.oldPath = oldName;
    }
  }
  current.metadataLines?.push(line);
  return true;
}

function applyHunkLine(current: FileDiff, hunk: DiffHunk, line: string): void {
  if (
    !(
      line.startsWith("+") ||
      line.startsWith("-") ||
      line.startsWith(" ") ||
      line.startsWith("\\")
    )
  ) {
    return;
  }

  hunk.lines.push(line);
  if (line.startsWith("+")) {
    current.additions++;
  } else if (line.startsWith("-")) {
    current.deletions++;
  }
}

function classifyMetadataLine(
  line: string,
): "added" | "deleted" | "noop" | "renamed" | false {
  if (line.startsWith("new file")) {
    return "added";
  }
  if (line.startsWith("deleted file")) {
    return "deleted";
  }
  if (line.startsWith("rename from")) {
    return "renamed";
  }
  if (
    line.startsWith("index ") ||
    line.startsWith("similarity index") ||
    line.startsWith("rename to") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ")
  ) {
    return "noop";
  }
  return STATUS_PREFIXES.some((prefix) => line.startsWith(prefix))
    ? "noop"
    : false;
}

function createParsedFile(oldPath: string, newPath: string): FileDiff {
  return {
    additions: 0,
    deletions: 0,
    hunks: [],
    metadataLines: [],
    oldPath: oldPath !== newPath ? oldPath : null,
    path: newPath,
    status: "modified",
  };
}

function handleDiffLine(
  state: {
    current: FileDiff;
    currentHunk: DiffHunk | null;
    sawFileLevelChange: boolean;
  },
  line: string,
): void {
  if (
    applyDiffPathUpdate(state.current, line, DIFF_OLD_FILE_MARKER, "oldPath")
  ) {
    return;
  }
  if (applyDiffPathUpdate(state.current, line, DIFF_NEW_FILE_MARKER, "path")) {
    return;
  }

  const nextHunk = parseHunkHeader(line);
  if (nextHunk) {
    state.currentHunk = nextHunk;
    state.current.hunks.push(nextHunk);
    return;
  }
  if (applyFileMetadataLine(state.current, line)) {
    state.sawFileLevelChange ||= isMeaningfulFileMetadataLine(line);
    return;
  }
  if (isBinaryMarker(line)) {
    state.current.isBinary = true;
    state.sawFileLevelChange = true;
    return;
  }
  if (state.currentHunk) {
    applyHunkLine(state.current, state.currentHunk, line);
  }
}

function isBinaryMarker(line: string): boolean {
  return line.startsWith("Binary files");
}

function isMeaningfulFileMetadataLine(line: string): boolean {
  return !line.startsWith("index ");
}

function parseHunkHeader(line: string): DiffHunk | null {
  const match = HUNK_HEADER.exec(line);
  if (!match) {
    return null;
  }

  const oldRange = parseRange(match[1]);
  const newRange = parseRange(match[2]);
  return {
    countNew: newRange.count,
    countOld: oldRange.count,
    header: line,
    lines: [],
    startNew: newRange.start,
    startOld: oldRange.start,
  };
}

function parseNextFile(
  line: string,
  flushCurrent: () => void,
): FileDiff | null {
  const parsedHeader = parseFileHeader(line);
  if (!parsedHeader) {
    return null;
  }

  flushCurrent();
  return createParsedFile(parsedHeader.oldPath, parsedHeader.newPath);
}

function parseRange(range: string): { count: number; start: number } {
  const parts = range.split(",", 2);
  return {
    count: Number(parts.length === 2 ? parts[1] : "1"),
    start: Number(parts[0]),
  };
}
