export interface PlannedCommit {
  files: PlannedCommitFile[];
  message: string;
}

export interface PlannedCommitFile {
  hunks?: number[];
  path: string;
}
