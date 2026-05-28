import {
  getMeaningfulPathWords,
  getTopLevelAreaName,
} from "../../../path/index.js";
import { type FileDiff, type PlannedCommit } from "../../grouping-types.js";
import {
  getPathOwnerDescriptor,
  inferSupportScopeFromPath,
} from "../../ownership.js";

/** Returns shared identifier tokens introduced by both groups' diffs. */
export function getSharedChangedIdentifiers(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): Set<string> {
  const leftIdentifiers = collectChangedIdentifiers(leftGroup, fileByPath);
  const rightIdentifiers = collectChangedIdentifiers(rightGroup, fileByPath);

  return new Set(
    [...leftIdentifiers].filter((token) => rightIdentifiers.has(token)),
  );
}

/** Returns the single feature root when a group stays within one feature. */
export function getSingleFeatureRoot(group: PlannedCommit): null | string {
  return getSingleSetValue(
    new Set(
      group.files.map((file) => getPathOwnerDescriptor(file.path).featureRoot),
    ),
  );
}

/** Returns the single owner id when all files in a group share one owner. */
export function getSingleOwnerId(group: PlannedCommit): null | string {
  const ownerIds = new Set(
    group.files.map((file) => getPathOwnerDescriptor(file.path).ownerId),
  );

  return getSingleSetValue(ownerIds);
}

/** Returns the single top-level area when a group stays within one root area. */
export function getSingleTopLevelArea(group: PlannedCommit): null | string {
  return getSingleSetValue(
    new Set(group.files.map((file) => getTopLevelAreaName(file.path))),
  );
}

/** Builds structural ownership words for test follow-up attachment. */
export function getStructuralPathWords(group: PlannedCommit): Set<string> {
  const words = new Set<string>();

  for (const file of group.files) {
    for (const word of getPathWordTokens(file.path)) {
      words.add(word);
    }

    for (const word of getPathWordTokens(
      inferSupportScopeFromPath(file.path),
    )) {
      words.add(word);
    }

    for (const word of getPathWordTokens(
      getPathOwnerDescriptor(file.path).ownerId,
    )) {
      words.add(word);
    }
  }

  return words;
}

/** True when one group is small enough to plausibly be a propagation follow-up. */
export function hasSmallFollowUpFootprint(group: PlannedCommit): boolean {
  return group.files.length <= 3;
}

/** Test follow-ups should stay tiny before deterministic owner attachment applies. */
export function hasSmallTestFollowUpFootprint(group: PlannedCommit): boolean {
  return group.files.length <= 2;
}

/** Cleanup-heavy groups should only auto-attach when deleted files dominate. */
export function isCleanupDominantGroup(
  group: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): boolean {
  let deletedFileCount = 0;

  for (const file of group.files) {
    if (fileByPath.get(file.path)?.status === "deleted") {
      deletedFileCount++;
    }
  }

  return deletedFileCount > 0 && deletedFileCount * 2 >= group.files.length;
}

/** Collects changed identifiers for one group so shared rename follow-ups can merge. */
function collectChangedIdentifiers(
  group: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): Set<string> {
  const identifiers = new Set<string>();

  for (const file of group.files) {
    const fileDiff = fileByPath.get(file.path);
    if (!fileDiff) {
      continue;
    }

    for (const token of getChangedIdentifierTokens(fileDiff, file.hunks)) {
      identifiers.add(token);
    }
  }

  return identifiers;
}

/** Extracts structurally meaningful identifier tokens from selected diff hunks. */
function getChangedIdentifierTokens(
  file: FileDiff,
  selectedHunks?: number[],
): Set<string> {
  const identifiers = new Set<string>();
  const selectedHunkIndexes = selectedHunks ? new Set(selectedHunks) : null;

  for (const [index, hunk] of file.hunks.entries()) {
    if (selectedHunkIndexes && !selectedHunkIndexes.has(index)) {
      continue;
    }

    for (const line of hunk.lines) {
      if (!line.startsWith("+") && !line.startsWith("-")) {
        continue;
      }

      for (const match of line.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{4,}\b/gu)) {
        const token = match[0];
        if (!/[A-Z]/u.test(token)) {
          continue;
        }

        identifiers.add(token);
      }
    }
  }

  return identifiers;
}

/** Reuses the planner's path-word vocabulary for deterministic premerge checks. */
function getPathWordTokens(pathLikeValue: string): string[] {
  return getMeaningfulPathWords(pathLikeValue).filter((word) =>
    /[a-z]/u.test(word),
  );
}

/** Returns a single stable set value when a group touches exactly one area. */
function getSingleSetValue(values: Set<string>): null | string {
  if (values.size !== 1) {
    return null;
  }

  return values.values().next().value ?? null;
}
