import { ValidationError } from "../../application/errors.js";
import { type FileDiff, type PlannedCommit } from "./grouping-types.js";

/** Returns true when the candidate fully covers the original group's hunks. */
export function groupCoversGroup(
  candidate: PlannedCommit,
  original: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): boolean {
  const candidateKeys = getCoverageKeySet(candidate, fileByPath);
  const originalKeys = getCoverageKeySet(original, fileByPath);

  for (const key of originalKeys) {
    if (!candidateKeys.has(key)) {
      return false;
    }
  }

  return true;
}

/** Returns true when two groups overlap on file coverage or individual hunks. */
export function groupsShareCoverage(
  left: PlannedCommit,
  right: PlannedCommit,
): boolean {
  const rightFiles = new Map(right.files.map((file) => [file.path, file]));

  for (const leftFile of left.files) {
    const rightFile = rightFiles.get(leftFile.path);
    if (!rightFile) {
      continue;
    }

    if (
      !leftFile.hunks ||
      leftFile.hunks.length === 0 ||
      !rightFile.hunks ||
      rightFile.hunks.length === 0
    ) {
      return true;
    }

    const rightHunks = new Set(rightFile.hunks);
    for (const hunk of leftFile.hunks) {
      if (rightHunks.has(hunk)) {
        return true;
      }
    }
  }

  return false;
}

/** Returns true when two groups touch at least one of the same files. */
export function groupsSharePaths(
  left: PlannedCommit,
  right: PlannedCommit,
): boolean {
  const leftPaths = new Set(left.files.map((file) => file.path));
  return right.files.some((file) => leftPaths.has(file.path));
}

/** Confirms that AI regrouping preserves exact whole-file and hunk coverage. */
export function hasMatchingCoverage(
  before: PlannedCommit[],
  after: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): boolean {
  const beforeSet = new Set(getCoverageKeys(before, fileByPath));
  const afterSet = new Set(getCoverageKeys(after, fileByPath));

  if (beforeSet.size !== afterSet.size) {
    return false;
  }

  for (const key of beforeSet) {
    if (!afterSet.has(key)) {
      return false;
    }
  }

  return true;
}

/** Returns canonical coverage keys for every file and hunk a plan touches. */
function getCoverageKeys(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): string[] {
  const keys: string[] = [];

  for (const group of groups) {
    for (const fileRef of group.files) {
      const file = fileByPath.get(fileRef.path);
      if (!file) {
        throw new ValidationError(
          `Missing file for coverage check: ${fileRef.path}`,
        );
      }

      if (fileRef.hunks && fileRef.hunks.length > 0) {
        keys.push(
          ...fileRef.hunks.map((hunk) => `${fileRef.path}#${String(hunk)}`),
        );
        continue;
      }

      if (file.hunks.length === 0) {
        keys.push(`${fileRef.path}#file`);
        continue;
      }

      for (let index = 0; index < file.hunks.length; index++) {
        keys.push(`${fileRef.path}#${String(index)}`);
      }
    }
  }

  keys.sort();
  return keys;
}

function getCoverageKeySet(
  group: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): Set<string> {
  return new Set(getCoverageKeys([group], fileByPath));
}