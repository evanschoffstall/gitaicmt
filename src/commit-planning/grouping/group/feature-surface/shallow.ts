import {
  getSurfaceOwnerId,
  isEntrypointLikeSurfacePath,
  type SurfaceRolloutDescriptor,
} from "../../surface-rollout-shape.js";

function getShallowEntrypointCount(
  descriptors: SurfaceRolloutDescriptor[],
): number {
  return descriptors.filter((descriptor) =>
    isShallowSurfaceEntrypoint(descriptor),
  ).length;
}

function hasExcessShallowSurfaceSpread(
  directFiles: {
    owner: SurfaceRolloutDescriptor["owner"];
    path: string;
  }[],
  surfaceOwnerIds: Set<string>,
  entrypointLikeCount: number,
): boolean {
  return (
    surfaceOwnerIds.size > 2 &&
    directFiles.length < 3 &&
    entrypointLikeCount < 2
  );
}

function hasValidShallowEntrypointShape(
  directFiles: {
    owner: SurfaceRolloutDescriptor["owner"];
    path: string;
  }[],
  totalFileCount: number,
  entrypointLikeCount: number,
): boolean {
  if (entrypointLikeCount === 0 && directFiles.length === totalFileCount) {
    return false;
  }

  return !(entrypointLikeCount === 0 && directFiles.length > 4);
}

function isBroadShallowSurfaceRollout(
  directFiles: {
    owner: SurfaceRolloutDescriptor["owner"];
    path: string;
  }[],
  totalFileCount: number,
  surfaceOwnerIds: Set<string>,
  filesPerSurfaceOwner: Map<string, number>,
  entrypointLikeCount: number,
  limits: {
    featureRootCount: number;
    maxShallowFilesPerOwner: number;
  },
): boolean {
  if (limits.featureRootCount !== 1) {
    return false;
  }

  if (
    hasExcessShallowSurfaceSpread(
      directFiles,
      surfaceOwnerIds,
      entrypointLikeCount,
    ) ||
    !hasValidShallowEntrypointShape(
      directFiles,
      totalFileCount,
      entrypointLikeCount,
    )
  ) {
    return false;
  }

  const surfaceDepths = [...surfaceOwnerIds].map(
    (surfaceOwnerId) => surfaceOwnerId.split("/").filter(Boolean).length,
  );
  const shallowestDepth = Math.min(...surfaceDepths);
  if (surfaceDepths.some((depth) => depth > shallowestDepth + 1)) {
    return false;
  }

  return (
    (entrypointLikeCount >= 1 || directFiles.length >= 2) &&
    surfaceOwnerIds.size >= 2 &&
    [...filesPerSurfaceOwner.values()].every(
      (count) => count <= limits.maxShallowFilesPerOwner,
    ) &&
    surfaceOwnerIds.size + limits.featureRootCount <= 6
  );
}

function isShallowSurfaceEntrypoint(
  descriptor: SurfaceRolloutDescriptor,
): boolean {
  return (
    isEntrypointLikeSurfacePath(descriptor.path, descriptor.owner) &&
    getSurfaceOwnerId(descriptor.path, descriptor.owner) ===
      descriptor.owner.ownerId
  );
}

export { getShallowEntrypointCount, isBroadShallowSurfaceRollout };
