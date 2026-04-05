import type { PlannedCommitFile } from "./types.js";

import { ValidationError } from "../application/errors.js";
import { formatScalar } from "../commit-messages/formatting.js";
import { type FilePathResolver, resolveKnownPath } from "./path-resolver.js";

type FileDiff = import("../git/diff.js").FileDiff;

export function normalizeFileEntry(
  fileEntry: unknown,
  fileByPath: Map<string, FileDiff>,
  pathResolver: FilePathResolver,
  groupIndex: number,
  fileIndex: number,
): PlannedCommitFile {
  if (typeof fileEntry === "string") {
    return {
      path: resolveRequiredPath(fileEntry, pathResolver, groupIndex, fileIndex),
    };
  }

  const entry = validateFileEntryObject(fileEntry, groupIndex, fileIndex);

  const resolvedPath = resolveRequiredPath(
    entry.path,
    pathResolver,
    groupIndex,
    fileIndex,
  );
  const file = fileByPath.get(resolvedPath);
  if (!file) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} file entry ${formatScalar(fileIndex)} references unknown path ${JSON.stringify(entry.path)}`,
    );
  }

  return normalizeEntryHunks(entry, file, resolvedPath, groupIndex, fileIndex);
}

function isValidHunkIndex(hunk: unknown, file: FileDiff): hunk is number {
  return (
    typeof hunk === "number" &&
    Number.isInteger(hunk) &&
    hunk >= 0 &&
    hunk < file.hunks.length
  );
}

function isWholeFileHunkSelector(hunks: unknown): boolean {
  return typeof hunks === "string" && hunks.trim().toLowerCase() === "all";
}

function normalizeEntryHunks(
  entry: { hunks?: unknown; path: string },
  file: FileDiff,
  resolvedPath: string,
  groupIndex: number,
  fileIndex: number,
): PlannedCommitFile {
  if (entry.hunks === undefined || isWholeFileHunkSelector(entry.hunks)) {
    return { path: resolvedPath };
  }
  if (!Array.isArray(entry.hunks)) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} file entry ${formatScalar(fileIndex)} has invalid hunks field`,
    );
  }
  if (!entry.hunks.every((hunk) => isValidHunkIndex(hunk, file))) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} file entry ${formatScalar(fileIndex)} has invalid hunk indices for ${JSON.stringify(entry.path)}`,
    );
  }
  if (entry.hunks.length === 0) {
    return { path: resolvedPath };
  }

  return {
    hunks: [...new Set(entry.hunks)].sort((left, right) => left - right),
    path: resolvedPath,
  };
}

function resolveRequiredPath(
  rawPath: string,
  pathResolver: FilePathResolver,
  groupIndex: number,
  fileIndex: number,
): string {
  const resolvedPath = resolveKnownPath(rawPath, pathResolver);
  if (resolvedPath) {
    return resolvedPath;
  }

  throw new ValidationError(
    `Commit group ${formatScalar(groupIndex)} file entry ${formatScalar(fileIndex)} references unknown path ${JSON.stringify(rawPath)}`,
  );
}

function validateFileEntryObject(
  fileEntry: unknown,
  groupIndex: number,
  fileIndex: number,
): { hunks?: unknown; path: string } {
  if (!fileEntry || typeof fileEntry !== "object") {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} file entry ${formatScalar(fileIndex)} is not a valid object`,
    );
  }

  const entry = fileEntry as { hunks?: unknown; path?: unknown };
  if (typeof entry.path !== "string") {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} file entry ${formatScalar(fileIndex)} has invalid path type ${JSON.stringify(typeof entry.path)}`,
    );
  }

  return { hunks: entry.hunks, path: entry.path };
}