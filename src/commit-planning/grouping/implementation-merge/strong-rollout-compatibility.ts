import { type PlannedCommit } from "../grouping-types.js";
import { getPathOwnerDescriptor } from "../ownership.js";
import { hasHighWordOverlap, isSupportLikeType } from "../subject/analysis.js";

export function hasCompatibleRolloutOwnership(
  left: PlannedCommit,
  right: PlannedCommit,
): boolean {
  const nonRootRoots = [
    ...new Set([
      ...left.files.map(
        (file) => getPathOwnerDescriptor(file.path).featureRoot,
      ),
      ...right.files.map(
        (file) => getPathOwnerDescriptor(file.path).featureRoot,
      ),
    ]),
  ].filter((root) => root !== "root");

  if (nonRootRoots.length <= 1) {
    return true;
  }

  return nonRootRoots.some((candidateRoot) =>
    nonRootRoots.every(
      (root) => root === candidateRoot || root.startsWith(`${candidateRoot}/`),
    ),
  );
}

export function hasStrongRolloutSignalMetadata(input: {
  broaderGroupSupported: boolean;
  hasRelatedScopes: boolean;
  leftType: string;
  leftWords: Set<string>;
  rightType: string;
  rightWords: Set<string>;
  sharedIntentScore: number;
  sharedWordCount: number;
}): boolean {
  return (
    hasCompatibleScopeMetadata(input) &&
    input.broaderGroupSupported &&
    hasCompatibleImplementationTypes(input.leftType, input.rightType) &&
    input.sharedWordCount >= 6 &&
    input.sharedIntentScore >= 6 &&
    hasHighWordOverlap(input.leftWords, input.rightWords)
  );
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

function hasCompatibleScopeMetadata(input: {
  hasRelatedScopes: boolean;
  leftType: string;
  rightType: string;
}): boolean {
  return (
    input.hasRelatedScopes ||
    input.leftType.length === 0 ||
    input.rightType.length === 0
  );
}
