import { sanitizeSubjectWords } from "../../commit-messages/subject-parser.js";
import { type FileChangeSignals, type PlannedCommit } from "./grouping-types.js";
import {
  collectCommonWords,
  filterDistinctWords,
  getCommitActionWords,
  getCommitArtifactWords,
  getDistinctActionWords,
  getDistinctScore,
} from "./scoring-support.js";
import {
  countSharedSubjectWords,
  filterSignificantWords,
  hasHighWordOverlap,
  parseSubjectWords,
  scopesRelated,
} from "./subject/analysis.js";

/** Collects words that describe what a commit is doing and where. */
export function getCommitIntentWords(
  group: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): Set<string> {
  const intentWords = new Set<string>();
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");

  addSubjectIntentWords(intentWords, subject);
  addFileIntentWords(intentWords, group, fileSignals);

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
    filterDistinctWords(
      getCommitArtifactWords(group, fileSignals, getCommitIntentWords),
      commonIntentWords,
    ),
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
    filterDistinctWords(
      getCommitIntentWords(group, fileSignals),
      commonIntentWords,
    ),
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

function addFileIntentWords(
  intentWords: Set<string>,
  group: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): void {
  for (const file of group.files) {
    const signals = fileSignals.get(file.path);
    if (!signals || shouldSkipCoordinatorSignals(signals, group)) {
      continue;
    }

    addWords(intentWords, signals.pathWords);
    addWords(intentWords, signals.intentWords);
  }
}

function addSubjectIntentWords(
  intentWords: Set<string>,
  subject: ReturnType<typeof parseSubjectWords>,
): void {
  addWords(intentWords, subject.words);
  addWords(
    intentWords,
    filterSignificantWords(sanitizeSubjectWords(subject.scope)),
  );
}

function addWords(target: Set<string>, words: Iterable<string>): void {
  for (const word of words) {
    target.add(word);
  }
}

function shouldSkipCoordinatorSignals(
  signals: FileChangeSignals,
  group: PlannedCommit,
): boolean {
  return signals.isCoordinatorLike && group.files.length > 1;
}
