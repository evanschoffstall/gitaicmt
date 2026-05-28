import { shouldPreserveFeatureSurfaceRollout } from "../group/rollout-preservation.js";
import { type PlannedCommit } from "../grouping-types.js";
import { getPathOwnerDescriptor, getPathOwnershipRoot } from "../ownership.js";
import {
  hasHighWordOverlap,
  isSupportLikeType,
  parseSubjectWords,
  scopesRelated,
} from "../subject/analysis.js";
import { isEntrypointLikeSurfacePath } from "../surface-rollout-shape.js";

interface RolloutMergeSignal {
  dependencyScore: number;
  leftSubject: ReturnType<typeof parseSubjectWords>;
  rightSubject: ReturnType<typeof parseSubjectWords>;
  sharedIntentScore: number;
  sharedWordCount: number;
}

export function getOwnershipRoots(group: PlannedCommit): Set<string> {
  return new Set(group.files.map((file) => getPathOwnershipRoot(file.path)));
}

export function groupsShareFeatureRoot(
  left: PlannedCommit,
  right: PlannedCommit,
): boolean {
  const leftFeatureRoots = new Set(
    left.files.map((file) => getPathOwnerDescriptor(file.path).featureRoot),
  );

  return right.files.some((file) =>
    leftFeatureRoots.has(getPathOwnerDescriptor(file.path).featureRoot),
  );
}

export function hasFeatureSurfaceFiles(group: PlannedCommit): boolean {
  return group.files.some(
    (file) => getPathOwnerDescriptor(file.path).kind === "direct-file",
  );
}

export function hasRelatedScopes(mergeSignal: {
  leftSubject: ReturnType<typeof parseSubjectWords>;
  rightSubject: ReturnType<typeof parseSubjectWords>;
}): boolean {
  return (
    mergeSignal.leftSubject.scope.length > 0 &&
    mergeSignal.rightSubject.scope.length > 0 &&
    scopesRelated(mergeSignal.leftSubject.scope, mergeSignal.rightSubject.scope)
  );
}

export function hasSameFeatureRootRolloutMerge(
  left: PlannedCommit,
  right: PlannedCommit,
  mergeSignal: Pick<
    RolloutMergeSignal,
    "leftSubject" | "rightSubject" | "sharedWordCount"
  >,
): boolean {
  const combinedRoots = new Set([
    ...getOwnershipRoots(left),
    ...getOwnershipRoots(right),
  ]);
  if (!isSameFeatureRolloutCandidate(left, right, combinedRoots, mergeSignal)) {
    return false;
  }

  const hasSharedWordOverlap = hasHighWordOverlap(
    mergeSignal.leftSubject.words,
    mergeSignal.rightSubject.words,
  );
  if (
    hasSameOwnerDirectSurfaceRollout(
      left,
      right,
      combinedRoots,
      mergeSignal.sharedWordCount,
    )
  ) {
    return true;
  }

  const hasShallowSurfaceSignal = hasShallowSurfaceRolloutSignal(
    left,
    right,
    combinedRoots,
    mergeSignal.sharedWordCount,
    hasSharedWordOverlap,
  );
  return hasShallowSurfaceSignal
    ? hasScopeCompatibleSurfaceRollout(left, right, mergeSignal)
    : mergeSignal.sharedWordCount >= 3 && hasSharedWordOverlap;
}

export function hasSharedOwnershipRoot(
  leftRoots: Set<string>,
  rightRoots: Set<string>,
): boolean {
  for (const root of leftRoots) {
    if (rightRoots.has(root)) {
      return true;
    }
  }

  return false;
}

export function hasStrongSharedRolloutMerge(
  left: PlannedCommit,
  right: PlannedCommit,
  mergeSignal: Pick<
    RolloutMergeSignal,
    "leftSubject" | "rightSubject" | "sharedIntentScore" | "sharedWordCount"
  >,
): boolean {
  const broaderGroup = getBroaderScopeGroup(left, right, mergeSignal);

  return (
    hasLimitedSameFeatureRolloutStructure(left, right) &&
    (hasRelatedScopes(mergeSignal) ||
      mergeSignal.leftSubject.scope.length === 0 ||
      mergeSignal.rightSubject.scope.length === 0) &&
    (broaderGroup === null || hasEntrypointLikeSurfaceGroup(broaderGroup)) &&
    hasCompatibleImplementationTypes(
      mergeSignal.leftSubject.type,
      mergeSignal.rightSubject.type,
    ) &&
    mergeSignal.sharedWordCount >= 6 &&
    mergeSignal.sharedIntentScore >= 6 &&
    hasHighWordOverlap(
      mergeSignal.leftSubject.words,
      mergeSignal.rightSubject.words,
    )
  );
}

