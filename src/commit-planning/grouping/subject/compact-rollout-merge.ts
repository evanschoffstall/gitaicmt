import { getTopLevelAreaName } from "../../path/index.js";
import { type PlannedCommit, type SubjectWords } from "../grouping-types.js";
import {
  buildSurfaceRolloutShape,
  isEntrypointLikeSurfacePath,
  isFeatureSurfacePath,
} from "../surface-rollout-shape.js";

interface CompactRolloutHelpers {
  countSharedSubjectWords: (left: Set<string>, right: Set<string>) => number;
  isSupportLikeType: (type: string) => boolean;
  scopesRelated: (left: string, right: string) => boolean;
}

export function hasCompactSurfaceRolloutMergeSignal(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  leftSubject: SubjectWords,
  rightSubject: SubjectWords,
  helpers: CompactRolloutHelpers,
): boolean {
  if (!hasMatchingImplementationType(leftSubject, rightSubject, helpers)) {
    return false;
  }

  const combinedFiles = [...leftGroup.files, ...rightGroup.files];
  if (!hasCompactRolloutFileCount(combinedFiles.length)) {
    return false;
  }

  const shape = buildSurfaceRolloutShape(combinedFiles);
  if (!isCompactSurfaceRolloutShape(shape)) {
    return false;
  }

  const sharedWords = helpers.countSharedSubjectWords(
    leftSubject.words,
    rightSubject.words,
  );
  if (
    hasCrossFeatureCompanionRolloutSignal(
      shape,
      combinedFiles.length,
      sharedWords,
    )
  ) {
    return true;
  }

  if (
    hasCrossFeatureEntrypointFollowUpSignal(
      leftGroup,
      rightGroup,
      shape,
      sharedWords,
    )
  ) {
    return true;
  }

  const topLevelAreas = new Set(
    combinedFiles.map((file) => getTopLevelAreaName(file.path)),
  );
  if (!hasSingleTopLevelArea(topLevelAreas)) {
    return false;
  }

  if (
    shouldRejectBroadParentSurface(
      shape,
      combinedFiles.length,
      leftSubject.scope,
      rightSubject.scope,
      helpers,
    )
  ) {
    return false;
  }

  return hasCompactAlignedEntrypoint(shape, sharedWords);
}

function getPathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function hasBroadNonEntrypointParentSurface(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
): boolean {
  if (shape.surfaceOwnerIds.size <= 1) {
    return false;
  }

  return shape.descriptors.some(
    (descriptor) =>
      descriptor.owner.kind === "direct-file" &&
      descriptor.owner.ownerId === descriptor.owner.featureRoot &&
      !isEntrypointLikeSurfacePath(descriptor.path, descriptor.owner),
  );
}

function hasBroadSmallCrossFeatureCompanionRollout(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  fileCount: number,
): boolean {
  return (
    fileCount <= 4 &&
    shape.surfaceOwnerIds.size <= 3 &&
    shape.directFiles.length >= 1 &&
    shape.directFiles.length <= 3 &&
    shape.entrypointLikeCount <= 2
  );
}

function hasCompactAlignedEntrypoint(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  sharedWords: number,
): boolean {
  const hasWordAlignedEntrypoint =
    (shape.entrypointLikeCount >= 1 && sharedWords >= 1) || sharedWords >= 2;
  return (
    shape.directFiles.length > 0 &&
    shape.surfaceOwnerIds.size <= 4 &&
    hasWordAlignedEntrypoint
  );
}

function hasCompactEntrypointPair(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  fileCount: number,
): boolean {
  return shape.entrypointLikeCount >= 2 && fileCount <= 4;
}

function hasCompactRolloutFileCount(fileCount: number): boolean {
  return fileCount >= 2 && fileCount <= 20;
}

function hasCrossFeatureCompanionRolloutSignal(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  fileCount: number,
  sharedWords: number,
): boolean {
  if (
    shape.featureRoots.size !== 2 ||
    !hasOnlyShallowCompanionSurfaceOwners(shape) ||
    sharedWords < 3
  ) {
    return false;
  }

  if (fileCount === 2) {
    return (
      shape.surfaceOwnerIds.size === 2 &&
      shape.directFiles.length === 1 &&
      shape.entrypointLikeCount === 0
    );
  }

  return hasBroadSmallCrossFeatureCompanionRollout(shape, fileCount);
}

function hasCrossFeatureEntrypointFollowUpSignal(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  sharedWords: number,
): boolean {
  const groupSizes = [leftGroup.files.length, rightGroup.files.length].sort(
    (left, right) => left - right,
  );
  const [smallerGroupSize, largerGroupSize] = groupSizes;

  return (
    shape.featureRoots.size === 2 &&
    shape.surfaceOwnerIds.size <= 3 &&
    hasOnlyShallowCompanionSurfaceOwners(shape) &&
    sharedWords >= 3 &&
    smallerGroupSize <= 2 &&
    largerGroupSize <= 5 &&
    shape.directFiles.length >= 2 &&
    shape.entrypointLikeCount >= 2
  );
}

function hasMatchingImplementationType(
  leftSubject: SubjectWords,
  rightSubject: SubjectWords,
  helpers: CompactRolloutHelpers,
): boolean {
  return (
    leftSubject.type !== "" &&
    rightSubject.type !== "" &&
    leftSubject.type === rightSubject.type &&
    !helpers.isSupportLikeType(leftSubject.type) &&
    !helpers.isSupportLikeType(rightSubject.type)
  );
}

function hasOnlyShallowCompanionSurfaceOwners(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
): boolean {
  return shape.descriptors.every((descriptor) => {
    if (descriptor.owner.kind !== "nested-subtree") {
      return true;
    }

    return (
      getPathDepth(descriptor.path) <=
      getPathDepth(descriptor.owner.ownerId) + 1
    );
  });
}

function hasSingleTopLevelArea(topLevelAreas: Set<string>): boolean {
  return topLevelAreas.size === 1;
}

function isCompactSurfaceRolloutShape(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
): boolean {
  return (
    shape.featureRoots.size > 0 &&
    shape.featureRoots.size <= 2 &&
    shape.descriptors.every((descriptor) =>
      isFeatureSurfacePath(descriptor.path, descriptor.owner),
    )
  );
}

function shouldRejectBroadParentSurface(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  fileCount: number,
  leftScope: string,
  rightScope: string,
  helpers: CompactRolloutHelpers,
): boolean {
  return (
    hasBroadNonEntrypointParentSurface(shape) &&
    !helpers.scopesRelated(leftScope, rightScope) &&
    !hasCompactEntrypointPair(shape, fileCount)
  );
}
