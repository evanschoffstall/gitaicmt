import { getStructuralFeatureBoundary } from "../path/index.js";
import {
  buildCoveredBaselineFallbackDiagnostics,
  type CoveredBaselineFallbackEvaluation,
  type CoveredBaselineFallbackSignals,
  getPreservedCoveredBaselineFallbackReason,
} from "./covered-baseline-fallback-outcome.js";
import { type PlannedCommit } from "./grouping-types.js";
import { getPathOwnerDescriptor } from "./ownership.js";
import { shouldPreserveIdenticalRollout } from "./rollout-preservation.js";
import { hasBroadDeepStructuralFanout } from "./structural-fanout.js";
import {
  haveCompleteSubjectWordOverlap,
  isSupportLikeType,
  parseSubjectWords,
} from "./subject/analysis.js";
import {
  buildSurfaceRolloutShape,
  isFeatureSurfacePath,
} from "./surface-rollout-shape.js";

/**
 * Evaluates whether a weak consolidation should keep the consolidated group,
 * restore the covered baseline groups, or accept the repartitioned result.
 */
export function evaluateCoveredBaselineFallback(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  repartitioned: PlannedCommit[],
  preserveShallowSurfaceRollout: boolean,
  getDominantGroupOwner: (group: PlannedCommit) => string,
): CoveredBaselineFallbackEvaluation {
  const signals = collectCoveredBaselineFallbackSignals(
    coveredGroups,
    repartitioned,
    preserveShallowSurfaceRollout,
    getDominantGroupOwner,
  );
  const diagnostics = buildCoveredBaselineFallbackDiagnostics(signals);

  if (signals.preserveShallowSurfaceRollout) {
    return {
      diagnostics,
      groups: [group],
      reason: getPreservedCoveredBaselineFallbackReason(signals),
      resolution: "preserve-consolidated",
    };
  }

  if (
    shouldRestoreCoveredBaselineAfterRepartition(
      signals.hasCollapsedImplementationBundle,
      signals.hasDominantMegaRepartitionedGroup,
      signals.hasRestoreCoveredBaselineSignal,
      signals.preserveShallowSurfaceRollout,
      signals.repartitionedGroupCount,
    )
  ) {
    return {
      diagnostics,
      groups: coveredGroups,
      reason: "restore-covered-baseline",
      resolution: "restore-covered-baseline",
    };
  }

  if (
    signals.repartitionedGroupCount <= 1 ||
    signals.shouldPreserveIdenticalRepartitionedRollout
  ) {
    return {
      diagnostics,
      groups: [group],
      reason: getPreservedCoveredBaselineFallbackReason(signals),
      resolution: "preserve-consolidated",
    };
  }

  return {
    diagnostics,
    groups: null,
    reason: "use-repartitioned",
    resolution: "use-repartitioned",
  };
}

export function shouldRestoreDistinctDirectFileBaseline(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): boolean {
  const parsedCoveredSubjects = coveredGroups.map((coveredGroup) =>
    parseSubjectWords(
      coveredGroup.message.split("\n")[0] ?? coveredGroup.message,
    ),
  );
  if (isHomogeneousSupportFamily(parsedCoveredSubjects)) {
    return false;
  }

  const coveredSubjects = new Set(
    coveredGroups.map(
      (coveredGroup) =>
        coveredGroup.message.split("\n")[0] ?? coveredGroup.message,
    ),
  );
  if (coveredSubjects.size <= 1) {
    return false;
  }

  const consolidatedSubject = group.message.split("\n")[0] ?? group.message;
  if (coveredSubjects.has(consolidatedSubject)) {
    return false;
  }

  const rolloutShape = buildSurfaceRolloutShape(group.files);
  if (
    rolloutShape.entrypointLikeCount > 0 &&
    haveCompleteSubjectWordOverlap(parsedCoveredSubjects, 1, true)
  ) {
    return false;
  }

  return coveredGroups.every((coveredGroup) =>
    coveredGroup.files.every((file) => {
      const owner = getPathOwnerDescriptor(file.path);
      return isFeatureSurfacePath(file.path, owner);
    }),
  );
}

