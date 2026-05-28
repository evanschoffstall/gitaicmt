import { type PlannedCommit } from "../grouping-types.js";
import { getPathOwnerDescriptor } from "../ownership.js";
import { parseSubjectWords } from "../subject/analysis.js";
import {
  getOwnershipRoots,
  groupsShareFeatureRoot,
  hasFeatureSurfaceFiles,
  hasRelatedScopes,
  hasSharedOwnershipRoot,
  hasStrongSharedRolloutMerge,
} from "./rollout-signal.js";

export {
  hasRelatedScopes,
  hasSameFeatureRootRolloutMerge,
  hasStrongSharedRolloutMerge,
} from "./rollout-signal.js";

interface ImplementationMergeSignal {
  dependencyScore: number;
  distinctActionScore: number;
  distinctArtifactScore: number;
  hasDependencySignal: boolean;
  leftSubject: ReturnType<typeof parseSubjectWords>;
  rightSubject: ReturnType<typeof parseSubjectWords>;
  sharedIntentScore: number;
  sharedWordCount: number;
}

/**
 * Reject merges that would smear one commit across too many unrelated ownership roots.
 * Tightened to prevent planner-wide mega-rollouts.
 */
export function shouldRejectBroadOwnershipMerge(
  left: PlannedCommit,
  right: PlannedCommit,
  mergeSignal: Pick<
    ImplementationMergeSignal,
    | "hasDependencySignal"
    | "leftSubject"
    | "rightSubject"
    | "sharedIntentScore"
    | "sharedWordCount"
  >,
): boolean {
  if (hasStrongSharedRolloutMerge(left, right, mergeSignal)) {
    return false;
  }

  const leftRoots = getOwnershipRoots(left);
  const rightRoots = getOwnershipRoots(right);
  const combinedRoots = new Set([...leftRoots, ...rightRoots]);

  if (combinedRoots.size < 2 || hasSharedOwnershipRoot(leftRoots, rightRoots)) {
    return false;
  }

  // Allow same-feature rollouts only when at least one side touches the feature
  // surface directly (not when both sides are deep nested subsystems).
  // This prevents broad umbrella merges like prompts + grouping + path that all
  // sit under one feature root and happen to share dependency signals and scopes.
  if (
    groupsShareFeatureRoot(left, right) &&
    mergeSignal.hasDependencySignal &&
    hasRelatedScopes(mergeSignal) &&
    (hasFeatureSurfaceFiles(left) || hasFeatureSurfaceFiles(right))
  ) {
    return false;
  }

  return true;
}

/**
 * Reject broad umbrella merges that span unrelated ownership roots without a strong rollout signal.
 * Tightened to prevent planner-wide umbrellas from forming.
 */
export function shouldRejectCrossDomainUmbrellaMerge(
  left: PlannedCommit,
  right: PlannedCommit,
  mergeSignal: Pick<
    ImplementationMergeSignal,
    | "dependencyScore"
    | "hasDependencySignal"
    | "leftSubject"
    | "rightSubject"
    | "sharedIntentScore"
    | "sharedWordCount"
  >,
): boolean {
  // Allow when there's a strong dependency or rollout signal
  if (shouldAllowCrossDomainMerge(left, right, mergeSignal)) {
    return false;
  }

  const leftRoots = getOwnershipRoots(left);
  const rightRoots = getOwnershipRoots(right);
  const hasSharedRoot = hasSharedOwnershipRoot(leftRoots, rightRoots);
  const sharesFeatureRoot = groupsShareFeatureRoot(left, right);

  // Allow when ownership roots aren't meaningful or overlap
  if (leftRoots.size === 0 || rightRoots.size === 0 || hasSharedRoot) {
    return false;
  }

  // Always reject when crossing feature roots without strong signals
  if (!sharesFeatureRoot) {
    return true;
  }

  // Within same feature root, reject mixed owner kinds without related scopes
  if (!hasFeatureSurfaceFiles(left) && !hasFeatureSurfaceFiles(right)) {
    return true;
  }

  return (
    hasMixedFeatureOwnerKinds(left, right) && !hasRelatedScopes(mergeSignal)
  );
}

/** Reject merges that are connected only by dependency pressure without shared action or artifact value. */
export function shouldRejectDependencyOnlyMerge(
  mergeSignal: Pick<
    ImplementationMergeSignal,
    "dependencyScore" | "distinctActionScore" | "distinctArtifactScore"
  >,
): boolean {
  return (
    mergeSignal.dependencyScore >= 4 &&
    mergeSignal.distinctActionScore === 0 &&
    mergeSignal.distinctArtifactScore === 0
  );
}

function hasMixedFeatureOwnerKinds(
  left: PlannedCommit,
  right: PlannedCommit,
): boolean {
  const leftDescriptors = left.files.map((file) =>
    getPathOwnerDescriptor(file.path),
  );
  const rightDescriptors = right.files.map((file) =>
    getPathOwnerDescriptor(file.path),
  );

  return leftDescriptors.some((leftDescriptor) =>
    rightDescriptors.some(
      (rightDescriptor) =>
        leftDescriptor.featureRoot === rightDescriptor.featureRoot &&
        leftDescriptor.kind !== rightDescriptor.kind &&
        leftDescriptor.kind !== "other" &&
        rightDescriptor.kind !== "other",
    ),
  );
}

/** Allow cross-domain merge when there are strong dependency or rollout signals. */
function shouldAllowCrossDomainMerge(
  left: PlannedCommit,
  right: PlannedCommit,
  mergeSignal: Pick<
    ImplementationMergeSignal,
    | "dependencyScore"
    | "hasDependencySignal"
    | "leftSubject"
    | "rightSubject"
    | "sharedIntentScore"
    | "sharedWordCount"
  >,
): boolean {
  // A bare dependency signal is insufficient for cross-domain merges because
  // modules that import each other are not necessarily the same logical change.
  // Require either strong rollout vocabulary alignment or very high coupling.
  if (hasStrongSharedRolloutMerge(left, right, mergeSignal)) {
    return true;
  }

  if (mergeSignal.dependencyScore < 6) {
    return false;
  }

  if (
    !groupsShareFeatureRoot(left, right) &&
    (left.files.length > 3 || right.files.length > 3)
  ) {
    return hasRelatedScopes(mergeSignal) && mergeSignal.sharedWordCount >= 2;
  }

  return true;
}
