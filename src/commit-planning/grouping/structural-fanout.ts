import type { PlannedCommit } from "./grouping-types.js";

import { getPathOwnerDescriptor } from "./ownership.js";
import {
  buildSurfaceRolloutShape,
  getSurfaceOwnerId,
} from "./surface-rollout-shape.js";

export function countDeepInternalSurfaceFiles(
  files: PlannedCommit["files"],
): number {
  const rolloutShape = buildSurfaceRolloutShape(files);

  return rolloutShape.descriptors.filter((descriptor) => {
    const surfaceOwnerDepth = getSurfaceOwnerId(
      descriptor.path,
      descriptor.owner,
    )
      .split("/")
      .filter(Boolean).length;
    const pathDepth = descriptor.path.split("/").filter(Boolean).length;
    return pathDepth > surfaceOwnerDepth + 1;
  }).length;
}

export function hasBroadDeepStructuralFanout(groups: PlannedCommit[]): boolean {
  if (groups.length < 5) {
    return false;
  }

  const files = groups.flatMap((group) => group.files);
  const rolloutShape = buildSurfaceRolloutShape(files);

  return (
    rolloutShape.featureRoots.size === 1 &&
    rolloutShape.surfaceOwnerIds.size >= 4 &&
    countDeepInternalSurfaceFiles(files) >= 2
  );
}

export function isCompactDeepParentSurfaceRollout(
  groups: PlannedCommit[],
): boolean {
  if (groups.length > 4) {
    return false;
  }

  const files = groups.flatMap((group) => group.files);
  const rolloutShape = buildSurfaceRolloutShape(files);

  return (
    rolloutShape.featureRoots.size === 1 &&
    rolloutShape.surfaceOwnerIds.size >= 3 &&
    rolloutShape.surfaceOwnerIds.size <= 4 &&
    rolloutShape.descriptors.length <= 20 &&
    countDeepInternalSurfaceFiles(files) >= 2
  );
}

export function isDeepNestedInternalUmbrella(groups: PlannedCommit[]): boolean {
  const fileDescriptors = groups.flatMap((group) =>
    group.files.map((file) => ({
      descriptor: getPathOwnerDescriptor(file.path),
      path: file.path,
    })),
  );
  const hasSingleFeatureRoot =
    new Set(fileDescriptors.map(({ descriptor }) => descriptor.featureRoot))
      .size === 1;

  if (fileDescriptors.length === 0 || !hasSingleFeatureRoot) {
    return false;
  }

  const directFileCount = fileDescriptors.filter(
    ({ descriptor }) => descriptor.kind === "direct-file",
  ).length;
  const nestedOwnerIds = new Set(
    fileDescriptors
      .filter(({ descriptor }) => descriptor.kind === "nested-subtree")
      .map(({ descriptor }) => descriptor.ownerId),
  );
  const deepNestedFileCount = fileDescriptors.filter(({ descriptor, path }) => {
    if (descriptor.kind !== "nested-subtree") {
      return false;
    }

    const ownerDepth = descriptor.ownerId.split("/").filter(Boolean).length;
    const pathDepth = path.split("/").filter(Boolean).length;
    return pathDepth > ownerDepth + 1;
  }).length;

  if (nestedOwnerIds.size < 2 || deepNestedFileCount < 2) {
    return false;
  }

  if (directFileCount === 0) {
    return true;
  }

  const nestedFileCount = fileDescriptors.length - directFileCount;
  return (
    groups.length >= 4 &&
    nestedOwnerIds.size >= 3 &&
    deepNestedFileCount >= 3 &&
    directFileCount <= nestedFileCount
  );
}