function collectCoveredBaselineFallbackSignals(
  coveredGroups: PlannedCommit[],
  repartitioned: PlannedCommit[],
  preserveShallowSurfaceRollout: boolean,
  getDominantGroupOwner: (group: PlannedCommit) => string,
): CoveredBaselineFallbackSignals {
  const hasRestoreCoveredBaselineSignal = shouldRestoreCoveredBaselineGroups(
    coveredGroups,
    getDominantGroupOwner,
  );

  return {
    coveredGroupCount: coveredGroups.length,
    hasCollapsedImplementationBundle:
      hasRestoreSignalForCollapsedImplementationBundle(
        coveredGroups,
        getDominantGroupOwner,
        repartitioned,
        hasRestoreCoveredBaselineSignal,
      ),
    hasDominantMegaRepartitionedGroup:
      hasRestoreSignalForDominantMegaRepartition(
        coveredGroups,
        repartitioned,
        hasRestoreCoveredBaselineSignal,
      ),
    hasRestoreCoveredBaselineSignal,
    preserveShallowSurfaceRollout,
    repartitionedGroupCount: repartitioned.length,
    shouldPreserveIdenticalRepartitionedRollout:
      shouldPreserveIdenticalRollout(repartitioned),
  };
}

function hasRestoreSignalForCollapsedImplementationBundle(
  coveredGroups: PlannedCommit[],
  getDominantGroupOwner: (group: PlannedCommit) => string,
  repartitioned: PlannedCommit[],
  hasRestoreCoveredBaselineSignal: boolean,
): boolean {
  const coveredImplementationGroups = coveredGroups.filter(
    (group) => !isSupportLikeGroup(group),
  );
  const coveredImplementationOwners = new Set(
    coveredImplementationGroups.map(getDominantGroupOwner).filter(Boolean),
  );
  const repartitionedImplementationGroups = repartitioned.filter(
    (group) => !isSupportLikeGroup(group),
  );
  if (
    !hasRestoreCoveredBaselineSignal ||
    coveredImplementationOwners.size < 3 ||
    repartitionedImplementationGroups.length >=
      coveredImplementationGroups.length
  ) {
    return false;
  }

  const largestCoveredImplementationGroupSize = Math.max(
    ...coveredImplementationGroups.map(
      (coveredGroup) => coveredGroup.files.length,
    ),
  );

  return repartitionedImplementationGroups.some((group) => {
    const rolloutShape = buildSurfaceRolloutShape(group.files);
    if (
      rolloutShape.entrypointLikeCount > 0 ||
      group.files.length <= largestCoveredImplementationGroupSize
    ) {
      return false;
    }

    const absorbedImplementationOwners = new Set(
      coveredImplementationGroups
        .filter((coveredGroup) =>
          coveredGroup.files.some((coveredFile) =>
            group.files.some(
              (repartitionedFile) =>
                repartitionedFile.path === coveredFile.path,
            ),
          ),
        )
        .map(getDominantGroupOwner)
        .filter(Boolean),
    );

    return absorbedImplementationOwners.size >= 3;
  });
}

function hasRestoreSignalForDominantMegaRepartition(
  coveredGroups: PlannedCommit[],
  repartitioned: PlannedCommit[],
  hasRestoreCoveredBaselineSignal: boolean,
): boolean {
  if (!hasRestoreCoveredBaselineSignal || repartitioned.length <= 1) {
    return false;
  }

  if (coveredGroups.length < repartitioned.length * 3) {
    return false;
  }

  const totalFileCount = repartitioned.reduce(
    (count, repartitionedGroup) => count + repartitionedGroup.files.length,
    0,
  );
  const dominantFileCount = Math.max(
    ...repartitioned.map(
      (repartitionedGroup) => repartitionedGroup.files.length,
    ),
  );

  return dominantFileCount >= totalFileCount - (repartitioned.length - 1);
}

function hasStructuredSupportBuckets(
  groups: PlannedCommit[],
  subjects: ReturnType<typeof parseSubjectWords>[],
): boolean {
  const supportType = subjects[0]?.type ?? "";

  return (
    (supportType === "style" || supportType === "test") &&
    groups.length >= 3 &&
    groups.some((group) => group.files.length > 1)
  );
}

function hasUnifiedImplementationFeatureRoot(
  coveredGroups: PlannedCommit[],
  coveredSubjects: ReturnType<typeof parseSubjectWords>[],
): boolean {
  if (
    coveredGroups.length === 0 ||
    coveredSubjects.length !== coveredGroups.length
  ) {
    return false;
  }

  const featureRoots = new Set<string>();

  for (let index = 0; index < coveredGroups.length; index++) {
    const subject = coveredSubjects[index];
    const coveredGroup = coveredGroups[index];
    if (isSupportLikeType(subject.type)) {
      return false;
    }

    for (const file of coveredGroup.files) {
      featureRoots.add(getStructuralFeatureBoundary(file.path).featureRoot);
      if (featureRoots.size > 1) {
        return false;
      }
    }
  }

  return featureRoots.size === 1;
}

