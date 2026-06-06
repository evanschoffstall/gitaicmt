import { createHash } from "node:crypto";

import { ValidationError } from "../../application/errors.js";
import { type FileDiff, parseDiff } from "../../git/index.js";

export interface HashMismatchDiagnostic {
  actual: string;
  expected: string;
  kind: "bundle" | "file" | "hunk";
  path?: string;
  reason: string;
}

export interface PersistedBundleContentHashes {
  bundleHash: string;
  files: PersistedBundleFileHashes[];
}

export interface PersistedBundleFileHashes {
  fileHash: string;
  hunkHashes: string[];
  path: string;
}

/**
 * Persisted validation data for one planned commit file selection.
 */
export interface PersistedPlanCommitFileHashes {
  fileHash: string;
  hunkHashes: string[];
  hunkIndexes: number[];
  path: string;
  wholeFile: boolean;
}

/**
 * Persisted validation data for one planned commit.
 */
export interface PersistedPlanCommitHashes {
  files: PersistedPlanCommitFileHashes[];
  hash: string;
}

type PlannedCommit = import("../types.js").PlannedCommit;

export function buildBundleContentHashes(
  stagedPatch: string,
): PersistedBundleContentHashes {
  const files = parseDiff(normalizePatchContent(stagedPatch))
    .map((file) => buildPersistedFileHashes(file))
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    bundleHash: hashContent(canonicalStringify(files)),
    files,
  };
}

/**
 * Build commit-scoped validation hashes from the saved plan and content hashes.
 */
export function buildPlanCommitHashes(
  plan: PlannedCommit[],
  contentHashes: PersistedBundleContentHashes,
): PersistedPlanCommitHashes[] {
  const fileHashesByPath = new Map(
    contentHashes.files.map((fileHashes) => [fileHashes.path, fileHashes]),
  );

  return plan.map((plannedCommit, commitIndex) => {
    const files = plannedCommit.files.map((fileRef) => {
      const expectedFile = fileHashesByPath.get(fileRef.path);
      if (!expectedFile) {
        throw new ValidationError(
          `Planned commit ${String(commitIndex + 1)} references a file that is not present in the saved staged patch: ${fileRef.path}`,
        );
      }

      const hunkIndexes = resolveCommitHunkIndexes(
        fileRef.hunks,
        expectedFile.hunkHashes.length,
        fileRef.path,
      );

      return {
        fileHash: expectedFile.fileHash,
        hunkHashes: hunkIndexes.map(
          (hunkIndex) => expectedFile.hunkHashes[hunkIndex],
        ),
        hunkIndexes,
        path: fileRef.path,
        wholeFile: !fileRef.hunks || fileRef.hunks.length === 0,
      };
    });

    return {
      files,
      hash: hashContent(
        canonicalStringify({
          files,
          message: plannedCommit.message,
        }),
      ),
    };
  });
}

export function formatHashMismatchDiagnostic(
  diagnostic: HashMismatchDiagnostic,
): string {
  const pathSuffix = diagnostic.path ? ` (${diagnostic.path})` : "";
  return `${diagnostic.kind} mismatch${pathSuffix}: ${diagnostic.reason}; expected=${diagnostic.expected}, actual=${diagnostic.actual}`;
}

