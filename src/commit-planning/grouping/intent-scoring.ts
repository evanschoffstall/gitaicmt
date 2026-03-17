import { sanitizeSubjectWords } from "../../commit-messages/subject-parser.js";
import { type FileChangeSignals, type PlannedCommit } from "./grouping-types.js";
import {
  countSharedSubjectWords,
  filterSignificantWords,
  getOrderedSubjectWords,
  hasHighWordOverlap,
  parseSubjectWords,
  scopesRelated,
} from "./subject-analysis.js";

/** Collects words that describe what a commit is doing and where. */
export function getCommitIntentWords(
  group: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): Set<string> {
  const intentWords = new Set<string>();
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");

  for (const word of subject.words) {
    intentWords.add(word);
  }
  for (const scopeWord of filterSignificantWords(
    sanitizeSubjectWords(subject.scope),
  )) {
    intentWords.add(scopeWord);
  }

  for (const file of group.files) {
    const signals = fileSignals.get(file.path);
    if (!signals) {
      continue;
    }

    if (signals.isCoordinatorLike && group.files.length > 1) {
      continue;
    }

    for (const word of signals.pathWords) {
      intentWords.add(word);
    }
    for (const word of signals.intentWords) {
      intentWords.add(word);
    }
  }

  return intentWords;
}

/** Finds common action vocabulary across implementation commits. */
export function getCommonActionWords(groups: PlannedCommit[]): Set<string> {
  return collectCommonWords(groups, 3, (group) => getCommitActionWords(group));
}

/** Finds common intent vocabulary that should not drive consolidation by itself. */
export function getCommonIntentWords(
  groups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
): Set<string> {
  return collectCommonWords(groups, 2, (group) =>
    getCommitIntentWords(group, fileSignals),
  );
}

/** Returns shared action overlap after stripping high-frequency action words. */
export function getDistinctActionScore(
  left: PlannedCommit,
  right: PlannedCommit,
  commonActionWords: Set<string>,
): number {
  return getDistinctScore(left, right, (group) =>
    getDistinctActionWords(group, commonActionWords),
  );
}

/** Returns shared artifact overlap after stripping high-frequency intent words. */
export function getDistinctArtifactScore(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
  commonIntentWords: Set<string>,
): number {
  return getDistinctScore(left, right, (group) =>
    getDistinctArtifactWords(group, fileSignals, commonIntentWords),
  );
}

/** Returns shared intent overlap after stripping common planner vocabulary. */
export function getDistinctIntentScore(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
  commonIntentWords: Set<string>,
): number {
  return getDistinctScore(left, right, (group) =>
    getDistinctIntentWords(group, fileSignals, commonIntentWords),
  );
}

/** Scores shared intent between commits, including scope affinity. */
export function getSharedIntentScore(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): number {
  const leftIntentWords = getCommitIntentWords(left, fileSignals);
  const rightIntentWords = getCommitIntentWords(right, fileSignals);
  const leftSubject = parseSubjectWords(left.message.split("\n")[0] ?? "");
  const rightSubject = parseSubjectWords(right.message.split("\n")[0] ?? "");

  let score = countSharedSubjectWords(leftIntentWords, rightIntentWords);

  if (
    leftSubject.scope !== "" &&
    rightSubject.scope !== "" &&
    scopesRelated(leftSubject.scope, rightSubject.scope)
  ) {
    score += 2;
  }

  if (hasHighWordOverlap(leftSubject.words, rightSubject.words)) {
    score += 2;
  }

  return score;
}

function collectCommonWords(
  groups: PlannedCommit[],
  minimumCount: number,
  selectWords: (group: PlannedCommit) => Set<string>,
): Set<string> {
  const counts = new Map<string, number>();

  for (const group of groups) {
    for (const word of selectWords(group)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  const commonWords = new Set<string>();
  for (const [word, count] of counts) {
    if (count >= minimumCount) {
      commonWords.add(word);
    }
  }

  return commonWords;
}

/** Treat the first significant subject word as the commit's primary action. */
function getCommitActionWords(group: PlannedCommit): Set<string> {
  return new Set(
    getOrderedSubjectWords(group.message.split("\n")[0] ?? "").slice(0, 1),
  );
}

/** Collects artifact words from subject, scope, and file-level intent. */
function getCommitArtifactWords(
  group: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): Set<string> {
  const artifactWords = new Set<string>();
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
  const subjectWords = getOrderedSubjectWords(
    group.message.split("\n")[0] ?? "",
  );
  const actionWords = getCommitActionWords(group);

  for (const word of subjectWords) {
    if (!actionWords.has(word)) {
      artifactWords.add(word);
    }
  }

  for (const scopeWord of filterSignificantWords(
    sanitizeSubjectWords(subject.scope),
  )) {
    artifactWords.add(scopeWord);
  }

  for (const word of getCommitIntentWords(group, fileSignals)) {
    if (!actionWords.has(word)) {
      artifactWords.add(word);
    }
  }

  return artifactWords;
}

function getDistinctActionWords(
  group: PlannedCommit,
  commonActionWords: Set<string>,
): Set<string> {
  return new Set(
    [...getCommitActionWords(group)].filter(
      (word) => !commonActionWords.has(word),
    ),
  );
}

function getDistinctArtifactWords(
  group: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
  commonIntentWords: Set<string>,
): Set<string> {
  return new Set(
    [...getCommitArtifactWords(group, fileSignals)].filter(
      (word) => !commonIntentWords.has(word),
    ),
  );
}

function getDistinctIntentWords(
  group: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
  commonIntentWords: Set<string>,
): Set<string> {
  return new Set(
    [...getCommitIntentWords(group, fileSignals)].filter(
      (word) => !commonIntentWords.has(word),
    ),
  );
}

function getDistinctScore(
  left: PlannedCommit,
  right: PlannedCommit,
  selectWords: (group: PlannedCommit) => Set<string>,
): number {
  return countSharedSubjectWords(selectWords(left), selectWords(right));
}
