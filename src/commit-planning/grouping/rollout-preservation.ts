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

  if (isCompactDeepParentSurfaceRollout(groups)) {
    return true;
  }

  return subjectsHaveCompleteOverlap(subjects);
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

function hasSingleFeatureRoot(groups: PlannedCommit[]): boolean {
  const featureRoots = new Set(
    groups.flatMap((group) =>
      group.files.map((file) => getPathOwnerDescriptor(file.path).featureRoot),
    ),
  );

  return featureRoots.size === 1;
}

function subjectsHaveCompleteOverlap(
  subjects: ReturnType<typeof parseSubjectWords>[],
): boolean {
  return haveCompleteSubjectWordOverlap(subjects);
}
