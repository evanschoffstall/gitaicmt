import {
  buildSurfaceRolloutShape,
  getSurfaceOwnerId,
} from "../surface-rollout-shape.js";

const MAX_SHALLOW_SURFACE_FILES_PER_OWNER = 10;

/** Detects compact cross-feature entrypoint rollouts that should stay merged. */
export function isCompactCrossFeatureEntrypointRollout(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  shallowEntrypointCount: number,
): boolean {
  const directFeatureRoots = new Set(
    shape.directFiles.map((descriptor) => descriptor.owner.featureRoot),
  );
  const nestedFeatureRoots = new Set(
    shape.descriptors
      .filter((descriptor) => descriptor.owner.kind !== "direct-file")
      .map((descriptor) => descriptor.owner.featureRoot),
  );

  return (
    shape.featureRoots.size > 1 &&
    directFeatureRoots.size === shape.featureRoots.size &&
    shallowEntrypointCount >= 1 &&
    nestedFeatureRoots.size < shape.featureRoots.size &&
    shape.surfaceOwnerIds.size ===
      directFeatureRoots.size + nestedFeatureRoots.size &&
    (shape.descriptors.length === shape.surfaceOwnerIds.size ||
      isCompactCrossFeatureEntrypointFollowUp(shape, shallowEntrypointCount))
  );
}

/** Detects compact cross-feature shallow rollouts such as root-plus-script updates. */
export function isCompactCrossFeatureShallowRollout(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  fileCount: number,
): boolean {
  return (
    shape.featureRoots.size === 2 &&
    shape.surfaceOwnerIds.size === 2 &&
    fileCount <= 6 &&
    shape.descriptors.every(
      (descriptor) => descriptor.owner.kind === "other",
    ) &&
    [...shape.filesPerSurfaceOwner.values()].every(
      (count) => count <= MAX_SHALLOW_SURFACE_FILES_PER_OWNER,
    )
  );
}

/** Detects compact same-feature sibling surface rollouts that remain coherent together. */
export function isCompactSiblingSurfaceRollout(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  shallowEntrypointCount: number,
): boolean {
  if (shape.featureRoots.size !== 1 || shallowEntrypointCount < 1) {
    return false;
  }

  const baseSurfaceOwnerIds = new Set(
    shape.descriptors
      .filter(
        (descriptor) =>
          getSurfaceOwnerId(descriptor.path, descriptor.owner) ===
          descriptor.owner.ownerId,
      )
      .map((descriptor) => descriptor.owner.ownerId),
  );

  return [...baseSurfaceOwnerIds].some((baseSurfaceOwnerId) => {
    const directChildSurfaceIds = [...shape.surfaceOwnerIds].filter(
      (surfaceOwnerId) =>
        surfaceOwnerId.startsWith(`${baseSurfaceOwnerId}/`) &&
        surfaceOwnerId.split("/").filter(Boolean).length ===
          baseSurfaceOwnerId.split("/").filter(Boolean).length + 1,
    );
    const featureRoot = [...shape.featureRoots][0];
    const isFeatureRootBase = baseSurfaceOwnerId === featureRoot;

    return (
      (isFeatureRootBase
        ? directChildSurfaceIds.length === 1
        : directChildSurfaceIds.length >= 2) &&
      [baseSurfaceOwnerId, ...directChildSurfaceIds].every(
        (surfaceOwnerId) =>
          (shape.filesPerSurfaceOwner.get(surfaceOwnerId) ?? 0) <=
          MAX_SHALLOW_SURFACE_FILES_PER_OWNER,
      )
    );
  });
}

function isCompactCrossFeatureEntrypointFollowUp(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  shallowEntrypointCount: number,
): boolean {
  return (
    shape.descriptors.length <= 7 &&
    shallowEntrypointCount >= 2 &&
    shape.directFiles.length >= 2 &&
    [...shape.filesPerSurfaceOwner.values()].every((count) => count <= 3)
  );
}
