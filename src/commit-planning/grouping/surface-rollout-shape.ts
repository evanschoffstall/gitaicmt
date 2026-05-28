import type { PlannedCommit } from "./grouping-types.js";

import { getPathOwnerDescriptor } from "./ownership.js";

export interface SurfaceRolloutDescriptor {
  owner: ReturnType<typeof getPathOwnerDescriptor>;
  path: string;
}

export interface SurfaceRolloutShape {
  descriptors: SurfaceRolloutDescriptor[];
  directFiles: SurfaceRolloutDescriptor[];
  entrypointLikeCount: number;
  featureRoots: Set<string>;
  filesPerSurfaceOwner: Map<string, number>;
  surfaceOwnerIds: Set<string>;
}

export function buildSurfaceRolloutShape(
  files: PlannedCommit["files"],
): SurfaceRolloutShape {
  const descriptors = files.map((file) => ({
    owner: getPathOwnerDescriptor(file.path),
    path: file.path,
  }));
  const directFiles = descriptors.filter(
    (descriptor) => descriptor.owner.kind === "direct-file",
  );
  const surfaceOwnerIds = new Set(
    descriptors.map((descriptor) =>
      getSurfaceOwnerId(descriptor.path, descriptor.owner),
    ),
  );
  const filesPerSurfaceOwner = new Map<string, number>();

  for (const descriptor of descriptors) {
    const ownerId = getSurfaceOwnerId(descriptor.path, descriptor.owner);
    filesPerSurfaceOwner.set(
      ownerId,
      (filesPerSurfaceOwner.get(ownerId) ?? 0) + 1,
    );
  }

  return {
    descriptors,
    directFiles,
    entrypointLikeCount: descriptors.filter((descriptor) =>
      isEntrypointLikeSurfacePath(descriptor.path, descriptor.owner),
    ).length,
    featureRoots: new Set(
      descriptors.map((descriptor) => descriptor.owner.featureRoot),
    ),
    filesPerSurfaceOwner,
    surfaceOwnerIds,
  };
}

export function getSurfaceOwnerId(
  filePath: string,
  owner = getPathOwnerDescriptor(filePath),
): string {
  if (owner.kind !== "nested-subtree") {
    return owner.ownerId;
  }

  const ownerSegments = owner.ownerId.split("/").filter(Boolean);
  const pathSegments = filePath.split("/").filter(Boolean);
  const nextSegment = pathSegments[ownerSegments.length];

  if (!nextSegment || nextSegment.includes(".")) {
    return owner.ownerId;
  }

  return `${owner.ownerId}/${nextSegment}`;
}

export function isEntrypointLikeSurfacePath(
  filePath: string,
  owner = getPathOwnerDescriptor(filePath),
): boolean {
  return (
    isFeatureEntrypointPath(filePath) ||
    isFlattenedFeatureSurfacePath(filePath, owner)
  );
}

export function isFeatureEntrypointPath(filePath: string): boolean {
  const basename = filePath.split("/").at(-1) ?? "";
  return /^index\.[^.]+$/u.test(basename);
}

export function isFeatureSurfacePath(
  filePath: string,
  owner = getPathOwnerDescriptor(filePath),
): boolean {
  if (owner.kind === "direct-file") {
    return true;
  }
  if (owner.kind !== "nested-subtree") {
    return false;
  }
  if (isFlattenedFeatureSurfacePath(filePath, owner)) {
    return true;
  }

  const ownerSegments = owner.ownerId.split("/").filter(Boolean);
  const featureRootSegments = owner.featureRoot.split("/").filter(Boolean);
  const pathSegments = filePath.split("/").filter(Boolean);

  return (
    ownerSegments.length === featureRootSegments.length + 1 &&
    pathSegments.length <= ownerSegments.length + 2
  );
}

export function isFlattenedFeatureSurfacePath(
  filePath: string,
  owner = getPathOwnerDescriptor(filePath),
): boolean {
  if (owner.kind !== "nested-subtree") {
    return false;
  }

  const pathSegments = filePath.split("/").filter(Boolean);
  const ownerSegments = owner.ownerId.split("/").filter(Boolean);
  const featureRootSegments = owner.featureRoot.split("/").filter(Boolean);

  return (
    ownerSegments.length === featureRootSegments.length + 1 &&
    pathSegments.length === featureRootSegments.length + 1
  );
}