export function getBundleHashMismatch(
  expected: PersistedBundleContentHashes,
  actual: PersistedBundleContentHashes,
): HashMismatchDiagnostic | null {
  const bundleMismatch = getBundleLevelMismatch(expected, actual);
  if (bundleMismatch) {
    return bundleMismatch;
  }

  for (let index = 0; index < expected.files.length; index++) {
    const expectedFile = expected.files[index];
    const actualFile = actual.files.at(index);
    if (actualFile === undefined) {
      return {
        actual: String(actual.files.length),
        expected: String(expected.files.length),
        kind: "bundle",
        reason: "file count differs",
      };
    }

    const fileMismatch = getFileHashMismatch(expectedFile, actualFile);
    if (fileMismatch) {
      return fileMismatch;
    }
  }

  return null;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function normalizePatchContent(patchContent: string): string {
  return patchContent.replace(/\r\n?/gu, "\n");
}

function buildPersistedFileHashes(file: FileDiff): PersistedBundleFileHashes {
  const hunkHashesFromHunks = file.hunks.map((hunk) =>
    hashContent(
      canonicalStringify({
        countNew: hunk.countNew,
        countOld: hunk.countOld,
        header: hunk.header,
        lines: hunk.lines,
        startNew: hunk.startNew,
        startOld: hunk.startOld,
      }),
    ),
  );
  const hunkHashes =
    hunkHashesFromHunks.length > 0
      ? hunkHashesFromHunks
      : [
          hashContent(
            canonicalStringify({
              isBinary: file.isBinary === true,
              metadataLines: file.metadataLines ?? [],
              oldPath: file.oldPath ?? null,
              path: file.path,
              status: file.status,
            }),
          ),
        ];

  return {
    fileHash: hashContent(
      canonicalStringify({
        hunkHashes,
        isBinary: file.isBinary === true,
        metadataLines: file.metadataLines ?? [],
        oldPath: file.oldPath ?? null,
        path: file.path,
        status: file.status,
      }),
    ),
    hunkHashes,
    path: file.path,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    const canonicalRecord: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      canonicalRecord[key] = canonicalize(entry);
    }
    return canonicalRecord;
  }

  return value;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function compareHashLists(
  expectedHashes: string[],
  actualHashes: string[],
): null | {
  actual: string;
  expected: string;
  reason: string;
} {
  if (expectedHashes.length !== actualHashes.length) {
    return {
      actual: String(actualHashes.length),
      expected: String(expectedHashes.length),
      reason: "count differs",
    };
  }

  for (let index = 0; index < expectedHashes.length; index++) {
    const expectedHash = expectedHashes[index];
    const actualHash = actualHashes[index];
    if (expectedHash !== actualHash) {
      return {
        actual: actualHash,
        expected: expectedHash,
        reason: `index ${String(index)} differs`,
      };
    }
  }

  return null;
}

function getBundleLevelMismatch(
  expected: PersistedBundleContentHashes,
  actual: PersistedBundleContentHashes,
): HashMismatchDiagnostic | null {
  if (expected.bundleHash !== actual.bundleHash) {
    return {
      actual: actual.bundleHash,
      expected: expected.bundleHash,
      kind: "bundle",
      reason: "bundle hash differs",
    };
  }

  if (expected.files.length !== actual.files.length) {
    return {
      actual: String(actual.files.length),
      expected: String(expected.files.length),
      kind: "bundle",
      reason: "file count differs",
    };
  }

  return null;
}

function getFileHashMismatch(
  expectedFile: PersistedBundleFileHashes,
  actualFile: PersistedBundleFileHashes,
): HashMismatchDiagnostic | null {
  if (expectedFile.path !== actualFile.path) {
    return {
      actual: actualFile.path,
      expected: expectedFile.path,
      kind: "file",
      path: expectedFile.path,
      reason: "file path differs",
    };
  }

  if (expectedFile.fileHash !== actualFile.fileHash) {
    return {
      actual: actualFile.fileHash,
      expected: expectedFile.fileHash,
      kind: "file",
      path: expectedFile.path,
      reason: "file hash differs",
    };
  }

  const hunkMismatch = compareHashLists(
    expectedFile.hunkHashes,
    actualFile.hunkHashes,
  );
  if (hunkMismatch) {
    return {
      actual: hunkMismatch.actual,
      expected: hunkMismatch.expected,
      kind: "hunk",
      path: expectedFile.path,
      reason: hunkMismatch.reason,
    };
  }

  return null;
}

function resolveCommitHunkIndexes(
  requestedHunks: number[] | undefined,
  availableHunkCount: number,
  filePath: string,
): number[] {
  if (!requestedHunks || requestedHunks.length === 0) {
    return [];
  }

  const resolvedIndexes: number[] = [];
  for (const hunkIndex of requestedHunks) {
    if (!Number.isInteger(hunkIndex)) {
      throw new ValidationError(
        `Planned commit references a non-integer hunk index ${String(hunkIndex)} for ${filePath}.`,
      );
    }
    if (hunkIndex < 0 || hunkIndex >= availableHunkCount) {
      throw new ValidationError(
        `Planned commit references an out-of-bounds hunk index ${String(hunkIndex)} for ${filePath}.`,
      );
    }
    if (!resolvedIndexes.includes(hunkIndex)) {
      resolvedIndexes.push(hunkIndex);
    }
  }

  return resolvedIndexes;
}
