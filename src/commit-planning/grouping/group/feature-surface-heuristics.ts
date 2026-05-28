import type { PlannedCommit } from "../grouping-types.js";

import { isSupportLikePath } from "../../path/index.js";
import { isSupportLikeType, parseSubjectWords } from "../subject/analysis.js";
import {
  buildSurfaceRolloutShape,
  getSurfaceOwnerId,
  isEntrypointLikeSurfacePath,
  isFeatureSurfacePath,
  type SurfaceRolloutDescriptor,
} from "../surface-rollout-shape.js";
import {
  isCompactCrossFeatureEntrypointRollout,
  isCompactCrossFeatureShallowRollout,
  isCompactSiblingSurfaceRollout,
} from "./surface-rollout-patterns.js";

const MAX_COMPACT_SURFACE_OWNER_COUNT = 4;
const MAX_SHALLOW_SURFACE_FILES_PER_OWNER = 10;
const MAX_SURFACE_ROLLOUT_FILE_COUNT = 20;

export interface RolloutPreservationEvaluation {
  diagnostics: Record<string, boolean | number | string>;
  reason: string;
  shouldPreserve: boolean;
}

/** Evaluates whether a merged group should stay preserved as one surface rollout. */
export function evaluateFeatureSurfaceRollout(
  group: PlannedCommit,
): RolloutPreservationEvaluation {
  const hasRolloutReason = hasSingleRolloutReason(group);
  const fileCount = group.files.length;
  if (fileCount < 2 || !hasRolloutReason) {
    return {
      diagnostics: {
        fileCount,
        hasSingleRolloutReason: hasRolloutReason,
      },
      reason: fileCount < 2 ? "too-few-files" : "missing-rollout-reason",
      shouldPreserve: false,
    };
  }

  const shapeAnalysis = analyzeRolloutShape(group, fileCount, hasRolloutReason);
  const earlyRejection = getEarlyRolloutRejection(shapeAnalysis, fileCount);
  if (earlyRejection !== null) {
    return earlyRejection;
  }

  return evaluatePreservableSurfaceRollout(
    shapeAnalysis.shape,
    fileCount,
    shapeAnalysis.shallowEntrypointCount,
    shapeAnalysis.compactCrossFeatureShallowRollout,
    shapeAnalysis.compactSiblingSurfaceRollout,
    shapeAnalysis.diagnostics,
  );
}

function analyzeRolloutShape(
  group: PlannedCommit,
  fileCount: number,
  hasRolloutReason: boolean,
): {
  compactCrossFeatureShallowRollout: boolean;
  compactSiblingSurfaceRollout: boolean;
  diagnostics: Record<string, boolean | number | string>;
  isCompactSurfaceOwnerSet: boolean;
  shallowEntrypointCount: number;
  shape: ReturnType<typeof buildSurfaceRolloutShape>;
} {
  const shape = buildSurfaceRolloutShape(group.files);
  const isCompactSurfaceOwnerSet = hasCompactSurfaceOwnerSet(
    shape.surfaceOwnerIds,
    fileCount,
  );
  const shallowEntrypointCount = getShallowEntrypointCount(shape.descriptors);

  return {
    compactCrossFeatureShallowRollout: isCompactCrossFeatureShallowRollout(
      shape,
      fileCount,
    ),
    compactSiblingSurfaceRollout: isCompactSiblingSurfaceRollout(
      shape,
      shallowEntrypointCount,
    ),
    diagnostics: buildRolloutDiagnostics(
      group,
      shape,
      isCompactSurfaceOwnerSet,
      shallowEntrypointCount,
      hasRolloutReason,
    ),
    isCompactSurfaceOwnerSet,
    shallowEntrypointCount,
    shape,
  };
}

function buildRolloutDiagnostics(
  group: PlannedCommit,
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  isCompactSurfaceOwnerSet: boolean,
  shallowEntrypointCount: number,
  hasRolloutReason: boolean,
): Record<string, boolean | number | string> {
  return {
    descriptorCount: shape.descriptors.length,
    directFileCount: shape.directFiles.length,
    featureRootCount: shape.featureRoots.size,
    fileCount: group.files.length,
    hasSingleRolloutReason: hasRolloutReason,
    isCompactSurfaceOwnerSet,
    isPreservableFeatureSurfaceShape: isPreservableFeatureSurfaceShape(
      shape,
      group.files.length,
    ),
    shallowEntrypointCount,
    surfaceOwnerCount: shape.surfaceOwnerIds.size,
  };
}

function evaluatePreservableSurfaceRollout(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  fileCount: number,
  shallowEntrypointCount: number,
  compactCrossFeatureShallowRollout: boolean,
  compactSiblingSurfaceRollout: boolean,
  diagnostics: Record<string, boolean | number | string>,
): RolloutPreservationEvaluation {
  if (shape.featureRoots.size === 1 && shape.surfaceOwnerIds.size === 1) {
    return {
      diagnostics,
      reason:
        shallowEntrypointCount >= 1 && fileCount <= 4
          ? "single-owner-entrypoint-rollout"
          : "single-owner-without-shallow-entrypoint",
      shouldPreserve: shallowEntrypointCount >= 1 && fileCount <= 4,
    };
  }

  const compactRollout = getCompactSurfaceRolloutPreservation(
    shape,
    fileCount,
    shallowEntrypointCount,
    compactCrossFeatureShallowRollout,
    compactSiblingSurfaceRollout,
    diagnostics,
  );
  if (compactRollout) {
    return compactRollout;
  }

  const isBroadShallowRollout = isBroadShallowSurfaceRollout(
    shape.directFiles,
    shape.descriptors.length,
    shape.surfaceOwnerIds,
    shape.filesPerSurfaceOwner,
    shallowEntrypointCount,
    shape.featureRoots.size,
  );
  return {
    diagnostics,
    reason: isBroadShallowRollout
      ? "broad-shallow-surface-rollout"
      : "insufficient-shallow-surface-shape",
    shouldPreserve: isBroadShallowRollout,
  };
}