function getBroaderScopeGroup(
  left: PlannedCommit,
  right: PlannedCommit,
  mergeSignal: Pick<RolloutMergeSignal, "leftSubject" | "rightSubject">,
): null | PlannedCommit {
  const { leftSubject, rightSubject } = mergeSignal;
  if (
    leftSubject.scope.length === 0 ||
    rightSubject.scope.length === 0 ||
    leftSubject.scope === rightSubject.scope
  ) {
    return null;
  }

  if (leftSubject.scope.includes(rightSubject.scope)) {
    return right;
  }

  if (rightSubject.scope.includes(leftSubject.scope)) {
    return left;
  }

  return null;
}

function hasCompatibleImplementationTypes(
  leftType: string,
  rightType: string,
): boolean {
  return (
    leftType !== "" &&
    rightType !== "" &&
    !isSupportLikeType(leftType) &&
    !isSupportLikeType(rightType)
  );
}

function hasEntrypointLikeSurfaceGroup(group: PlannedCommit): boolean {
  return group.files.some((file) => isEntrypointLikeSurfacePath(file.path));
}

function hasLimitedSameFeatureRolloutStructure(
  left: PlannedCommit,
  right: PlannedCommit,
): boolean {
  if (
    left.files.every(
      (file) => getPathOwnerDescriptor(file.path).kind === "direct-file",
    ) &&
    right.files.every(
      (file) => getPathOwnerDescriptor(file.path).kind === "direct-file",
    )
  ) {
    return true;
  }

  const leftSubject = parseSubjectWords(left.message.split("\n")[0] ?? "");
  const messageSource =
    leftSubject.type.length > 0 && !isSupportLikeType(leftSubject.type)
      ? left.message
      : right.message;

  return shouldPreserveFeatureSurfaceRollout({
    files: [...left.files, ...right.files],
    message: messageSource,
  });
}

function hasSameOwnerDirectSurfaceRollout(
  left: PlannedCommit,
  right: PlannedCommit,
  combinedRoots: Set<string>,
  sharedWordCount: number,
): boolean {
  return (
    combinedRoots.size === 1 &&
    hasFeatureSurfaceFiles(left) &&
    hasFeatureSurfaceFiles(right) &&
    sharedWordCount >= 2
  );
}

function hasScopeCompatibleSurfaceRollout(
  left: PlannedCommit,
  right: PlannedCommit,
  mergeSignal: Pick<RolloutMergeSignal, "leftSubject" | "rightSubject">,
): boolean {
  if (!hasRelatedScopes(mergeSignal)) {
    return false;
  }

  const broaderGroup = getBroaderScopeGroup(left, right, mergeSignal);
  return broaderGroup === null || hasEntrypointLikeSurfaceGroup(broaderGroup);
}

function hasShallowSurfaceRolloutSignal(
  left: PlannedCommit,
  right: PlannedCommit,
  combinedRoots: Set<string>,
  sharedWordCount: number,
  hasSharedWordOverlap: boolean,
): boolean {
  return (
    combinedRoots.size <= 2 &&
    (hasFeatureSurfaceFiles(left) || hasFeatureSurfaceFiles(right)) &&
    sharedWordCount >= 1 &&
    hasSharedWordOverlap
  );
}

function isSameFeatureRolloutCandidate(
  left: PlannedCommit,
  right: PlannedCommit,
  combinedRoots: Set<string>,
  mergeSignal: Pick<
    RolloutMergeSignal,
    "leftSubject" | "rightSubject" | "sharedWordCount"
  >,
): boolean {
  return (
    groupsShareFeatureRoot(left, right) &&
    hasLimitedSameFeatureRolloutStructure(left, right) &&
    combinedRoots.size < 4 &&
    hasCompatibleImplementationTypes(
      mergeSignal.leftSubject.type,
      mergeSignal.rightSubject.type,
    )
  );
}
