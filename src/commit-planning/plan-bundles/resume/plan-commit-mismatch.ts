import type {
  HashMismatchDiagnostic,
  PersistedBundleContentHashes,
  PersistedBundleFileHashes,
  PersistedPlanCommitFileHashes,
  PersistedPlanCommitHashes,
} from "../hashes.js";

/**
 * Compare one persisted planned commit against the current staged content
 * hashes and return the first mismatch, if any.
 */
export function getPlanCommitHashMismatch(
  expected: PersistedPlanCommitHashes,
  actual: PersistedBundleContentHashes,
): HashMismatchDiagnostic | null {
  const actualFilesByPath = new Map(
    actual.files.map((fileHashes) => [fileHashes.path, fileHashes]),
  );

  for (const expectedFile of expected.files) {
    const actualFile = actualFilesByPath.get(expectedFile.path);
    const missingFileMismatch = getMissingPlanCommitFileMismatch(
      expectedFile,
      actualFile,
    );
    if (missingFileMismatch) {
      return missingFileMismatch;
    }

    if (!actualFile) {
      continue;
    }

    const wholeFileMismatch = getWholeFilePlanCommitMismatch(
      expectedFile,
      actualFile,
    );
    if (wholeFileMismatch) {
      return wholeFileMismatch;
    }

    const hunkMismatch = getSelectedHunkPlanCommitMismatch(
      expectedFile,
      actualFile,
    );
    if (hunkMismatch) {
      return hunkMismatch;
    }
  }

  return null;
}

function getMissingPlanCommitFileMismatch(
  expectedFile: PersistedPlanCommitFileHashes,
  actualFile: PersistedBundleFileHashes | undefined,
): HashMismatchDiagnostic | null {
  if (actualFile) {
    return null;
  }

  return {
    actual: "<missing>",
    expected: expectedFile.path,
    kind: "file",
    path: expectedFile.path,
    reason: "file missing from current staged patch",
  };
}

function getSelectedHunkPlanCommitMismatch(
  expectedFile: PersistedPlanCommitFileHashes,
  actualFile: PersistedBundleFileHashes,
): HashMismatchDiagnostic | null {
  if (expectedFile.wholeFile) {
    return null;
  }

  for (let index = 0; index < expectedFile.hunkIndexes.length; index++) {
    const expectedHunkIndex = expectedFile.hunkIndexes.at(index);
    const expectedHunkHash = expectedFile.hunkHashes.at(index);
    if (expectedHunkIndex === undefined || expectedHunkHash === undefined) {
      return {
        actual: "<missing>",
        expected: "<missing>",
        kind: "hunk",
        path: expectedFile.path,
        reason: `hunk index ${String(index)} missing from saved commit metadata`,
      };
    }

    const actualHunkHash = actualFile.hunkHashes.at(expectedHunkIndex);
    if (actualHunkHash === undefined) {
      return {
        actual: "<missing>",
        expected: expectedHunkHash,
        kind: "hunk",
        path: expectedFile.path,
        reason: `hunk index ${String(expectedHunkIndex)} missing`,
      };
    }
    if (actualHunkHash !== expectedHunkHash) {
      return {
        actual: actualHunkHash,
        expected: expectedHunkHash,
        kind: "hunk",
        path: expectedFile.path,
        reason: `hunk index ${String(expectedHunkIndex)} differs`,
      };
    }
  }

  return null;
}

function getWholeFilePlanCommitMismatch(
  expectedFile: PersistedPlanCommitFileHashes,
  actualFile: PersistedBundleFileHashes,
): HashMismatchDiagnostic | null {
  if (
    !expectedFile.wholeFile ||
    actualFile.fileHash === expectedFile.fileHash
  ) {
    return null;
  }

  return {
    actual: actualFile.fileHash,
    expected: expectedFile.fileHash,
    kind: "file",
    path: expectedFile.path,
    reason: "file hash differs",
  };
}
