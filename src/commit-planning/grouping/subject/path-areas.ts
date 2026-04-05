import type { PlannedCommit, SubjectWords } from "../grouping-types.js";

interface MergeSignalHelpers {
  groupsShareCoverage: (left: PlannedCommit, right: PlannedCommit) => boolean;
  groupsSharePaths: (left: PlannedCommit, right: PlannedCommit) => boolean;
  hasHighWordOverlap: (left: Set<string>, right: Set<string>) => boolean;
  isSupportLikeType: (type: string) => boolean;
  scopesRelated: (left: string, right: string) => boolean;
}

interface MergeSignalPair {
  leftAreas: Set<string>;
  leftGroup: PlannedCommit;
  leftSubject: SubjectWords;
  rightAreas: Set<string>;
  rightGroup: PlannedCommit;
  rightSubject: SubjectWords;
}

/** Returns specific file-family labels touched by a commit. */
export function getCommitAreas(group: PlannedCommit): Set<string> {
  const areas = new Set<string>();

  for (const file of group.files) {
    for (const area of getPathAreas(file.path)) {
      areas.add(area);
    }
  }

  return areas;
}

export function hasMergeSignalForPair(
  pair: MergeSignalPair,
  helpers: MergeSignalHelpers,
): boolean {
  return (
    helpers.groupsShareCoverage(pair.leftGroup, pair.rightGroup) ||
    hasExactScopeMatch(pair) ||
    (helpers.groupsSharePaths(pair.leftGroup, pair.rightGroup) &&
      hasSharedPathMergeSignal(pair.leftSubject, pair.rightSubject, helpers)) ||
    helpers.hasHighWordOverlap(pair.leftSubject.words, pair.rightSubject.words) ||
    hasSupportAreaMergeSignal(pair, helpers)
  );
}

function countSharedDirectorySegments(
  leftDirectories: string[],
  rightDirectories: string[],
): number {
  let sharedSegments = 0;

  while (
    sharedSegments < leftDirectories.length &&
    sharedSegments < rightDirectories.length &&
    leftDirectories[sharedSegments] === rightDirectories[sharedSegments]
  ) {
    sharedSegments++;
  }

  return sharedSegments;
}

function getDirectorySegments(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(0, -1);
}

function getPathAreas(path: string): Set<string> {
  const segments = path.split("/");
  if (segments.length < 2) {
    return new Set(["(root)"]);
  }

  const areas = new Set<string>();
  const directory = segments.at(-2);
  const basename = segments.at(-1) ?? "";
  const stem = normalizePathStem(basename);

  if (directory && directory !== "src" && directory !== "tests") {
    areas.add(directory);
  }
  if (stem.length > 0) {
    areas.add(stem);
  }

  return areas;
}

function groupsShareFeatureDirectory(
  left: PlannedCommit,
  right: PlannedCommit,
): boolean {
  for (const leftFile of left.files) {
    const leftDirectories = getDirectorySegments(leftFile.path);

    for (const rightFile of right.files) {
      if (
        countSharedDirectorySegments(
          leftDirectories,
          getDirectorySegments(rightFile.path),
        ) >= 3
      ) {
        return true;
      }
    }
  }

  return false;
}

function hasExactScopeMatch(pair: MergeSignalPair): boolean {
  return (
    pair.leftSubject.scope !== "" &&
    pair.leftSubject.scope === pair.rightSubject.scope
  );
}

function hasSharedPathMergeSignal(
  left: SubjectWords,
  right: SubjectWords,
  helpers: MergeSignalHelpers,
): boolean {
  if (left.scope && right.scope && helpers.scopesRelated(left.scope, right.scope)) {
    return true;
  }

  if (helpers.hasHighWordOverlap(left.words, right.words)) {
    return true;
  }

  return helpers.isSupportLikeType(left.type) || helpers.isSupportLikeType(right.type);
}

function hasSupportAreaMergeSignal(
  pair: MergeSignalPair,
  helpers: MergeSignalHelpers,
): boolean {
  if (
    !helpers.isSupportLikeType(pair.leftSubject.type) &&
    !helpers.isSupportLikeType(pair.rightSubject.type)
  ) {
    return false;
  }

  return (
    shareCommitArea(pair.leftAreas, pair.rightAreas) ||
    groupsShareFeatureDirectory(pair.leftGroup, pair.rightGroup)
  );
}

function normalizePathStem(basename: string): string {
  return basename
    .replace(/\.[^.]+$/u, "")
    .replace(/\.(test|spec)$/u, "")
    .replace(/^readme$/iu, "");
}

function shareCommitArea(leftAreas: Set<string>, rightAreas: Set<string>): boolean {
  for (const area of leftAreas) {
    if (rightAreas.has(area)) {
      return true;
    }
  }

  return false;
}