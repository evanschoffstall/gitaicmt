import { sanitizeSubjectWords } from "../../commit-messages/subject-parser.js";
import { type FileChangeSignals, type PlannedCommit } from "./grouping-types.js";
import {
  countSharedSubjectWords,
  filterSignificantWords,
  getOrderedSubjectWords,
  parseSubjectWords,
} from "./subject/analysis.js";

export function collectCommonWords(
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

export function filterDistinctWords(
  words: Set<string>,
  commonWords: Set<string>,
): Set<string> {
  return new Set([...words].filter((word) => !commonWords.has(word)));
}

export function getCommitActionWords(group: PlannedCommit): Set<string> {
  return new Set(
    getOrderedSubjectWords(group.message.split("\n")[0] ?? "").slice(0, 1),
  );
}

export function getCommitArtifactWords(
  group: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
  getCommitIntentWords: (
    group: PlannedCommit,
    fileSignals: Map<string, FileChangeSignals>,
  ) => Set<string>,
): Set<string> {
  const artifactWords = new Set<string>();
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
  const subjectWords = getOrderedSubjectWords(group.message.split("\n")[0] ?? "");
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

export function getDistinctActionWords(
  group: PlannedCommit,
  commonActionWords: Set<string>,
): Set<string> {
  return filterDistinctWords(getCommitActionWords(group), commonActionWords);
}

export function getDistinctScore(
  left: PlannedCommit,
  right: PlannedCommit,
  selectWords: (group: PlannedCommit) => Set<string>,
): number {
  return countSharedSubjectWords(selectWords(left), selectWords(right));
}