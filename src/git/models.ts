/** A logical chunk of related changes ready for AI analysis. */
export interface DiffChunk {
  content: string;
  files: string[];
  id: number;
  lineCount: number;
}

/** One diff hunk in a unified diff. */
export interface DiffHunk {
  countNew: number;
  countOld: number;
  header: string;
  lines: string[];
  startNew: number;
  startOld: number;
}

/** Aggregate diff stats used by prompt builders. */
export interface DiffStats {
  additions: number;
  chunks: number;
  deletions: number;
  filesChanged: number;
}

/** One parsed file diff. */
export interface FileDiff {
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  isBinary?: boolean;
  metadataLines?: string[];
  oldPath?: null | string;
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
}