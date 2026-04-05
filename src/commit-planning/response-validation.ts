import { MAX_COMMIT_GROUPS, MAX_COMMIT_MESSAGE_LENGTH } from "../application/constants.js";
import { ValidationError } from "../application/errors.js";
import { formatScalar, validateCommitMessage } from "../commit-messages/formatting.js";
import { normalizeFileEntry } from "./entry-normalization.js";
import { buildFilePathResolver } from "./path-resolver.js";
import { type PlannedCommit, type PlannedCommitFile } from "./types.js";

type FileDiff = import("../git/diff.js").FileDiff;

export function validateAndNormalizeGrouping(
  raw: unknown,
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const pathResolver = buildFilePathResolver(fileByPath);
  const rawGroups = validateRawGroupingArray(raw);

  const groups: PlannedCommit[] = [];

  for (let groupIndex = 0; groupIndex < rawGroups.length; groupIndex++) {
    groups.push(
      normalizeCommitGroup(
        rawGroups[groupIndex],
        fileByPath,
        pathResolver,
        groupIndex,
      ),
    );
  }

  if (groups.length === 0) {
    throw new ValidationError("No valid commit groups after normalization");
  }

  return groups;
}

/**
 * Allow some duplication in raw AI output while still rejecting obviously
 * malformed groups that explode far past the available file set.
 */
function getMaximumRawFileEntries(availableFileCount: number): number {
  return Math.max(availableFileCount * 4, availableFileCount + 32);
}

/**
 * Collapse duplicate file entries inside a single AI-produced commit group.
 */
function mergeDuplicateFileEntries(
  files: PlannedCommitFile[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommitFile[] {
  const mergedByPath = new Map<string, null | Set<number>>();
  const orderedPaths: string[] = [];

  for (const file of files) {
    if (!mergedByPath.has(file.path)) {
      orderedPaths.push(file.path);
      mergedByPath.set(
        file.path,
        file.hunks && file.hunks.length > 0 ? new Set(file.hunks) : null,
      );
      continue;
    }

    const existing = mergedByPath.get(file.path);
    if (existing === null || !file.hunks || file.hunks.length === 0) {
      mergedByPath.set(file.path, null);
      continue;
    }
    if (existing === undefined) {
      continue;
    }

    for (const hunk of file.hunks) {
      existing.add(hunk);
    }
  }

  return orderedPaths.map((path) => {
    const merged = mergedByPath.get(path);
    const file = fileByPath.get(path);

    if (
      !file ||
      file.hunks.length === 0 ||
      merged === null ||
      merged === undefined
    ) {
      return { path };
    }

    return {
      hunks: [...merged].sort((left, right) => left - right),
      path,
    };
  });
}

function normalizeCommitGroup(
  candidate: unknown,
  fileByPath: Map<string, FileDiff>,
  pathResolver: ReturnType<typeof buildFilePathResolver>,
  groupIndex: number,
): PlannedCommit {
  const group = validateRawGroupShape(candidate, fileByPath.size, groupIndex);
  const normalizedFiles = group.files.map((fileEntry, fileIndex) =>
    normalizeFileEntry(
      fileEntry,
      fileByPath,
      pathResolver,
      groupIndex,
      fileIndex,
    ),
  );
  const mergedFiles = mergeDuplicateFileEntries(normalizedFiles, fileByPath);
  if (mergedFiles.length === 0) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} has no valid file entries after normalization`,
    );
  }

  return {
    files: mergedFiles,
    message: validateCommitMessage(group.message),
  };
}

function validateRawGroupFiles(
  files: unknown,
  availableFileCount: number,
  groupIndex: number,
): unknown[] {
  if (!Array.isArray(files)) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} has invalid 'files' field. Expected array, got: ${typeof files}`,
    );
  }
  if (files.length === 0) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} has empty 'files' array`,
    );
  }

  const maximumRawFileEntries = getMaximumRawFileEntries(availableFileCount);
  if (files.length > maximumRawFileEntries) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} has suspiciously many file entries (${formatScalar(files.length)} > ${formatScalar(maximumRawFileEntries)})`,
    );
  }

  return files;
}

function validateRawGroupingArray(raw: unknown): unknown[] {
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

  return raw;
}

function validateRawGroupMessage(
  message: unknown,
  groupIndex: number,
): string {
  if (typeof message !== "string") {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} has invalid 'message' field. Expected string, got: ${typeof message}`,
    );
  }
  if (message.trim().length === 0) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} has empty 'message' field`,
    );
  }
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} message exceeds maximum length (${formatScalar(message.length)} chars)`,
    );
  }

  return message;
}

function validateRawGroupShape(
  candidate: unknown,
  availableFileCount: number,
  groupIndex: number,
): { files: unknown[]; message: string } {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} is not a valid object. Got: ${typeof candidate}`,
    );
  }

  const group = candidate as { files?: unknown; message?: unknown };
  const files = validateRawGroupFiles(group.files, availableFileCount, groupIndex);
  const message = validateRawGroupMessage(group.message, groupIndex);
  return { files, message };
}
