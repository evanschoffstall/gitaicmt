import {
  parseConventionalSubject,
  sanitizeSubjectWords,
} from "../../../commit-messages/subject-parser.js";
import {
  groupsShareCoverage,
  groupsSharePaths,
} from "../commit-coverage.js";
import { type PlannedCommit, type SubjectWords } from "../grouping-types.js";
import { getCommitAreas, hasMergeSignalForPair } from "./path-areas.js";

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
      if (
        hasMergeSignalForPair(
          {
            leftAreas: areas[leftIndex],
            leftGroup: groups[leftIndex],
            leftSubject: subjects[leftIndex],
            rightAreas: areas[rightIndex],
            rightGroup: groups[rightIndex],
            rightSubject: subjects[rightIndex],
          },
          {
            groupsShareCoverage,
            groupsSharePaths,
            hasHighWordOverlap,
            isSupportLikeType,
            scopesRelated,
          },
        )
      ) {
        return true;
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
