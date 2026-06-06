import { isSupportLikePath } from "../../path/index.js";
import { type PlannedCommit, type SubjectWords } from "../grouping-types.js";

interface SupportAreaMergeSignalInput {
  countSharedSubjectWords: (left: Set<string>, right: Set<string>) => number;
  isSupportLikeType: (type: string) => boolean;
  leftGroup: PlannedCommit;
  leftSubject: SubjectWords;
  rightGroup: PlannedCommit;
  rightSubject: SubjectWords;
}

/**
 * Small support-only pairs can still justify one consolidation review when
 * their subjects share concrete vocabulary.
 */
export function hasCompactSupportLexicalMergeSignal(
  input: SupportAreaMergeSignalInput,
): boolean {
  const sharedSubjectWordCount = input.countSharedSubjectWords(
    input.leftSubject.words,
    input.rightSubject.words,
  );
  const combinedFileCount =
    input.leftGroup.files.length + input.rightGroup.files.length;
  const bothSupportLike =
    input.isSupportLikeType(input.leftSubject.type) &&
    input.isSupportLikeType(input.rightSubject.type);

  if (bothSupportLike) {
    return combinedFileCount <= 3 && sharedSubjectWordCount >= 1;
  }

  if (combinedFileCount > 5) {
    return false;
  }

  return sharedSubjectWordCount >= 2;
}

/**
 * A multi-file implementation group that already carries support coverage can
 * justify one consolidation attempt against a multi-file support group on a
 * single strong shared subject token.
 */
export function hasSupportBearingImplementationMergeSignal(
  input: SupportAreaMergeSignalInput,
): boolean {
  const leftIsSupportLike = input.isSupportLikeType(input.leftSubject.type);
  const rightIsSupportLike = input.isSupportLikeType(input.rightSubject.type);

  if (leftIsSupportLike === rightIsSupportLike) {
    return false;
  }

  const supportGroup = leftIsSupportLike ? input.leftGroup : input.rightGroup;
  const implementationGroup = leftIsSupportLike
    ? input.rightGroup
    : input.leftGroup;

  return (
    supportGroup.files.length >= 2 &&
    implementationGroup.files.length >= 2 &&
    input.leftGroup.files.length + input.rightGroup.files.length <= 6 &&
    input.countSharedSubjectWords(
      input.leftSubject.words,
      input.rightSubject.words,
    ) >= 1 &&
    (groupHasSupportLikeFiles(input.leftGroup) ||
      groupHasSupportLikeFiles(input.rightGroup))
  );
}

function groupHasSupportLikeFiles(group: PlannedCommit): boolean {
  return group.files.some((file) => isSupportLikePath(file.path));
}
