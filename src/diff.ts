import { execSync } from "node:child_process";
import { loadConfig } from "./config.js";

// Git already respects .gitignore — no custom ignore patterns needed.
// We pull diffs directly from staged/unstaged changes via git commands.

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

// --------------- Git helpers ---------------

export function getStagedDiff(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  return execSync("git diff --cached --unified=3", {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

export function hasStagedChanges(cwd?: string): boolean {
  const dir = cwd ?? process.cwd();
  const out = execSync("git diff --cached --name-only", {
    cwd: dir,
    encoding: "utf-8",
  });
  return out.trim().length > 0;
}

// --------------- Parser ---------------

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const STATUS_LINE =
  /^(new file|deleted file|similarity index|rename from|rename to|index )/;

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

// --------------- Chunking ---------------

function formatFileDiff(f: FileDiff): string {
  const parts: string[] = [`--- ${f.oldPath ?? f.path}`, `+++ ${f.path}`];
  for (const h of f.hunks) {
    parts.push(h.header);
    parts.push(...h.lines);
  }
  return parts.join("\n");
}

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

/** Quick summary stats */
export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
  chunks: number;
}

export function getStats(files: FileDiff[], chunks: DiffChunk[]): DiffStats {
  return {
    filesChanged: files.length,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    chunks: chunks.length,
  };
}

// --------------- Git staging helpers for multi-commit ---------------

/** Unstage everything */
export function resetStaging(cwd?: string): void {
  const dir = cwd ?? process.cwd();
  execSync("git reset HEAD -- . 2>/dev/null || true", {
    cwd: dir,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

/** Stage specific files by path */
export function stageFiles(paths: string[], cwd?: string): void {
  if (paths.length === 0) return;
  const dir = cwd ?? process.cwd();
  // Quote paths to handle spaces
  const quoted = paths.map((p) => `"${p}"`).join(" ");
  execSync(`git add ${quoted}`, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
}

/** Stage all changes (tracked and untracked, respecting .gitignore) */
export function stageAll(cwd?: string): void {
  const dir = cwd ?? process.cwd();
  execSync("git add -A", { cwd: dir, encoding: "utf-8", stdio: "pipe" });
}

/** Get the unstaged working-tree diff for a specific file */
export function getFileWorkingDiff(filePath: string, cwd?: string): string {
  const dir = cwd ?? process.cwd();
  return execSync(`git diff -- "${filePath}"`, {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Stage a specific hunk by applying a patch via `git apply --cached` */
export function stagePatch(patchContent: string, cwd?: string): void {
  const dir = cwd ?? process.cwd();
  execSync("git apply --cached --unidiff-zero -", {
    cwd: dir,
    encoding: "utf-8",
    input: patchContent,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Build a full patch string from a FileDiff (for selective hunk staging) */
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

/** Commit with a message (supports multi-line subject + body via stdin) */
export function commitWithMessage(message: string, cwd?: string): void {
  const dir = cwd ?? process.cwd();
  execSync("git commit -F -", {
    cwd: dir,
    input: message,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

/** Get list of currently staged file paths */
export function getStagedFiles(cwd?: string): string[] {
  const dir = cwd ?? process.cwd();
  const out = execSync("git diff --cached --name-only", {
    cwd: dir,
    encoding: "utf-8",
  });
  return out.trim().split("\n").filter(Boolean);
}

/** Format a FileDiff into displayable diff text */
export { formatFileDiff };
