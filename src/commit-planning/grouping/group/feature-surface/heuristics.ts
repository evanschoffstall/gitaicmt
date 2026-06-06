import type { PlannedCommit } from "../../grouping-types.js";

import { isSupportLikePath } from "../../../path/index.js";
import {
  isSupportLikeType,
  parseSubjectWords,
} from "../../subject/analysis.js";
import {
  buildSurfaceRolloutShape,
  isFeatureSurfacePath,
} from "../../surface-rollout-shape.js";
import {
  isCompactCrossFeatureEntrypointRollout,
  isCompactCrossFeatureShallowRollout,
  isCompactSiblingSurfaceRollout,
} from "../surface-rollout-patterns.js";
import {
  getShallowEntrypointCount,
  isBroadShallowSurfaceRollout,
} from "./shallow.js";

const MAX_COMPACT_SURFACE_OWNER_COUNT = 4;
const MAX_SHALLOW_SURFACE_FILES_PER_OWNER = 10;
const MAX_SURFACE_ROLLOUT_FILE_COUNT = 20;

export interface RolloutPreservationEvaluation {
  diagnostics: Record<string, boolean | number | string>;
  reason: string;
  shouldPreserve: boolean;
}

interface CompactSurfaceRolloutContext {
  compactCrossFeatureEntrypointDenseRollout: boolean;
  compactCrossFeatureShallowRollout: boolean;
  compactSiblingSurfaceRollout: boolean;
  diagnostics: Record<string, boolean | number | string>;
  fileCount: number;
  shallowEntrypointCount: number;
  shape: ReturnType<typeof buildSurfaceRolloutShape>;
}

interface RolloutShapeAnalysis {
  compactCrossFeatureEntrypointDenseRollout: boolean;
  compactCrossFeatureShallowRollout: boolean;
  compactSiblingSurfaceRollout: boolean;
  diagnostics: Record<string, boolean | number | string>;
  isCompactSurfaceOwnerSet: boolean;
  shallowEntrypointCount: number;
  shape: ReturnType<typeof buildSurfaceRolloutShape>;
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

  return evaluatePreservableSurfaceRollout({
    compactCrossFeatureEntrypointDenseRollout:
      shapeAnalysis.compactCrossFeatureEntrypointDenseRollout,
    compactCrossFeatureShallowRollout:
      shapeAnalysis.compactCrossFeatureShallowRollout,
    compactSiblingSurfaceRollout: shapeAnalysis.compactSiblingSurfaceRollout,
    diagnostics: shapeAnalysis.diagnostics,
    fileCount,
    shallowEntrypointCount: shapeAnalysis.shallowEntrypointCount,
    shape: shapeAnalysis.shape,
  });
}

function analyzeRolloutShape(
  group: PlannedCommit,
  fileCount: number,
  hasRolloutReason: boolean,
): RolloutShapeAnalysis {
  const shape = buildSurfaceRolloutShape(group.files);
  const isCompactSurfaceOwnerSet = hasCompactSurfaceOwnerSet(
    shape.surfaceOwnerIds,
    fileCount,
  );
  const shallowEntrypointCount = getShallowEntrypointCount(shape.descriptors);
  const compactCrossFeatureEntrypointDenseRollout =
    isCompactCrossFeatureEntrypointDenseRollout(
      shape,
      fileCount,
      shallowEntrypointCount,
    );

  return {
    compactCrossFeatureEntrypointDenseRollout,
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
      compactCrossFeatureEntrypointDenseRollout,
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
  compactCrossFeatureEntrypointDenseRollout: boolean,
  isCompactSurfaceOwnerSet: boolean,
  shallowEntrypointCount: number,
  hasRolloutReason: boolean,
): Record<string, boolean | number | string> {
  return {
    compactCrossFeatureEntrypointDenseRollout,
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
  context: CompactSurfaceRolloutContext,
): RolloutPreservationEvaluation {
  const { diagnostics, fileCount, shallowEntrypointCount, shape } = context;

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

  const compactRollout = getCompactSurfaceRolloutPreservation(context);
  if (compactRollout) {
    return compactRollout;
  }

  const isBroadShallowRollout = isBroadShallowSurfaceRollout(
    shape.directFiles,
    shape.descriptors.length,
    shape.surfaceOwnerIds,
    shape.filesPerSurfaceOwner,
    shallowEntrypointCount,
    {
      featureRootCount: shape.featureRoots.size,
      maxShallowFilesPerOwner: MAX_SHALLOW_SURFACE_FILES_PER_OWNER,
    },
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
  context: CompactSurfaceRolloutContext,
): null | RolloutPreservationEvaluation {
  const {
    compactCrossFeatureEntrypointDenseRollout,
    compactCrossFeatureShallowRollout,
    compactSiblingSurfaceRollout,
    diagnostics,
    fileCount,
    shallowEntrypointCount,
    shape,
  } = context;

  if (compactCrossFeatureEntrypointDenseRollout) {
    return {
      diagnostics,
      reason: "compact-cross-feature-entrypoint-dense-rollout",
      shouldPreserve: true,
    };
  }

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
  shapeAnalysis: RolloutShapeAnalysis,
  fileCount: number,
): null | RolloutPreservationEvaluation {
  if (
    !shapeAnalysis.compactCrossFeatureEntrypointDenseRollout &&
    !shapeAnalysis.isCompactSurfaceOwnerSet
  ) {
    return {
      diagnostics: shapeAnalysis.diagnostics,
      reason: "non-compact-surface-owner-set",
      shouldPreserve: false,
    };
  }

  if (
    !shapeAnalysis.compactCrossFeatureEntrypointDenseRollout &&
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

/**
 * Preserve a shallow cross-root rollout when each feature root contributes a
 * small surface slice anchored by entrypoint-like files rather than deep code.
 */
function isCompactCrossFeatureEntrypointDenseRollout(
  shape: ReturnType<typeof buildSurfaceRolloutShape>,
  fileCount: number,
  shallowEntrypointCount: number,
): boolean {
  return (
    shape.featureRoots.size >= 3 &&
    shape.descriptors.every((descriptor) =>
      isFeatureSurfacePath(descriptor.path, descriptor.owner),
    ) &&
    shallowEntrypointCount >= shape.featureRoots.size &&
    shape.surfaceOwnerIds.size <= shape.featureRoots.size * 2 &&
    fileCount <= shape.surfaceOwnerIds.size * 3 &&
    [...shape.filesPerSurfaceOwner.values()].every(
      (count) => count <= MAX_SHALLOW_SURFACE_FILES_PER_OWNER,
    )
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
