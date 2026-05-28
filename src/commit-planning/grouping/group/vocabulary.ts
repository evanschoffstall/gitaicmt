import type { PlannedCommit } from "../grouping-types.js";

export function messageMentionsUncoveredGroupVocabulary(
  message: string,
  coveredGroups: PlannedCommit[],
  originalGroups: PlannedCommit[],
): boolean {
  const coveredVocabulary = mergeVocabulary(coveredGroups);
  const leakedVocabulary = new Set<string>();

  for (const group of originalGroups) {
    if (coveredGroups.includes(group)) {
      continue;
    }

    for (const word of getMessageVocabulary(group.message)) {
      if (!coveredVocabulary.has(word)) {
        leakedVocabulary.add(word);
      }
    }
  }

  if (leakedVocabulary.size === 0) {
    return false;
  }

  const candidateVocabulary = getMessageVocabulary(message);
  let leakedMatchCount = 0;
  for (const word of leakedVocabulary) {
    if (candidateVocabulary.has(word)) {
      leakedMatchCount += 1;
    }
  }

  return leakedMatchCount >= 2;
}

export function messageOmitsCoveredGroupVocabulary(
  message: string,
  coveredGroups: PlannedCommit[],
): boolean {
  const candidateVocabulary = getMessageVocabulary(message);

  return coveredGroups.some((group, index) => {
    const otherVocabulary = mergeVocabulary(
      coveredGroups.filter((_, otherIndex) => otherIndex !== index),
    );
    const uniqueGroupVocabulary = [
      ...getMessageVocabulary(group.message),
    ].filter((word) => !otherVocabulary.has(word));

    return (
      uniqueGroupVocabulary.length > 0 &&
      uniqueGroupVocabulary.every((word) => !candidateVocabulary.has(word))
    );
  });
}

function getMessageVocabulary(message: string): Set<string> {
  return new Set(
    message
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{3,}/gu)
      ?.map((word) => word.replace(/^-+|-+$/gu, ""))
      .filter((word) => word.length >= 4) ?? [],
  );
}

function mergeVocabulary(groups: PlannedCommit[]): Set<string> {
  const vocabulary = new Set<string>();
  for (const group of groups) {
    for (const word of getMessageVocabulary(group.message)) {
      vocabulary.add(word);
    }
  }
  return vocabulary;
}
