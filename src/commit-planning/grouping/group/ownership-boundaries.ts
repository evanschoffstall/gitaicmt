import type { PlannedCommit } from "../grouping-types.js";

import { getTopLevelAreaName } from "../../path/index.js";
import { getPathOwnerDescriptor } from "../ownership.js";

/** Compares top-level directory areas like src/tests/scripts. */
export function groupsShareTopLevelArea(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): boolean {
  const previousAreas = new Set(
    previous.files.map((file) => getTopLevelAreaName(file.path)),
  );

  return candidate.files.some((file) =>
    previousAreas.has(getTopLevelAreaName(file.path)),
  );
}

/** True when both groups touch the same feature root. */
export function hasSharedFeatureRoot(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): boolean {
  const previousFeatureRoots = new Set(
    previous.files.map((file) => getPathOwnerDescriptor(file.path).featureRoot),
  );

  return candidate.files.some((file) =>
    previousFeatureRoots.has(getPathOwnerDescriptor(file.path).featureRoot),
  );
}

/** Adjacent absorption requires at least one shared ownership root. */
export function hasSharedOwner(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): boolean {
  const previousOwners = new Set(
    previous.files.map((file) => getPathOwnerDescriptor(file.path).ownerId),
  );
  const candidateOwners = new Set(
    candidate.files.map((file) => getPathOwnerDescriptor(file.path).ownerId),
  );
  const sharedOwners = [...candidateOwners].filter((owner) =>
    previousOwners.has(owner),
  );

  if (sharedOwners.some((owner) => owner !== "root")) {
    return true;
  }
  if (!sharedOwners.includes("root")) {
    return false;
  }

  const previousHasSpecificOwner = [...previousOwners].some(
    (owner) => owner !== "root",
  );
  const candidateHasSpecificOwner = [...candidateOwners].some(
    (owner) => owner !== "root",
  );

  return !previousHasSpecificOwner && !candidateHasSpecificOwner;
}
