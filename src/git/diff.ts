/**
 * Diff parsing and chunking module
 * Parses git diffs into structured data and chunks them for AI analysis
 * All git command execution has been moved to git.ts
 */

import { loadConfig } from "../application/config.js";

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

const DEV_NULL_PATH = "/dev/null";
const DIFF_GIT_PREFIX = "diff --git ";
const OLD_FILE_MARKER = "--- ";
const NEW_FILE_MARKER = "+++ ";

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

/** Build unified diff header lines for prompt/display output. */
export function formatDiffHeaderLines(file: FileDiff): string[] {
  const oldHeaderPath =
    file.status === "added" ? DEV_NULL_PATH : (file.oldPath ?? file.path);
  const newHeaderPath =
    file.status === "deleted" ? DEV_NULL_PATH : file.path;

  return [
    `--- ${oldHeaderPath}`,
    `+++ ${newHeaderPath}`,
    ...(file.metadataLines ?? []),
  ];
}

// ============================================================================
// Parser
// ============================================================================

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

  lines.push(
    `diff --git ${formatGitPatchPath(oldPath, "a/")} ${formatGitPatchPath(file.path, "b/")}`,
  );
  lines.push(...metadataLines);

  if (selectedHunks.length > 0) {
    if (file.status === "added") {
      lines.push("--- /dev/null");
      lines.push(`+++ ${formatGitPatchPath(file.path, "b/")}`);
    } else if (file.status === "deleted") {
      lines.push(`--- ${formatGitPatchPath(oldPath, "a/")}`);
      lines.push("+++ /dev/null");
    } else {
      lines.push(`--- ${formatGitPatchPath(oldPath, "a/")}`);
      lines.push(`+++ ${formatGitPatchPath(file.path, "b/")}`);
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
          const hText = formatSelectedFileDiff(file, [hunk]);
          const hLc = hText.split("\n").length;
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
  return formatSelectedFileDiff(f);
}

/**
 * Format a FileDiff or selected hunks into displayable unified diff text.
 * Includes file metadata lines so prompts retain rename-only and mode-change context.
 * @param file - The file diff to format
 * @param hunks - Optional subset of hunks to include
 * @returns Formatted diff text ready for display or prompting
 */
export function formatSelectedFileDiff(
  file: FileDiff,
  hunks?: DiffHunk[],
): string {
  const parts = formatDiffHeaderLines(file);
  for (const hunk of hunks ?? file.hunks) {
    parts.push(hunk.header);
    parts.push(...hunk.lines);
  }
  return parts.join("\n");
}

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

// ============================================================================
// Formatting
// ============================================================================

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

    const parsedHeader = parseFileHeader(line);
    if (parsedHeader) {
      flushCurrent();
      const { newPath: newP, oldPath: oldP } = parsedHeader;
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

    const oldPathLine = parseUnifiedDiffPathLine(line, OLD_FILE_MARKER);
    if (oldPathLine !== null) {
      if (oldPathLine !== DEV_NULL_PATH) {
        current.oldPath = oldPathLine;
      }
      continue;
    }

    const newPathLine = parseUnifiedDiffPathLine(line, NEW_FILE_MARKER);
    if (newPathLine !== null) {
      if (newPathLine !== DEV_NULL_PATH) {
        current.path = newPathLine;
        if (current.oldPath === current.path) {
          current.oldPath = null;
        }
      }
      continue;
    }

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
      const oldName = normalizeDiffPath(line.slice("rename from ".length));
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

/** Decode Git's C-style quoted diff paths, including octal-escaped UTF-8. */
function decodeGitQuotedPath(path: string): string {
  const bytes: number[] = [];
  const content = path.slice(1, -1);

  for (let index = 0; index < content.length; index++) {
    const character = content.at(index);
    if (character === undefined) {
      continue;
    }

    if (character !== "\\") {
      bytes.push(...Buffer.from(character));
      continue;
    }

    const escaped = content.at(index + 1);
    if (escaped === undefined) {
      bytes.push(0x5c);
      continue;
    }

    const escapeByte = getGitQuotedPathEscapeByte(escaped);
    if (escapeByte !== undefined) {
      bytes.push(escapeByte);
      index++;
      continue;
    }

    if (/[0-7]/u.test(escaped)) {
      const octalDigits = (/^[0-7]{1,3}/u.exec(content
        .slice(index + 1, index + 4)))?.[0];
      if (octalDigits) {
        bytes.push(Number.parseInt(octalDigits, 8));
        index += octalDigits.length;
        continue;
      }
    }

    bytes.push(...Buffer.from(escaped));
    index++;
  }

  return Buffer.from(bytes).toString("utf8");
}

/** Encode file paths so generated patches match Git's quoted-path format. */
function encodeGitQuotedPath(path: string): string {
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

function formatGitPatchPath(path: string, prefix: "a/" | "b/"): string {
  return encodeGitQuotedPath(`${prefix}${path}`);
}

function getGitQuotedPathEscapeByte(character: string): number | undefined {
  switch (character) {
    case '"':
    case "\\":
    case "a":
    case "b":
    case "f":
    case "n":
    case "r":
    case "t":
    case "v":
      return GIT_QUOTED_PATH_ESCAPE_BYTES[character];
    default:
      return undefined;
  }
}

function normalizeDiffPath(rawPath: string): string {
  const trimmedPath = rawPath.trim();
  if (
    trimmedPath.length >= 2 &&
    trimmedPath.startsWith('"') &&
    trimmedPath.endsWith('"')
  ) {
    return decodeGitQuotedPath(trimmedPath);
  }

  return trimmedPath;
}

/**
 * Parse a git diff file header, accepting either canonical a/b prefixes or no
 * prefixes when callers provide raw git output.
 */
function parseFileHeader(line: string): null | { newPath: string; oldPath: string } {
  if (!line.startsWith(DIFF_GIT_PREFIX)) {
    return null;
  }

  const pair = splitDiffHeaderPaths(line.slice(DIFF_GIT_PREFIX.length));
  if (!pair) {
    return null;
  }

  const [rawOldPath, rawNewPath] = pair;
  const oldPath = stripCanonicalDiffPrefix(normalizeDiffPath(rawOldPath), "a/");
  const newPath = stripCanonicalDiffPrefix(normalizeDiffPath(rawNewPath), "b/");

  return { newPath, oldPath };
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

  const secondStart = firstToken.nextIndex + separator[0].length;
  const secondToken = readQuotedDiffPathToken(remainder, secondStart);
  if (!secondToken) {
    return null;
  }

  if (remainder.slice(secondToken.nextIndex).trim().length > 0) {
    return null;
  }

  return [firstToken.token, secondToken.token];
}

function parseUnifiedDiffPathLine(line: string, marker: string): null | string {
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

  if (marker === OLD_FILE_MARKER) {
    return stripCanonicalDiffPrefix(path, "a/");
  }

  if (marker === NEW_FILE_MARKER) {
    return stripCanonicalDiffPrefix(path, "b/");
  }

  return path;
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
      return {
        nextIndex: index + 1,
        token: text.slice(startIndex, index + 1),
      };
    }

    isEscaped = !isEscaped && character === "\\";
    index++;
  }

  return null;
}

function splitDiffHeaderPaths(remainder: string): [string, string] | null {
  const quotedPair = parseQuotedDiffHeaderPaths(remainder);
  if (quotedPair) {
    return quotedPair;
  }

  const prefixedPair = splitPrefixedDiffHeaderPaths(remainder);
  if (prefixedPair) {
    return prefixedPair;
  }

  const separatorIndex = remainder.indexOf(" ");
  if (separatorIndex === -1) {
    return null;
  }

  return [
    remainder.slice(0, separatorIndex),
    remainder.slice(separatorIndex + 1),
  ];
}

function splitPrefixedDiffHeaderPaths(remainder: string): [string, string] | null {
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

function stripCanonicalDiffPrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// ============================================================================
// Chunking
// ============================================================================
