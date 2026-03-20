import {
  parseConventionalSubject,
  sanitizeSubjectWords,
} from "../../commit-messages/subject-parser.js";
import {
  groupsShareCoverage,
  groupsSharePaths,
} from "./commit-coverage.js";
import { type PlannedCommit, type SubjectWords } from "./grouping-types.js";

/** Stop words are excluded so merge heuristics stay anchored on intent. */
const STOP_WORDS = new Set([
  "a",
  "across",
  "all",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "no",
  "not",
  "of",
  "on",
  "or",
  "the",
  "to",
  "up",
  "via",
  "with",
]);

/** Counts subject overlap using the planner's relaxed word-related rule. */
export function countSharedSubjectWords(
  left: Set<string>,
  right: Set<string>,
): number {
  let count = 0;

  for (const leftWord of left) {
    for (const rightWord of right) {
      if (wordsRelated(leftWord, rightWord)) {
        count++;
        break;
      }
    }
  }

  return count;
}

/** Filters raw words down to significant planner vocabulary. */
export function filterSignificantWords(
  words: string[],
  minimumLength = 3,
): string[] {
  return words.filter(
    (word) => word.length >= minimumLength && !STOP_WORDS.has(word),
  );
}

/**
 * Returns specific file-family labels touched by a commit so support work only
 * pulls toward nearby implementation changes.
 */
export function getCommitAreas(group: PlannedCommit): Set<string> {
  const areas = new Set<string>();

  for (const file of group.files) {
    for (const area of getPathAreas(file.path)) {
      areas.add(area);
    }
  }

  return areas;
}

/**
 * Returns ordered significant subject words so the first word can act as the
 * primary action.
 */
export function getOrderedSubjectWords(subject: string): string[] {
  const parsed = parseConventionalSubject(subject);
  return filterSignificantWords(sanitizeSubjectWords(parsed.description));
}

/** True when at least half of the shorter set overlaps with the longer one. */
export function hasHighWordOverlap(
  left: Set<string>,
  right: Set<string>,
): boolean {
  if (left.size < 2 || right.size < 2) {
    return false;
  }

  return (
    countSharedSubjectWords(left, right) / Math.min(left.size, right.size) >=
    0.5
  );
}

/**
 * Fast precheck that decides whether AI clustering or consolidation is worth
 * attempting at all.
 */
export function hasPotentialMergeSignals(groups: PlannedCommit[]): boolean {
  if (groups.length < 2) {
    return false;
  }

  const subjects = groups.map((group) =>
    parseSubjectWords(group.message.split("\n")[0] ?? ""),
  );
  const areas = groups.map((group) => getCommitAreas(group));

  for (let leftIndex = 0; leftIndex < groups.length; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < groups.length;
      rightIndex++
    ) {
      if (groupsShareCoverage(groups[leftIndex], groups[rightIndex])) {
        return true;
      }

      if (
        subjects[leftIndex].scope &&
        subjects[leftIndex].scope === subjects[rightIndex].scope
      ) {
        return true;
      }

      if (
        groupsSharePaths(groups[leftIndex], groups[rightIndex]) &&
        hasSharedPathMergeSignal(subjects[leftIndex], subjects[rightIndex])
      ) {
        return true;
      }

      if (
        hasHighWordOverlap(subjects[leftIndex].words, subjects[rightIndex].words)
      ) {
        return true;
      }

      if (
        isSupportLikeType(subjects[leftIndex].type) ||
        isSupportLikeType(subjects[rightIndex].type)
      ) {
        for (const area of areas[leftIndex]) {
          if (areas[rightIndex].has(area)) {
            return true;
          }
        }

        if (
          groupsShareFeatureDirectory(
            groups[leftIndex],
            groups[rightIndex],
          )
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

/** Support-like types should attach to implementation work, not drive it. */
export function isSupportLikeType(type: string): boolean {
  return (
    type === "chore" || type === "docs" || type === "style" || type === "test"
  );
}

/** Extract conventional-commit subject metadata for planner heuristics. */
export function parseSubjectWords(subject: string): SubjectWords {
  const parsed = parseConventionalSubject(subject);
  return {
    scope: parsed.scope,
    type: parsed.type,
    words: new Set(
      filterSignificantWords(sanitizeSubjectWords(parsed.description)),
    ),
  };
}

/**
 * Two scopes are related when one contains the other as a substring, which
 * treats `ui/dialog` as related to `ui` without requiring an exact match.
 */
export function scopesRelated(left: string, right: string): boolean {
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * Two words are related when one is a stable prefix of the other, which keeps
 * common inflections grouped without hardcoded stemming logic.
 */
export function wordsRelated(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  if (left.length < 4 || right.length < 4) {
    return false;
  }

  const [shorter, longer] =
    left.length <= right.length ? [left, right] : [right, left];
  return longer.startsWith(shorter);
}

/** Counts shared leading directory segments between two file paths. */
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

/** Returns directory segments without the file name for feature-family checks. */
function getDirectorySegments(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(0, -1);
}

/**
 * Path areas stay close to the owning directory or file stem so shared `src`
 * or `tests` folders alone do not trigger merge review.
 */
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

/**
 * Shared feature-family prefixes must be deeper than broad buckets like `src`
 * or `src/commit-planning` before they count as support merge evidence.
 */
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

/** Same-file disjoint hunks are only merge-worthy when the subjects still align. */
function hasSharedPathMergeSignal(
  left: SubjectWords,
  right: SubjectWords,
): boolean {
  if (left.scope && right.scope && scopesRelated(left.scope, right.scope)) {
    return true;
  }

  if (hasHighWordOverlap(left.words, right.words)) {
    return true;
  }

  return isSupportLikeType(left.type) || isSupportLikeType(right.type);
}

/** Normalizes file stems so test suffixes do not block support matching. */
function normalizePathStem(basename: string): string {
  return basename
    .replace(/\.[^.]+$/u, "")
    .replace(/\.(test|spec)$/u, "")
    .replace(/^readme$/iu, "");
}