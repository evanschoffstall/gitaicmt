import { formatScalar } from "./ai-format.js";
import { type PlannedCommit, type PlannedCommitFile } from "./ai-types.js";
import { MAX_COMMIT_GROUPS, MAX_COMMIT_MESSAGE_LENGTH } from "./constants.js";
import { ValidationError } from "./errors.js";

type FileDiff = import("./diff.js").FileDiff;

export function validateAndNormalizeGrouping(
  raw: unknown,
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError(
      `AI grouping response is not an array. Got: ${typeof raw}`,
    );
  }
  if (raw.length === 0) {
    throw new ValidationError("AI returned empty commit group array");
  }
  if (raw.length > MAX_COMMIT_GROUPS) {
    throw new ValidationError(
      `AI returned suspiciously large number of groups (${formatScalar(raw.length)}), likely malformed`,
    );
  }

  const rawGroups = raw as unknown[];
  const groups: PlannedCommit[] = [];

  for (let i = 0; i < rawGroups.length; i++) {
    const candidate = rawGroups[i];
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new ValidationError(
        `Commit group ${formatScalar(i)} is not a valid object. Got: ${typeof candidate}`,
      );
    }

    const group = candidate as { files?: unknown; message?: unknown };
    if (!Array.isArray(group.files)) {
      throw new ValidationError(
        `Commit group ${formatScalar(i)} has invalid 'files' field. Expected array, got: ${typeof group.files}`,
      );
    }
    if (group.files.length === 0) {
      throw new ValidationError(
        `Commit group ${formatScalar(i)} has empty 'files' array`,
      );
    }
    if (group.files.length > 100) {
      throw new ValidationError(
        `Commit group ${formatScalar(i)} has suspiciously many files (${formatScalar(group.files.length)})`,
      );
    }

    if (typeof group.message !== "string") {
      throw new ValidationError(
        `Commit group ${formatScalar(i)} has invalid 'message' field. Expected string, got: ${typeof group.message}`,
      );
    }
    if (group.message.trim().length === 0) {
      throw new ValidationError(
        `Commit group ${formatScalar(i)} has empty 'message' field`,
      );
    }
    if (group.message.length > MAX_COMMIT_MESSAGE_LENGTH) {
      throw new ValidationError(
        `Commit group ${formatScalar(i)} message exceeds maximum length (${formatScalar(group.message.length)} chars)`,
      );
    }

    const normalizedFiles: PlannedCommitFile[] = [];
    for (const fileEntry of group.files) {
      if (!isValidFileEntry(fileEntry, fileByPath)) {
        continue;
      }

      if (typeof fileEntry === "string") {
        normalizedFiles.push({ path: fileEntry });
        continue;
      }

      const entry = fileEntry as { hunks?: number[]; path: string };
      const file = fileByPath.get(entry.path);
      if (!file) {
        continue;
      }

      if (entry.hunks && entry.hunks.length > 0) {
        const validHunks = entry.hunks.filter(
          (hunk) => hunk >= 0 && hunk < file.hunks.length,
        );
        normalizedFiles.push(
          validHunks.length > 0
            ? { hunks: validHunks, path: entry.path }
            : { path: entry.path },
        );
        continue;
      }

      normalizedFiles.push({ path: entry.path });
    }

    if (normalizedFiles.length === 0) {
      throw new ValidationError(
        `Commit group ${formatScalar(i)} has no valid file entries after normalization`,
      );
    }

    groups.push({ files: normalizedFiles, message: group.message });
  }

  if (groups.length === 0) {
    throw new ValidationError("No valid commit groups after normalization");
  }

  return groups;
}

function isValidFileEntry(
  fileEntry: unknown,
  fileByPath: Map<string, FileDiff>,
): fileEntry is PlannedCommitFile {
  if (typeof fileEntry === "string") {
    return fileByPath.has(fileEntry);
  }
  if (!fileEntry || typeof fileEntry !== "object") {
    return false;
  }

  const entry = fileEntry as { hunks?: unknown; path?: unknown };
  if (typeof entry.path !== "string" || !fileByPath.has(entry.path)) {
    return false;
  }
  if (entry.hunks === undefined) {
    return true;
  }
  if (!Array.isArray(entry.hunks)) {
    return false;
  }

  const file = fileByPath.get(entry.path);
  if (!file) {
    return false;
  }
  return entry.hunks.every(
    (hunk) => typeof hunk === "number" && hunk >= 0 && hunk < file.hunks.length,
  );
}
