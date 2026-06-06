import { type PlannedCommit } from "../../grouping-types.js";
import { countSharedSubjectWords } from "../analysis.js";

type ParsedSubject = ReturnType<
  typeof import("../analysis.js").parseSubjectWords
>;

interface TestFollowUpSignals {
  ownerScope: string;
  ownerStructuralWords: Set<string>;
  sharedStructuralWordCount: number;
  sharedSubjectWordCount: number;
  supportScope: string;
  supportStructuralWords: Set<string>;
  supportSubjectWords: Set<string>;
}

export function hasExactScopeSubjectTestFollowUp(
  supportFileCount: number,
  ownerFileCount: number,
  signals: TestFollowUpSignals,
): boolean {
  const {
    ownerScope,
    ownerStructuralWords,
    sharedStructuralWordCount,
    sharedSubjectWordCount,
    supportScope,
    supportStructuralWords,
    supportSubjectWords,
  } = signals;

  return (
    supportFileCount <= 2 &&
    ownerFileCount >= 2 &&
    supportScope.length > 0 &&
    (hasDirectScopeTestFollowUp(
      supportScope,
      ownerScope,
      supportStructuralWords,
      sharedStructuralWordCount,
      sharedSubjectWordCount,
    ) ||
      hasOwnerScopeSubjectAnchor(
        supportSubjectWords,
        supportScope,
        ownerScope,
        ownerStructuralWords,
        sharedStructuralWordCount,
      ) ||
      hasScopedStructuralSubjectAnchor(
        supportScope,
        supportStructuralWords,
        ownerStructuralWords,
        sharedSubjectWordCount,
      ) ||
      hasStrongScopedSubjectAnchor(
        supportSubjectWords,
        supportScope,
        sharedSubjectWordCount,
      ))
  );
}

export function hasSameFileAssertionTestFollowUp(
  followUpGroup: PlannedCommit,
  ownerGroup: PlannedCommit,
  followUpSubject: ParsedSubject,
  ownerSubject: ParsedSubject,
): boolean {
  return (
    followUpSubject.type === "test" &&
    ownerSubject.type === "test" &&
    followUpSubject.scope.length > 0 &&
    followUpSubject.scope === ownerSubject.scope &&
    followUpGroup.files.length === 1 &&
    ownerGroup.files.length === 1 &&
    isTinyTestFileFollowUp(followUpGroup) &&
    isTinyTestFileFollowUp(ownerGroup) &&
    followUpGroup.files[0]?.path === ownerGroup.files[0]?.path &&
    hasAssertionLikeTestFollowUpSubject(followUpSubject)
  );
}

export function isTinyTestFileFollowUp(group: PlannedCommit): boolean {
  return (
    group.files.length <= 2 &&
    group.files.every((file) => {
      const basename = file.path.split("/").at(-1) ?? "";
      return file.path.startsWith("tests/") || /\.test\.[^.]+$/u.test(basename);
    })
  );
}

function getScopeWordTokens(scope: string): string[] {
  return scope.split(/[^A-Za-z0-9]+/u).filter((word) => word.length >= 3);
}

function hasAssertionLikeTestFollowUpSubject(subject: ParsedSubject): boolean {
  return ["assertion", "assertions", "diagnostic", "expectation", "relax"].some(
    (word) => subject.words.has(word),
  );
}

function hasDirectScopeTestFollowUp(
  supportScope: string,
  ownerScope: string,
  supportStructuralWords: Set<string>,
  sharedStructuralWordCount: number,
  sharedSubjectWordCount: number,
): boolean {
  return (
    supportScope === ownerScope &&
    sharedSubjectWordCount >= 1 &&
    (sharedStructuralWordCount >= 1 || supportStructuralWords.has(supportScope))
  );
}

function hasOwnerScopeSubjectAnchor(
  supportSubjectWords: Set<string>,
  supportScope: string,
  ownerScope: string,
  ownerStructuralWords: Set<string>,
  sharedStructuralWordCount: number,
): boolean {
  return (
    ownerScope.length > 0 &&
    // Only applies when scopes differ; same-scope pairs are handled by
    // hasDirectScopeTestFollowUp and must not double-trigger here when the
    // scope word appears incidentally in the test description.
    supportScope !== ownerScope &&
    sharedStructuralWordCount >= 1 &&
    countSharedSubjectWords(
      new Set(getScopeWordTokens(supportScope)),
      ownerStructuralWords,
    ) >= 1 &&
    supportSubjectWords.has(ownerScope)
  );
}

function hasScopedStructuralSubjectAnchor(
  supportScope: string,
  supportStructuralWords: Set<string>,
  ownerStructuralWords: Set<string>,
  sharedSubjectWordCount: number,
): boolean {
  const scopeWords = new Set(getScopeWordTokens(supportScope));

  return (
    sharedSubjectWordCount >= 2 &&
    countSharedSubjectWords(scopeWords, supportStructuralWords) >= 1 &&
    countSharedSubjectWords(scopeWords, ownerStructuralWords) >= 1
  );
}

function hasStrongScopedSubjectAnchor(
  supportSubjectWords: Set<string>,
  supportScope: string,
  sharedSubjectWordCount: number,
): boolean {
  return sharedSubjectWordCount >= 4 && supportSubjectWords.has(supportScope);
}