function haveUniformTypeAndScope(
  subjects: ReturnType<typeof parseSubjectWords>[],
): boolean {
  if (subjects.length === 0) {
    return false;
  }

  const first = subjects[0];

  return subjects.every(
    (subject) => subject.type === first.type && subject.scope === first.scope,
  );
}

function isHomogeneousSupportFamily(
  subjects: ReturnType<typeof parseSubjectWords>[],
): boolean {
  return (
    subjects.length > 0 &&
    subjects.every(
      (subject) =>
        subject.type === subjects[0]?.type && isSupportLikeType(subject.type),
    )
  );
}

function isSupportLikeGroup(group: PlannedCommit): boolean {
  const subject = parseSubjectWords(
    group.message.split("\n")[0] ?? group.message,
  );
  return isSupportLikeType(subject.type);
}

function shouldRestoreBroadStructuralBaseline(
  coveredGroups: PlannedCommit[],
): boolean {
  return hasBroadDeepStructuralFanout(coveredGroups);
}

function shouldRestoreCoveredBaselineAfterRepartition(
  hasCollapsedImplementationBundle: boolean,
  hasDominantMegaRepartitionedGroup: boolean,
  hasRestoreCoveredBaselineSignal: boolean,
  preserveShallowSurfaceRollout: boolean,
  repartitionedGroupCount: number,
): boolean {
  if (preserveShallowSurfaceRollout) {
    return false;
  }

  return (
    (repartitionedGroupCount <= 1 && hasRestoreCoveredBaselineSignal) ||
    hasCollapsedImplementationBundle ||
    hasDominantMegaRepartitionedGroup
  );
}

function shouldRestoreCoveredBaselineGroups(
  coveredGroups: PlannedCommit[],
  getDominantGroupOwner: (group: PlannedCommit) => string,
): boolean {
  const coveredSubjects = coveredGroups.map((group) =>
    parseSubjectWords(group.message.split("\n")[0] ?? group.message),
  );
  const subjectLines = new Set(
    coveredGroups.map((group) => group.message.split("\n")[0] ?? group.message),
  );
  if (shouldRestoreBroadStructuralBaseline(coveredGroups)) {
    return true;
  }
  if (subjectLines.size <= 1) {
    return false;
  }

  const subjectsHaveOneRolloutNarrative = haveCompleteSubjectWordOverlap(
    coveredSubjects,
    1,
    true,
  );
  const sameSupportFamily = isHomogeneousSupportFamily(coveredSubjects);
  if (
    sameSupportFamily &&
    hasStructuredSupportBuckets(coveredGroups, coveredSubjects)
  ) {
    return true;
  }

  if (
    !subjectsHaveOneRolloutNarrative &&
    !sameSupportFamily &&
    !haveUniformTypeAndScope(coveredSubjects)
  ) {
    return true;
  }

  const allDirectFileGroups = coveredGroups.every((group) =>
    group.files.every(
      (file) => getPathOwnerDescriptor(file.path).kind === "direct-file",
    ),
  );
  const dominantOwners = new Set(
    coveredGroups.map((group) => getDominantGroupOwner(group)),
  );
  return shouldRestoreOwnerDivergentBaseline(
    coveredGroups,
    coveredSubjects,
    subjectsHaveOneRolloutNarrative,
    sameSupportFamily,
    dominantOwners,
    allDirectFileGroups,
  );
}

function shouldRestoreOwnerDivergentBaseline(
  coveredGroups: PlannedCommit[],
  coveredSubjects: ReturnType<typeof parseSubjectWords>[],
  subjectsHaveOneRolloutNarrative: boolean,
  sameSupportFamily: boolean,
  dominantOwners: Set<string>,
  allDirectFileGroups: boolean,
): boolean {
  const preservesUnifiedDirectFileRollout =
    allDirectFileGroups &&
    subjectsHaveOneRolloutNarrative &&
    hasUnifiedImplementationFeatureRoot(coveredGroups, coveredSubjects);

  return (
    !sameSupportFamily &&
    !preservesUnifiedDirectFileRollout &&
    ((dominantOwners.size > 1 && !dominantOwners.has("root")) ||
      allDirectFileGroups)
  );
}
