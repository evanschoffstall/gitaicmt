import { getMeaningfulPathWords } from "../../path/index.js";

export function addMeaningfulOwnershipWords(
  target: Set<string>,
  words: Iterable<string>,
): void {
  for (const word of words) {
    if (isMeaningfulOwnershipWord(word)) {
      target.add(word);
    }
  }
}

export function getMeaningfulOwnershipTokens(pathLikeValue: string): string[] {
  return getMeaningfulPathWords(pathLikeValue).filter((word) =>
    isMeaningfulOwnershipWord(word),
  );
}

function isMeaningfulOwnershipWord(word: string): boolean {
  return word.length >= 3;
}