function getCompactSurfaceRolloutPreservation(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  fileCount: number,
  shallowEntrypointCount: number,
  compactCrossFeatureShallowRollout: boolean,
  compactSiblingSurfaceRollout: boolean,
  diagnostics: Record<string, boolean | number | string>,
): null | RolloutPreservationEvaluation {
  if (isCompactCrossFeatureEntrypointRollout(shape, shallowEntrypointCount)) {
    return {
      diagnostics,
      reason: "compact-cross-feature-entrypoint-rollout",
      shouldPreserve: true,
    };
  }

  if (compactCrossFeatureShallowRollout) {
    return {
      diagnostics,
      reason: "compact-cross-feature-shallow-rollout",
      shouldPreserve: true,
    };
  }

  if (compactSiblingSurfaceRollout) {
    return {
      diagnostics,
      reason: "compact-sibling-surface-rollout",
      shouldPreserve: true,
    };
  }

  if (isSingleFeatureSmallRollout(shape, fileCount)) {
    return {
      diagnostics,
      reason: "single-feature-small-rollout",
      shouldPreserve: true,
    };
  }

  return null;
}

function getEarlyRolloutRejection(
  shapeAnalysis: ReturnType<typeof analyzeRolloutShape>,
  fileCount: number,
): null | RolloutPreservationEvaluation {
  if (!shapeAnalysis.isCompactSurfaceOwnerSet) {
    return {
      diagnostics: shapeAnalysis.diagnostics,
      reason: "non-compact-surface-owner-set",
      shouldPreserve: false,
    };
  }

  if (
    !shapeAnalysis.compactCrossFeatureShallowRollout &&
    !shapeAnalysis.compactSiblingSurfaceRollout &&
    !isPreservableFeatureSurfaceShape(shapeAnalysis.shape, fileCount)
  ) {
    return {
      diagnostics: shapeAnalysis.diagnostics,
      reason: "non-preservable-surface-shape",
      shouldPreserve: false,
    };
  }

  return null;
}

function getShallowEntrypointCount(
  descriptors: SurfaceRolloutDescriptor[],
): number {
  return descriptors.filter((descriptor) =>
    isShallowSurfaceEntrypoint(descriptor),
  ).length;
}

function hasCompactSurfaceOwnerSet(
  surfaceOwnerIds: Set<string>,
  fileCount: number,
): boolean {
  return (
    surfaceOwnerIds.size > 0 &&
    surfaceOwnerIds.size <= MAX_COMPACT_SURFACE_OWNER_COUNT &&
    fileCount <= MAX_SURFACE_ROLLOUT_FILE_COUNT
  );
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
    directFiles.length < 4 &&
    entrypointLikeCount < 2
  );
}

function hasSingleRolloutReason(group: PlannedCommit): boolean {
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
  const hasOnlyImplementationPaths = group.files.every(
    (file) => !isSupportLikePath(file.path),
  );

  return (
    subject.type.length > 0 &&
    (!isSupportLikeType(subject.type) || hasOnlyImplementationPaths) &&
    subject.words.size >= 2
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
  featureRootCount: number,
): boolean {
  if (featureRootCount !== 1) {
    return false;
  }

  if (
    hasExcessShallowSurfaceSpread(
      directFiles,
      surfaceOwnerIds,
      entrypointLikeCount,
    )
  ) {
    return false;
  }

  if (
    !hasValidShallowEntrypointShape(
      directFiles,
      totalFileCount,
      entrypointLikeCount,
    )
  ) {
    return false;
  }

  return (
    (entrypointLikeCount >= 1 || directFiles.length >= 2) &&
    surfaceOwnerIds.size >= 2 &&
    [...filesPerSurfaceOwner.values()].every(
      (count) => count <= MAX_SHALLOW_SURFACE_FILES_PER_OWNER,
    ) &&
    surfaceOwnerIds.size + featureRootCount <= 6
  );
}

function isPreservableFeatureSurfaceShape(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  fileCount: number,
): boolean {
  return (
    shape.featureRoots.size > 0 &&
    shape.featureRoots.size <= 2 &&
    shape.descriptors.every((descriptor) =>
      isFeatureSurfacePath(descriptor.path, descriptor.owner),
    ) &&
    hasCompactSurfaceOwnerSet(shape.surfaceOwnerIds, fileCount)
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

function isSingleFeatureSmallRollout(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  fileCount: number,
): boolean {
  return (
    shape.featureRoots.size === 1 &&
    shape.directFiles.length === 1 &&
    shape.surfaceOwnerIds.size === 2 &&
    fileCount <= 4
  );
}
