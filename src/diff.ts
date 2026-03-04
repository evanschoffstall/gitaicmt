/**
 * Diff parsing and chunking module
 * Parses git diffs into structured data and chunks them for AI analysis
 * All git command execution has been moved to git.ts
 */

import { loadConfig } from "./config.js";

// ============================================================================
// Type Definitions
// ============================================================================

/** A single hunk within a file diff */
export interface DiffHunk {
  header: string; // @@ line
  startOld: number;
  countOld: number;
  startNew: number;
  countNew: number;
  lines: string[]; // raw diff lines (+/-/space)
}

/** One file's diff data */
export interface FileDiff {
  path: string;
  oldPath: string | null; // for renames
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** A logical chunk of related changes ready for AI analysis */
export interface DiffChunk {
  id: number;
  files: string[];
  content: string; // formatted diff text for the prompt
  lineCount: number;
}

/** Quick summary stats */
export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
  chunks: number;
}

// ============================================================================
// Parser
// ============================================================================

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const STATUS_LINE =
  /^(new file|deleted file|similarity index|rename from|rename to|index )/;

/**
 * Parse a raw git diff into structured FileDiff objects
 * Supports modified, added, deleted, and renamed files
 * @param raw - Raw git diff output (unified format)
 * @returns Array of parsed file diffs with hunks and statistics
 */
export function parseDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = raw.split("\n");
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fMatch = FILE_HEADER.exec(line);
    if (fMatch) {
      if (current) files.push(current);
      const oldP = fMatch[1];
      const newP = fMatch[2];
      current = {
        path: newP,
        oldPath: oldP !== newP ? oldP : null,
        status: "modified",
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      hunk = null;
      continue;
    }

    if (!current) continue;

    // Detect status from metadata lines
    if (line.startsWith("new file")) current.status = "added";
    else if (line.startsWith("deleted file")) current.status = "deleted";
    else if (line.startsWith("rename from")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
    }
    if (STATUS_LINE.test(line)) continue;

    const hMatch = HUNK_HEADER.exec(line);
    if (hMatch) {
      hunk = {
        header: line,
        startOld: parseInt(hMatch[1], 10),
        countOld: parseInt(hMatch[2] ?? "1", 10),
        startNew: parseInt(hMatch[3], 10),
        countNew: parseInt(hMatch[4] ?? "1", 10),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    // Skip binary file markers
    if (line.startsWith("Binary files")) {
      continue;
    }
    if (
      hunk &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
    ) {
      hunk.lines.push(line);
      if (line.startsWith("+")) current.additions++;
      else if (line.startsWith("-")) current.deletions++;
    }
  }
  if (current) files.push(current);
  return files;
}

// ============================================================================
// Formatting
// ============================================================================

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

/**
 * Build a full patch string from a FileDiff (for selective hunk staging)
 * Generates a complete patch that can be applied with `git apply`
 * @param file - The file diff containing hunks
 * @param hunks - Optional array of specific hunks to include (defaults to all)
 * @returns Complete patch content in unified diff format with proper headers
 */
export function buildPatch(file: FileDiff, hunks?: DiffHunk[]): string {
  const selectedHunks = hunks ?? file.hunks;
  const lines: string[] = [];
  const oldPath = file.oldPath ?? file.path;

  if (file.status === "added") {
    lines.push(`diff --git a/${file.path} b/${file.path}`);
    lines.push("new file mode 100644");
    lines.push("--- /dev/null");
    lines.push(`+++ b/${file.path}`);
  } else if (file.status === "deleted") {
    lines.push(`diff --git a/${oldPath} b/${oldPath}`);
    lines.push("deleted file mode 100644");
    lines.push(`--- a/${oldPath}`);
    lines.push("+++ /dev/null");
  } else {
    lines.push(`diff --git a/${oldPath} b/${file.path}`);
    lines.push(`--- a/${oldPath}`);
    lines.push(`+++ b/${file.path}`);
  }

  for (const h of selectedHunks) {
    lines.push(h.header);
    lines.push(...h.lines);
  }
  lines.push(""); // trailing newline
  return lines.join("\n");
}

// ============================================================================
// Chunking
// ============================================================================

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
          id: id++,
          files: [file.path],
          content: text,
          lineCount: lc,
        });
      } else if (cfg.analysis.groupByHunk) {
        // Split large files by hunk
        for (const hunk of file.hunks) {
          const hText = [hunk.header, ...hunk.lines].join("\n");
          const hLc = hunk.lines.length + 1;
          chunks.push({
            id: id++,
            files: [file.path],
            content: hText,
            lineCount: hLc,
          });
        }
      } else {
        chunks.push({
          id: id++,
          files: [file.path],
          content: text,
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
          id: id++,
          files: [...bufFiles],
          content: buf.join("\n"),
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
        id: id++,
        files: [...bufFiles],
        content: buf.join("\n"),
        lineCount: bufLines,
      });
    }
  }

  return chunks;
}

// ============================================================================
// Stats
// ============================================================================

/**
 * Calculate summary statistics for a set of files and chunks
 * @param files - Array of file diffs
 * @param chunks - Array of diff chunks
 * @returns Statistics object with counts of files, additions, deletions, and chunks
 */
export function getStats(files: FileDiff[], chunks: DiffChunk[]): DiffStats {
  return {
    filesChanged: files.length,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    chunks: chunks.length,
  };
}
