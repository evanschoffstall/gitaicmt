/**
 * Diff parsing and chunking module
 * Parses git diffs into structured data and chunks them for AI analysis
 * All git command execution has been moved to git.ts
 */

import { loadConfig } from "./config.js";

// ============================================================================
// Type Definitions
// ============================================================================

/** A logical chunk of related changes ready for AI analysis */
export interface DiffChunk {
  content: string; // formatted diff text for the prompt
  files: string[];
  id: number;
  lineCount: number;
}

/** A single hunk within a file diff */
export interface DiffHunk {
  countNew: number;
  countOld: number;
  header: string; // @@ line
  lines: string[]; // raw diff lines (+/-/space)
  startNew: number;
  startOld: number;
}

/** Quick summary stats */
export interface DiffStats {
  additions: number;
  chunks: number;
  deletions: number;
  filesChanged: number;
}

/** One file's diff data */
export interface FileDiff {
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  isBinary?: boolean;
  metadataLines?: string[];
  oldPath: null | string; // for renames
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
}

// ============================================================================
// Parser
// ============================================================================

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -([0-9,]+) \+([0-9,]+) @@/;
const STATUS_PREFIXES = [
  "new file",
  "deleted file",
  "similarity index",
  "rename from",
  "rename to",
  "index ",
] as const;

/**
 * Build a full patch string from a FileDiff (for selective hunk staging)
 * Generates a complete patch that can be applied with `git apply`
 * @param file - The file diff containing hunks
 * @param hunks - Optional array of specific hunks to include (defaults to all)
 * @returns Complete patch content in unified diff format with proper headers
 */
export function buildPatch(file: FileDiff, hunks?: DiffHunk[]): string {
  const selectedHunks = hunks ?? file.hunks;
  const metadataLines = file.metadataLines ?? [];
  if (file.isBinary) {
    return "";
  }
  if (selectedHunks.length === 0 && metadataLines.length === 0) {
    return ""; // No hunks to apply
  }

  const lines: string[] = [];
  const oldPath = file.oldPath ?? file.path;

  lines.push(`diff --git a/${oldPath} b/${file.path}`);
  lines.push(...metadataLines);

  if (selectedHunks.length > 0) {
    if (file.status === "added") {
      lines.push("--- /dev/null");
      lines.push(`+++ b/${file.path}`);
    } else if (file.status === "deleted") {
      lines.push(`--- a/${oldPath}`);
      lines.push("+++ /dev/null");
    } else {
      lines.push(`--- a/${oldPath}`);
      lines.push(`+++ b/${file.path}`);
    }
  }

  for (const h of selectedHunks) {
    lines.push(h.header);
    lines.push(...h.lines);
  }
  lines.push(""); // trailing newline
  return lines.join("\n");
}

/**
 * Split diff files into chunks for AI analysis
 * Respects config settings for grouping by file/hunk and chunk size limits
 * @param files - Array of parsed file diffs to chunk
 * @returns Array of diff chunks ready for AI processing
 */
export function chunkDiffs(files: FileDiff[]): DiffChunk[] {
  const cfg = loadConfig();
  const maxLines = cfg.analysis.chunkSize;
  const chunks: DiffChunk[] = [];
  let id = 0;

  if (cfg.analysis.groupByFile) {
    // Each file gets its own chunk(s)
    for (const file of files) {
      const text = formatFileDiff(file);
      const lc = text.split("\n").length;
      if (lc <= maxLines) {
        chunks.push({
          content: text,
          files: [file.path],
          id: id++,
          lineCount: lc,
        });
      } else if (cfg.analysis.groupByHunk) {
        // Split large files by hunk
        for (const hunk of file.hunks) {
          const hText = [hunk.header, ...hunk.lines].join("\n");
          const hLc = hunk.lines.length + 1;
          chunks.push({
            content: hText,
            files: [file.path],
            id: id++,
            lineCount: hLc,
          });
        }
      } else {
        chunks.push({
          content: text,
          files: [file.path],
          id: id++,
          lineCount: lc,
        });
      }
    }
  } else {
    // Group all files into chunks up to maxLines
    let buf: string[] = [];
    let bufFiles: string[] = [];
    let bufLines = 0;
    for (const file of files) {
      const text = formatFileDiff(file);
      const lc = text.split("\n").length;
      if (bufLines + lc > maxLines && buf.length > 0) {
        chunks.push({
          content: buf.join("\n"),
          files: [...bufFiles],
          id: id++,
          lineCount: bufLines,
        });
        buf = [];
        bufFiles = [];
        bufLines = 0;
      }
      buf.push(text);
      bufFiles.push(file.path);
      bufLines += lc;
    }
    if (buf.length > 0) {
      chunks.push({
        content: buf.join("\n"),
        files: [...bufFiles],
        id,
        lineCount: bufLines,
      });
    }
  }

  return chunks;
}

