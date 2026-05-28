import type { PlannedCommit, PlannedCommitFile } from "./orchestration.js";

/**
 * Detect whether two planned commit file references for the same path overlap.
 *
 * Overlap means they would try to stage conflicting content:
 * - either file reference targets the whole file
 * - both target hunks and at least one hunk index is shared
 */
export function plannedCommitFilesOverlap(
  left: PlannedCommitFile,
  right: PlannedCommitFile,
): boolean {
  if (!left.hunks || left.hunks.length === 0) {
    return true;
  }
  if (!right.hunks || right.hunks.length === 0) {
    return true;
  }

  const leftHunkIndexes = new Set(left.hunks);
  return right.hunks.some((hunkIndex) => leftHunkIndexes.has(hunkIndex));
}

/**
 * Resolve overlapping planned commits without disturbing non-conflicting files.
 *
 * Each incoming file reference is compared against already accepted commits.
 * Only the conflicting file reference is trimmed or dropped. Unrelated files in
 * the same incoming commit remain eligible for their own commit.
 */
export function resolveOverlappingCommits(
  groups: PlannedCommit[],
): PlannedCommit[] {
  const acceptedFileRefs: Map<string, PlannedCommitFile>[] = [];
  const resolvedGroups: PlannedCommit[] = [];

  for (const group of groups) {
    const survivingFiles = collectSurvivingFiles(
      group,
      resolvedGroups,
      acceptedFileRefs,
    );

    if (survivingFiles.length === 0) {
      continue;
    }

    addResolvedGroup(
      group.message,
      survivingFiles,
      resolvedGroups,
      acceptedFileRefs,
    );
  }

  return resolvedGroups;
}

function addResolvedGroup(
  message: string,
  survivingFiles: PlannedCommitFile[],
  resolvedGroups: PlannedCommit[],
  acceptedFileRefs: Map<string, PlannedCommitFile>[],
): void {
  resolvedGroups.push({ files: survivingFiles, message });
  acceptedFileRefs.push(buildAcceptedFileRefMap(survivingFiles));
}

function applyExistingPromotion(
  path: string,
  groupIndex: number,
  existingPromotion: PlannedCommitFile,
  resolvedGroups: PlannedCommit[],
  acceptedFileRefs: Map<string, PlannedCommitFile>[],
): void {
  const resolvedGroup = resolvedGroups[groupIndex];
  const acceptedFileIndex = resolvedGroup.files.findIndex(
    (candidate) => candidate.path === path,
  );
  if (acceptedFileIndex < 0) {
    return;
  }

  resolvedGroup.files[acceptedFileIndex] = existingPromotion;
  acceptedFileRefs[groupIndex]?.set(path, existingPromotion);
}

function buildAcceptedFileRefMap(
  survivingFiles: PlannedCommitFile[],
): Map<string, PlannedCommitFile> {
  return new Map(
    survivingFiles.map((survivingFile) => [
      survivingFile.path,
      { ...survivingFile },
    ]),
  );
}

function collectSurvivingFiles(
  group: PlannedCommit,
  resolvedGroups: PlannedCommit[],
  acceptedFileRefs: Map<string, PlannedCommitFile>[],
): PlannedCommitFile[] {
  const survivingFiles: PlannedCommitFile[] = [];

  for (const fileRef of group.files) {
    const remainingFileRef = trimOverlappingFileRef(
      fileRef,
      resolvedGroups,
      acceptedFileRefs,
    );
    if (remainingFileRef) {
      survivingFiles.push(remainingFileRef);
    }
  }

  return survivingFiles;
}

/**
 * Resolve a conflict between an accepted file reference and an incoming one.
 *
 * The accepted reference may be promoted to whole-file ownership. The incoming
 * reference may be reduced to only its uncovered hunks or dropped entirely.
 */
function resolveFileConflict(
  existing: PlannedCommitFile,
  incoming: PlannedCommitFile,
): {
  existingPromotion: null | PlannedCommitFile;
  incomingRemainder: null | PlannedCommitFile;
} {
  const existingIsWholeFile = !existing.hunks || existing.hunks.length === 0;
  const incomingIsWholeFile = !incoming.hunks || incoming.hunks.length === 0;

  if (existingIsWholeFile) {
    return { existingPromotion: null, incomingRemainder: null };
  }

  if (incomingIsWholeFile) {
    return {
      existingPromotion: { path: existing.path },
      incomingRemainder: null,
    };
  }

  const coveredHunkIndexes = new Set(existing.hunks);
  const incomingHunkIndexes = incoming.hunks ?? [];
  const remainingHunkIndexes = incomingHunkIndexes.filter(
    (hunkIndex) => !coveredHunkIndexes.has(hunkIndex),
  );

  if (remainingHunkIndexes.length === 0) {
    return { existingPromotion: null, incomingRemainder: null };
  }

  return {
    existingPromotion: null,
    incomingRemainder: { ...incoming, hunks: remainingHunkIndexes },
  };
}

function trimOverlappingFileRef(
  fileRef: PlannedCommitFile,
  resolvedGroups: PlannedCommit[],
  acceptedFileRefs: Map<string, PlannedCommitFile>[],
): null | PlannedCommitFile {
  let remainingFileRef: null | PlannedCommitFile = { ...fileRef };

  for (
    let groupIndex = 0;
    groupIndex < resolvedGroups.length && remainingFileRef !== null;
    groupIndex++
  ) {
    const acceptedFileRef = acceptedFileRefs[groupIndex]?.get(fileRef.path);
    if (
      !acceptedFileRef ||
      !plannedCommitFilesOverlap(acceptedFileRef, remainingFileRef)
    ) {
      continue;
    }

    const { existingPromotion, incomingRemainder } = resolveFileConflict(
      acceptedFileRef,
      remainingFileRef,
    );
    if (existingPromotion !== null) {
      applyExistingPromotion(
        fileRef.path,
        groupIndex,
        existingPromotion,
        resolvedGroups,
        acceptedFileRefs,
      );
    }

    remainingFileRef = incomingRemainder;
  }

  return remainingFileRef;
}
