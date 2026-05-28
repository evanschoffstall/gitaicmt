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

export interface CoveredBaselineFallbackEvaluation {
  diagnostics: {
    coveredGroupCount: number;
    hasRestoreCoveredBaselineSignal: boolean;
    preserveShallowSurfaceRollout: boolean;
    repartitionedGroupCount: number;
    shouldPreserveIdenticalRepartitionedRollout: boolean;
  };
  groups: null | PlannedCommit[];
  reason:
    | "preserve-shallow-surface-rollout"
    | "repartition-collapsed-without-restore-signal"
    | "repartitioned-identical-rollout"
    | "restore-covered-baseline"
    | "use-repartitioned";
  resolution:
    | "preserve-consolidated"
    | "restore-covered-baseline"
    | "use-repartitioned";
}

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
  const hasRestoreCoveredBaselineSignal = shouldRestoreCoveredBaselineGroups(
    coveredGroups,
    getDominantGroupOwner,
  );
  const shouldPreserveIdenticalRepartitionedRollout =
    shouldPreserveIdenticalRollout(repartitioned);
  const diagnostics = buildCoveredBaselineFallbackDiagnostics(
    coveredGroups.length,
    hasRestoreCoveredBaselineSignal,
    preserveShallowSurfaceRollout,
    repartitioned.length,
    shouldPreserveIdenticalRepartitionedRollout,
  );

  if (
    repartitioned.length <= 1 &&
    hasRestoreCoveredBaselineSignal &&
    !preserveShallowSurfaceRollout
  ) {
    return {
      diagnostics,
      groups: coveredGroups,
      reason: "restore-covered-baseline",
      resolution: "restore-covered-baseline",
    };
  }

  if (
    repartitioned.length <= 1 ||
    shouldPreserveIdenticalRepartitionedRollout ||
    preserveShallowSurfaceRollout
  ) {
    return {
      diagnostics,
      groups: [group],
      reason: preserveShallowSurfaceRollout
        ? "preserve-shallow-surface-rollout"
        : shouldPreserveIdenticalRepartitionedRollout
          ? "repartitioned-identical-rollout"
          : "repartition-collapsed-without-restore-signal",
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

function buildCoveredBaselineFallbackDiagnostics(
  coveredGroupCount: number,
  hasRestoreCoveredBaselineSignal: boolean,
  preserveShallowSurfaceRollout: boolean,
  repartitionedGroupCount: number,
  shouldPreserveIdenticalRepartitionedRollout: boolean,
): CoveredBaselineFallbackEvaluation["diagnostics"] {
  return {
    coveredGroupCount,
    hasRestoreCoveredBaselineSignal,
    preserveShallowSurfaceRollout,
    repartitionedGroupCount,
    shouldPreserveIdenticalRepartitionedRollout,
  };
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

function shouldRestoreBroadStructuralBaseline(
  coveredGroups: PlannedCommit[],
): boolean {
  return hasBroadDeepStructuralFanout(coveredGroups);
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
    sameSupportFamily,
    dominantOwners,
    allDirectFileGroups,
  );
}

function shouldRestoreOwnerDivergentBaseline(
  sameSupportFamily: boolean,
  dominantOwners: Set<string>,
  allDirectFileGroups: boolean,
): boolean {
  return (
    !sameSupportFamily &&
    ((dominantOwners.size > 1 && !dominantOwners.has("root")) ||
      allDirectFileGroups)
  );
}