/**
 * Format a FileDiff into displayable unified diff text
 * Includes --- and +++ headers, hunk headers, and diff lines
 * @param f - The file diff to format
 * @returns Formatted diff text ready for display
 */
export function formatFileDiff(f: FileDiff): string {
  const parts: string[] = [`--- ${f.oldPath ?? f.path}`, `+++ ${f.path}`];
  for (const h of f.hunks) {
    parts.push(h.header);
    parts.push(...h.lines);
  }
  return parts.join("\n");
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Calculate summary statistics for a set of files and chunks
 * @param files - Array of file diffs
 * @param chunks - Array of diff chunks
 * @returns Statistics object with counts of files, additions, deletions, and chunks
 */
export function getStats(files: FileDiff[], chunks: DiffChunk[]): DiffStats {
  return {
    additions: files.reduce((s, f) => s + f.additions, 0),
    chunks: chunks.length,
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    filesChanged: files.length,
  };
}

/**
 * Parse a raw git diff into structured FileDiff objects
 * Supports modified, added, deleted, and renamed files
 * @param raw - Raw git diff output (unified format)
 * @returns Array of parsed file diffs with hunks and statistics
 */
export function parseDiff(raw: string): FileDiff[] {
  if (!raw || typeof raw !== "string") {
    return [];
  }

  const files: FileDiff[] = [];
  const lines = raw.split("\n");
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let sawFileLevelChange = false;

  const flushCurrent = () => {
    if (!current) return;
    if (
      current.hunks.length > 0 ||
      current.status !== "modified" ||
      sawFileLevelChange
    ) {
      files.push(current);
    }
  };

  for (const line of lines) {
    if (!line) continue; // Skip empty lines

    const fMatch = FILE_HEADER.exec(line);
    if (fMatch) {
      flushCurrent();
      const oldP = fMatch[1];
      const newP = fMatch[2];
      if (!oldP || !newP) continue;
      current = {
        additions: 0,
        deletions: 0,
        hunks: [],
        metadataLines: [],
        oldPath: oldP !== newP ? oldP : null,
        path: newP,
        status: "modified",
      };
      hunk = null;
      sawFileLevelChange = false;
      continue;
    }

    if (!current) continue;

    // Detect status from metadata lines
    if (line.startsWith("new file")) {
      current.status = "added";
      current.metadataLines?.push(line);
      sawFileLevelChange = true;
    } else if (line.startsWith("deleted file")) {
      current.status = "deleted";
      current.metadataLines?.push(line);
      sawFileLevelChange = true;
    } else if (line.startsWith("rename from")) {
      current.status = "renamed";
      const oldName = line.slice("rename from ".length).trim();
      if (oldName) current.oldPath = oldName;
      current.metadataLines?.push(line);
      sawFileLevelChange = true;
    } else if (line.startsWith("similarity index")) {
      current.metadataLines?.push(line);
      sawFileLevelChange = true;
    } else if (
      line.startsWith("rename to") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ")
    ) {
      current.metadataLines?.push(line);
      sawFileLevelChange = true;
    } else if (line.startsWith("index ")) {
      current.metadataLines?.push(line);
    }
    if (STATUS_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;

    const hMatch = HUNK_HEADER.exec(line);
    if (hMatch) {
      const parseRange = (range: string) => {
        const parts = range.split(",", 2);
        return {
          count: Number(parts.length === 2 ? parts[1] : "1"),
          start: Number(parts[0]),
        };
      };
      const oldRange = parseRange(hMatch[1]);
      const newRange = parseRange(hMatch[2]);
      hunk = {
        countNew: newRange.count,
        countOld: oldRange.count,
        header: line,
        lines: [],
        startNew: newRange.start,
        startOld: oldRange.start,
      };
      current.hunks.push(hunk);
      continue;
    }
    // Skip binary file markers
    if (line.startsWith("Binary files")) {
      current.isBinary = true;
      sawFileLevelChange = true;
      continue;
    }
    if (
      hunk &&
      (line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ") ||
        line.startsWith("\\"))
    ) {
      hunk.lines.push(line);
      if (line.startsWith("+")) current.additions++;
      else if (line.startsWith("-")) current.deletions++;
    }
  }
  flushCurrent();
  return files;
}

// ============================================================================
// Chunking
// ============================================================================
