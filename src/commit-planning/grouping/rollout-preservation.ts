import { posix as pathPosix } from "node:path";

import { type PlannedCommit } from "./grouping-types.js";
import { getPathOwnerDescriptor } from "./ownership.js";
import {
  hasBroadDeepStructuralFanout,
  isCompactDeepParentSurfaceRollout,
} from "./structural-fanout.js";
import {
  haveCompleteSubjectWordOverlap,
  isSupportLikeType,
  parseSubjectWords,
  scopesRelated,
} from "./subject/analysis.js";
import { buildSurfaceRolloutShape } from "./surface-rollout-shape.js";

/**
 * Keeps true same-rollout sibling slices together while rejecting broad
 * umbrella families that only share generic vocabulary.
 */
export function shouldPreserveIdenticalRollout(
  groups: PlannedCommit[],
): boolean {
  if (!hasSingleFeatureRoot(groups) || !hasCompatibleSubjectTypes(groups)) {
    return false;
  }

  if (hasBroadStructuralFanout(groups)) {
    return false;
  }

  const ownerIds = new Set(
    groups.flatMap((group) =>
      group.files.map((file) => getPathOwnerDescriptor(file.path).ownerId),
    ),
  );
  if (ownerIds.size > 4) {
    return false;
  }

  const subjects = groups.map((group) =>
    parseSubjectWords(group.message.split("\n")[0] ?? ""),
  );

  if (hasBroadParentScopeUmbrella(subjects)) {
    return false;
  }

  if (isParallelDirectFileRolloutFamily(groups, subjects)) {
    return true;
  }

  if (!hasCompatibleOwnerAnchorFamily(groups)) {
    return false;
  }

  if (hasDistinctOwnerScopedBuckets(groups)) {
    return false;
  }

  if (isCompactDeepParentSurfaceRollout(groups)) {
    return true;
  }

  return subjectsHaveCompleteOverlap(subjects);
}

function getIdenticalRolloutOwnerAnchor(group: PlannedCommit): null | string {
  const surfaceOwnerIds = [
    ...buildSurfaceRolloutShape(group.files).surfaceOwnerIds,
  ];

  if (surfaceOwnerIds.length === 1) {
    return surfaceOwnerIds[0] ?? null;
  }

  return group.files.length === 0
    ? null
    : getPathOwnerDescriptor(group.files[0]?.path ?? "").ownerId;
}

function getOwnerScopedRolloutBucketId(group: PlannedCommit): string {
  return [...buildSurfaceRolloutShape(group.files).surfaceOwnerIds]
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}

function hasBroadParentScopeUmbrella(
  subjects: ReturnType<typeof parseSubjectWords>[],
): boolean {
  const scopes = [
    ...new Set(subjects.map((subject) => subject.scope).filter(Boolean)),
  ];
  if (scopes.length < 3) {
    return false;
  }

  return scopes.some((scope) =>
    scopes.every(
      (candidate) => candidate === scope || scopesRelated(candidate, scope),
    ),
  );
}

function hasBroadStructuralFanout(groups: PlannedCommit[]): boolean {
  return hasBroadDeepStructuralFanout(groups);
}

function hasCompatibleOwnerAnchorFamily(groups: PlannedCommit[]): boolean {
  const ownerAnchors = groups
    .map(getIdenticalRolloutOwnerAnchor)
    .filter(
      (ownerId): ownerId is string => ownerId !== null && ownerId !== "root",
    );

  return ownerAnchors.length > 0 && hasNestedOwnerAnchorFamily(ownerAnchors);
}

function hasCompatibleSubjectTypes(groups: PlannedCommit[]): boolean {
  if (groups.length < 2) {
    return false;
  }

  const firstSubject = parseSubjectWords(
    groups[0].message.split("\n")[0] ?? "",
  );
  if (firstSubject.type.length === 0 || isSupportLikeType(firstSubject.type)) {
    return false;
  }

  for (let index = 1; index < groups.length; index++) {
    const subject = parseSubjectWords(
      groups[index].message.split("\n")[0] ?? "",
    );
    if (subject.type !== firstSubject.type) {
      return false;
    }
  }

  return true;
}

function hasDistinctOwnerScopedBuckets(groups: PlannedCommit[]): boolean {
  if (groups.length < 3) {
    return false;
  }

  return new Set(groups.map(getOwnerScopedRolloutBucketId)).size >= 3;
}

function hasNestedOwnerAnchorFamily(ownerAnchors: string[]): boolean {
  return ownerAnchors.some((candidateRoot) =>
    ownerAnchors.every(
      (ownerId) =>
        ownerId === candidateRoot || ownerId.startsWith(`${candidateRoot}/`),
    ),
  );
}

function hasSingleFeatureRoot(groups: PlannedCommit[]): boolean {
  const featureRoots = new Set(
    groups.flatMap((group) =>
      group.files.map((file) => getPathOwnerDescriptor(file.path).featureRoot),
    ),
  );

  return featureRoots.size === 1;
}

function isParallelDirectFileRolloutFamily(
  groups: PlannedCommit[],
  subjects: ReturnType<typeof parseSubjectWords>[],
): boolean {
  if (!subjectsHaveCompleteOverlap(subjects)) {
    return false;
  }

  const basenames = new Set<string>();

  for (const group of groups) {
    if (group.files.length !== 1) {
      return false;
    }

    const file = group.files[0];
    const owner = getPathOwnerDescriptor(file.path);
    if (owner.kind !== "direct-file" && owner.kind !== "nested-subtree") {
      return false;
    }

    basenames.add(pathPosix.basename(file.path));
  }

  return basenames.size === 1;
}

function subjectsHaveCompleteOverlap(
  subjects: ReturnType<typeof parseSubjectWords>[],
): boolean {
  return haveCompleteSubjectWordOverlap(subjects);
}
