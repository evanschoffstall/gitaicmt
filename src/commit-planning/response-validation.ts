import { posix as pathPosix } from "node:path";

import { MAX_COMMIT_GROUPS, MAX_COMMIT_MESSAGE_LENGTH } from "../application/constants.js";
import { ValidationError } from "../application/errors.js";
import { formatScalar, validateCommitMessage } from "../commit-messages/formatting.js";
import { type PlannedCommit, type PlannedCommitFile } from "./types.js";

type FileDiff = import("../git/diff.js").FileDiff;

interface FilePathResolver {
  exactPaths: Map<string, string>;
  uniquePathsByStem: Map<string, string>;
}

export function validateAndNormalizeGrouping(
  raw: unknown,
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const pathResolver = buildFilePathResolver(fileByPath);

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
    const maximumRawFileEntries = getMaximumRawFileEntries(fileByPath.size);
    if (group.files.length > maximumRawFileEntries) {
      throw new ValidationError(
        `Commit group ${formatScalar(i)} has suspiciously many file entries (${formatScalar(group.files.length)} > ${formatScalar(maximumRawFileEntries)})`,
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
    for (let fileIndex = 0; fileIndex < group.files.length; fileIndex++) {
      normalizedFiles.push(
        normalizeFileEntry(
          group.files[fileIndex],
          fileByPath,
          pathResolver,
          i,
          fileIndex,
        ),
      );
    }

    const mergedFiles = mergeDuplicateFileEntries(normalizedFiles, fileByPath);

    if (mergedFiles.length === 0) {
      throw new ValidationError(
        `Commit group ${formatScalar(i)} has no valid file entries after normalization`,
      );
    }

    groups.push({
      files: mergedFiles,
      message: validateCommitMessage(group.message),
    });
  }

  if (groups.length === 0) {
    throw new ValidationError("No valid commit groups after normalization");
  }

  return groups;
}

function buildFilePathResolver(
  fileByPath: Map<string, FileDiff>,
): FilePathResolver {
  const exactPaths = new Map<string, string>();
  const files = [...fileByPath.values()];
  const canonicalByStem = new Map<string, string>();
  const ambiguousStems = new Set<string>();

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const canonicalPath = file.path;
    const alias = `F${String(index + 1)}`;

    exactPaths.set(canonicalPath, canonicalPath);
    exactPaths.set(alias, canonicalPath);
    exactPaths.set(`${alias}: ${canonicalPath}`, canonicalPath);

    if (file.oldPath && !exactPaths.has(file.oldPath)) {
      exactPaths.set(file.oldPath, canonicalPath);
      exactPaths.set(`${alias}: ${file.oldPath}`, canonicalPath);
    }

    registerStemCandidate(canonicalByStem, ambiguousStems, canonicalPath);
    if (file.oldPath) {
      registerStemCandidate(canonicalByStem, ambiguousStems, file.oldPath);
    }
  }

  return {
    exactPaths,
    uniquePathsByStem: new Map(
      [...canonicalByStem].filter(([stem]) => !ambiguousStems.has(stem)),
    ),
  };
}

/**
 * Return the repository path without its trailing filename extension, when one
 * exists. This stays generic across any file type instead of enumerating them.
 */
function getExtensionlessStem(path: string): null | string {
  const extension = pathPosix.extname(path);
  if (extension.length === 0) {
    return null;
  }

  return path.slice(0, -extension.length);
}

/**
 * Allow some duplication in raw AI output while still rejecting obviously
 * malformed groups that explode far past the available file set.
 */
function getMaximumRawFileEntries(availableFileCount: number): number {
  return Math.max(availableFileCount * 4, availableFileCount + 32);
}

/**
 * Accept only integer hunk indices inside the known range for a file.
 */
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

function normalizeFileEntry(
  fileEntry: unknown,
  fileByPath: Map<string, FileDiff>,
  pathResolver: FilePathResolver,
  groupIndex: number,
  fileIndex: number,
): PlannedCommitFile {
  if (typeof fileEntry === "string") {
    const resolvedPath = resolveKnownPath(fileEntry, pathResolver);
    if (!resolvedPath) {
      throw new ValidationError(
        `Commit group ${formatScalar(groupIndex)} file entry ${formatScalar(fileIndex)} references unknown path ${JSON.stringify(fileEntry)}`,
      );
    }
    return { path: resolvedPath };
  }
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
  const resolvedPath = resolveKnownPath(entry.path, pathResolver);
  if (!resolvedPath) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} file entry ${formatScalar(fileIndex)} references unknown path ${JSON.stringify(entry.path)}`,
    );
  }
  const file = fileByPath.get(resolvedPath);
  if (!file) {
    throw new ValidationError(
      `Commit group ${formatScalar(groupIndex)} file entry ${formatScalar(fileIndex)} references unknown path ${JSON.stringify(entry.path)}`,
    );
  }
  if (entry.hunks === undefined) {
    return { path: resolvedPath };
  }
  if (isWholeFileHunkSelector(entry.hunks)) {
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

function registerStemCandidate(
  canonicalByStem: Map<string, string>,
  ambiguousStems: Set<string>,
  path: string,
): void {
  const stem = getExtensionlessStem(path);
  if (!stem || ambiguousStems.has(stem)) {
    return;
  }

  const existingCanonicalPath = canonicalByStem.get(stem);
  if (existingCanonicalPath && existingCanonicalPath !== path) {
    canonicalByStem.delete(stem);
    ambiguousStems.add(stem);
    return;
  }

  canonicalByStem.set(stem, path);
}

function resolveKnownPath(
  rawPath: string,
  pathResolver: FilePathResolver,
): null | string {
  const trimmedPath = rawPath.trim();
  if (trimmedPath.length === 0) {
    return null;
  }

  const direct = pathResolver.exactPaths.get(trimmedPath);
  if (direct) {
    return direct;
  }

  const aliasPrefixedPath = /^F\d+:\s+/u.exec(trimmedPath);
  if (aliasPrefixedPath) {
    return (
      resolveStemMatchedPath(
        trimmedPath.slice(aliasPrefixedPath[0].length),
        pathResolver,
      ) ?? null
    );
  }

  return resolveStemMatchedPath(trimmedPath, pathResolver);
}

/**
 * Resolve extension drift only when one repository path owns the stem. This
 * avoids guessing between sibling files such as component `.ts` and `.tsx`
 * variants that share the same base name.
 */
function resolveStemMatchedPath(
  candidatePath: string,
  pathResolver: FilePathResolver,
): null | string {
  const stem = getExtensionlessStem(candidatePath);
  if (!stem) {
    return null;
  }

  return pathResolver.uniquePathsByStem.get(stem) ?? null;
}
