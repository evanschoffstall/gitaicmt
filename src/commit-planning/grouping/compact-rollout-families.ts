import { isSupportLikePath } from "../path/index.js";
import { mergeCommitsIntoGroup } from "./group/merge.js";
import { type FileDiff, type PlannedCommit } from "./grouping-types.js";
import { getDominantGroupOwner } from "./implementation-components.js";
import { getPathOwnerDescriptor } from "./ownership.js";
import { isDeepNestedInternalUmbrella } from "./structural-fanout.js";
import {
  haveCompleteSubjectWordOverlap,
  isSupportLikeType,
  parseSubjectWords,
} from "./subject/analysis.js";

/**
 * Re-merges tiny exact-overlap rollout slices after a later pipeline step has
 * split them by owner. This is intentionally narrow: it only rejoins compact
 * implementation families whose subject wording still fully overlaps and whose
 * dominant owners remain within one parent/child surface family plus an
 * optional root follow-up.
 */
export function mergeCompactExactRolloutFamilies(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const mergedGroups: PlannedCommit[] = [];
  const consumed = new Set<number>();

  for (let index = 0; index < groups.length; index++) {
    if (consumed.has(index)) {
      continue;
    }

    const family = [groups[index]];
    consumed.add(index);

    for (
      let candidateIndex = index + 1;
      candidateIndex < groups.length;
      candidateIndex++
    ) {
      if (consumed.has(candidateIndex)) {
        continue;
      }

      if (canExtendCompactExactRolloutFamily(family, groups[candidateIndex])) {
        family.push(groups[candidateIndex]);
        consumed.add(candidateIndex);
      }
    }

    mergedGroups.push(
      family.length === 1
        ? family[0]
        : mergeCommitsIntoGroup(family, fileByPath),
    );
  }

  return mergedGroups;
}

/**
 * Accepts only very small exact-overlap implementation slices so the helper
 * cannot collapse broad umbrellas or support-led groups back together.
 */
function canExtendCompactExactRolloutFamily(
  family: PlannedCommit[],
  candidate: PlannedCommit,
): boolean {
  if (isDeepNestedInternalUmbrella([...family, candidate])) {
    return false;
  }

  if (!hasCompatibleExactRolloutSubjects(family, candidate)) {
    return false;
  }

  if (!hasCompactExactRolloutFootprint(family, candidate)) {
    return false;
  }

  if (!hasCompactExactRolloutBridgeSurface(family, candidate)) {
    return false;
  }

  if (!hasNestedImplementationSurface(family, candidate)) {
    return false;
  }

  return hasCompatibleOwnerAnchorFamily(family, candidate);
}

/**
 * Uses the dominant owner surface as the family anchor so direct coordinator
 * files can stay attached to one nested follow-up surface without widening the
 * merge to the entire top-level feature root.
 */
function getCompactRolloutOwnerAnchor(group: PlannedCommit): null | string {
  return group.files.length === 0 ? null : getDominantGroupOwner(group);
}

function hasCombinedGroupFile(
  family: PlannedCommit[],
  candidate: PlannedCommit,
  predicate: (file: PlannedCommit["files"][number]) => boolean,
): boolean {
  return [...family, candidate].some((group) =>
    group.files.some((file) => predicate(file)),
  );
}

function hasCompactExactRolloutBridgeSurface(
  family: PlannedCommit[],
  candidate: PlannedCommit,
): boolean {
  return hasCombinedGroupFile(family, candidate, (file) => {
    const owner = getPathOwnerDescriptor(file.path);
    return owner.kind === "direct-file" || owner.ownerId === "root";
  });
}

function hasCompactExactRolloutFootprint(
  family: PlannedCommit[],
  candidate: PlannedCommit,
): boolean {
  const combinedFileCount =
    family.reduce((count, group) => count + group.files.length, 0) +
    candidate.files.length;

  return (
    family.length < 3 &&
    combinedFileCount <= 5 &&
    candidate.files.length <= 3 &&
    family.every((group) => group.files.length <= 3)
  );
}

function hasCompatibleExactRolloutSubjects(
  family: PlannedCommit[],
  candidate: PlannedCommit,
): boolean {
  const allSubjects = [...family, candidate].map((group) =>
    parseSubjectWords(group.message.split("\n")[0] ?? ""),
  );
  const firstType = allSubjects[0]?.type ?? "";

  return (
    firstType.length > 0 &&
    !isSupportLikeType(firstType) &&
    allSubjects.every((subject) => subject.type === firstType) &&
    haveCompleteSubjectWordOverlap(allSubjects, 0, true)
  );
}

function hasCompatibleOwnerAnchorFamily(
  family: PlannedCommit[],
  candidate: PlannedCommit,
): boolean {
  const nonRootOwners = [...family, candidate]
    .map(getCompactRolloutOwnerAnchor)
    .filter(
      (ownerId): ownerId is string => ownerId !== null && ownerId !== "root",
    );

  return (
    nonRootOwners.length > 0 &&
    new Set(nonRootOwners).size <= 2 &&
    hasNestedOwnerAnchorFamily(nonRootOwners)
  );
}

function hasNestedImplementationSurface(
  family: PlannedCommit[],
  candidate: PlannedCommit,
): boolean {
  return hasCombinedGroupFile(family, candidate, (file) => {
    const owner = getPathOwnerDescriptor(file.path);
    return owner.kind === "nested-subtree" && !isSupportLikePath(file.path);
  });
}

function hasNestedOwnerAnchorFamily(ownerAnchors: string[]): boolean {
  return ownerAnchors.some((candidateRoot) =>
    ownerAnchors.every(
      (ownerId) =>
        ownerId === candidateRoot || ownerId.startsWith(`${candidateRoot}/`),
    ),
  );
}
