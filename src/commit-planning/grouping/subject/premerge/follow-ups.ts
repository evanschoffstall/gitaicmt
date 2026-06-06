import { isSupportLikePath } from "../../../path/index.js";
import { type FileDiff, type PlannedCommit } from "../../grouping-types.js";
import { getPathOwnerDescriptor } from "../../ownership.js";
import {
  countSharedSubjectWords,
  getNormalizedSubjectDescriptionKey,
  isSupportLikeType,
  parseSubjectWords,
} from "../analysis.js";
import {
  getImplementationAnchoredOwnerGroup,
  getSharedChangedIdentifiers,
  getSingleFeatureRoot,
  getSingleOwnerId,
  getStructuralPathWords,
  hasSharedChangedExportIdentifierFollowUp,
  hasSmallFollowUpFootprint,
  hasSmallTestFollowUpFootprint,
  isCleanupDominantGroup,
} from "./structural-signals.js";
import { shouldPremergeStyleGroups } from "./style-signals.js";
import {
  hasExactScopeSubjectTestFollowUp,
  hasSameFileAssertionTestFollowUp,
  isTinyTestFileFollowUp,
} from "./test-follow-up-signals.js";

/** Cleanup-heavy same-type follow-ups usually belong to the owning refactor. */
export function shouldPremergeCleanupFollowUp(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
  fileByPath: Map<string, FileDiff>,
): boolean {
  return (
    left.type !== "" &&
    left.type === right.type &&
    (shouldAttachCleanupGroup(leftGroup, rightGroup, fileByPath) ||
      shouldAttachCleanupGroup(rightGroup, leftGroup, fileByPath))
  );
}

/**
 * Small feature-root entrypoint updates usually belong to the nested
 * implementation rollout they expose when their subjects still describe the
 * same change.
 */
export function shouldPremergeFeatureEntrypointFollowUp(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
  fileByPath: Map<string, FileDiff>,
): boolean {
  return (
    shouldAttachFeatureEntrypointFollowUp(
      leftGroup,
      rightGroup,
      left,
      right,
      fileByPath,
    ) ||
    shouldAttachFeatureEntrypointFollowUp(
      rightGroup,
      leftGroup,
      right,
      left,
      fileByPath,
    )
  );
}

/**
 * Same-type refactors or fixes that share one feature root and renamed
 * identifiers are usually one rollout even when subject words differ.
 */
export function shouldPremergeIdentifierFollowUp(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
  fileByPath: Map<string, FileDiff>,
): boolean {
  if (!(left.type !== "" && left.type === right.type)) {
    return false;
  }

  if (
    !hasSmallFollowUpFootprint(leftGroup) &&
    !hasSmallFollowUpFootprint(rightGroup)
  ) {
    return false;
  }

  if (
    !leftGroup.files.some((file) => !isSupportLikePath(file.path)) ||
    !rightGroup.files.some((file) => !isSupportLikePath(file.path))
  ) {
    return false;
  }

  const leftRoot = getSingleFeatureRoot(leftGroup);
  return (
    leftRoot !== null &&
    leftRoot === getSingleFeatureRoot(rightGroup) &&
    getSharedChangedIdentifiers(leftGroup, rightGroup, fileByPath).size > 0
  );
}

/**
 * Style-only sweeps within one support area should collapse early so AI does
 * not leave obvious formatting follow-ups behind as separate commits.
 * Source-tree style work stays with AI clustering because broad `src/` sweeps
 * can still hide unrelated reasons.
 */
export function shouldPremergeStyleSweep(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
): boolean {
  return shouldPremergeStyleGroups(leftGroup, rightGroup, left, right);
}

/**
 * Small test follow-ups should premerge into the owning non-test group when
 * structural vocabulary shows they belong to the same rollout.
 */
export function shouldPremergeTestFollowUp(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
): boolean {
  return (
    shouldAttachSameFileTestFollowUp(leftGroup, rightGroup, left, right) ||
    shouldAttachSameFileTestFollowUp(rightGroup, leftGroup, right, left) ||
    shouldAttachTestFollowUp(leftGroup, rightGroup, left, right) ||
    shouldAttachTestFollowUp(rightGroup, leftGroup, right, left)
  );
}

function hasExactNarrativeTestFollowUp(
  supportGroup: PlannedCommit,
  ownerGroup: PlannedCommit,
): boolean {
  const supportDescriptionKey = getNormalizedSubjectDescriptionKey(
    supportGroup.message.split("\n")[0] ?? "",
  );
  const ownerDescriptionKey = getNormalizedSubjectDescriptionKey(
    ownerGroup.message.split("\n")[0] ?? "",
  );

  return (
    supportDescriptionKey.length > 0 &&
    supportDescriptionKey === ownerDescriptionKey
  );
}

function hasFeatureEntrypointSubjectAnchor(
  entrypointSubject: ReturnType<typeof parseSubjectWords>,
  ownerSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  const sharedSubjectWordCount = countSharedSubjectWords(
    entrypointSubject.words,
    ownerSubject.words,
  );

  return (
    sharedSubjectWordCount >= 2 ||
    (entrypointSubject.type === ownerSubject.type &&
      sharedSubjectWordCount >= 1 &&
      entrypointSubject.words.size <= 3)
  );
}

/** Same-type follow-up merges only apply to stable conventional-commit types. */
function isEligibleFeatureEntrypointFollowUp(
  entrypointGroup: PlannedCommit,
  ownerGroup: PlannedCommit,
  entrypointSubject: ReturnType<typeof parseSubjectWords>,
  ownerSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  if (
    entrypointSubject.type.length === 0 ||
    ownerSubject.type.length === 0 ||
    isSupportLikeType(entrypointSubject.type) ||
    isSupportLikeType(ownerSubject.type) ||
    !hasSmallFollowUpFootprint(entrypointGroup)
  ) {
    return false;
  }

  const featureRoot = getSingleFeatureRoot(entrypointGroup);
  if (
    featureRoot === null ||
    featureRoot !== getSingleFeatureRoot(ownerGroup)
  ) {
    return false;
  }

  return (
    isFeatureEntrypointGroup(entrypointGroup, featureRoot) &&
    isNestedFeatureGroup(ownerGroup, featureRoot)
  );
}

function isFeatureEntrypointGroup(
  group: PlannedCommit,
  featureRoot: string,
): boolean {
  return (
    group.files.length > 0 &&
    group.files.every((file) => {
      const owner = getPathOwnerDescriptor(file.path);
      return (
        owner.featureRoot === featureRoot &&
        owner.kind === "direct-file" &&
        isFeatureEntrypointPath(file.path)
      );
    })
  );
}

function isFeatureEntrypointPath(filePath: string): boolean {
  const basename = filePath.split("/").at(-1) ?? "";
  return /^index\.[^.]+$/u.test(basename);
}

function isNestedFeatureGroup(
  group: PlannedCommit,
  featureRoot: string,
): boolean {
  return (
    group.files.some(
      (file) => getPathOwnerDescriptor(file.path).kind === "nested-subtree",
    ) &&
    group.files.every((file) => {
      const owner = getPathOwnerDescriptor(file.path);
      return owner.featureRoot === featureRoot;
    })
  );
}

/** Cleanup follow-ups only attach when both groups stay under the same owner. */
function shouldAttachCleanupGroup(
  cleanupCandidate: PlannedCommit,
  ownerCandidate: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): boolean {
  if (!isCleanupDominantGroup(cleanupCandidate, fileByPath)) {
    return false;
  }

  const cleanupOwnerId = getSingleOwnerId(cleanupCandidate);
  return (
    cleanupOwnerId !== null &&
    cleanupOwnerId === getSingleOwnerId(ownerCandidate)
  );
}

function shouldAttachFeatureEntrypointFollowUp(
  entrypointGroup: PlannedCommit,
  ownerGroup: PlannedCommit,
  entrypointSubject: ReturnType<typeof parseSubjectWords>,
  ownerSubject: ReturnType<typeof parseSubjectWords>,
  fileByPath: Map<string, FileDiff>,
): boolean {
  if (
    !isEligibleFeatureEntrypointFollowUp(
      entrypointGroup,
      ownerGroup,
      entrypointSubject,
      ownerSubject,
    )
  ) {
    return false;
  }

  return (
    hasFeatureEntrypointSubjectAnchor(entrypointSubject, ownerSubject) ||
    hasSharedChangedExportIdentifierFollowUp(
      entrypointGroup,
      ownerGroup,
      entrypointSubject,
      fileByPath,
    )
  );
}

function shouldAttachSameFileTestFollowUp(
  followUpGroup: PlannedCommit,
  ownerGroup: PlannedCommit,
  followUpSubject: ReturnType<typeof parseSubjectWords>,
  ownerSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  return hasSameFileAssertionTestFollowUp(
    followUpGroup,
    ownerGroup,
    followUpSubject,
    ownerSubject,
  );
}

/** Small tests follow implementation groups when ownership vocabulary overlaps. */
function shouldAttachTestFollowUp(
  supportGroup: PlannedCommit,
  ownerGroup: PlannedCommit,
  supportSubject: ReturnType<typeof parseSubjectWords>,
  ownerSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  const isTestLikeSupportGroup = isTinyTestFileFollowUp(supportGroup);

  if (!isTestLikeSupportGroup || ownerSubject.type === "test") {
    return false;
  }

  if (!hasSmallTestFollowUpFootprint(supportGroup)) {
    return false;
  }

  if (hasExactNarrativeTestFollowUp(supportGroup, ownerGroup)) {
    return true;
  }

  const supportWords = getStructuralPathWords(supportGroup);
  const ownerStructuralWords = getStructuralPathWords(
    getImplementationAnchoredOwnerGroup(ownerGroup),
  );
  const ownerWords = new Set(ownerStructuralWords);
  const sharedStructuralWordCount = countSharedSubjectWords(
    supportWords,
    ownerStructuralWords,
  );
  const sharedSubjectWordCount = countSharedSubjectWords(
    supportSubject.words,
    ownerSubject.words,
  );

  for (const word of ownerSubject.words) {
    ownerWords.add(word);
  }

  return (
    (sharedStructuralWordCount >= 2 &&
      sharedSubjectWordCount >= 2 &&
      countSharedSubjectWords(supportWords, ownerWords) >= 2) ||
    hasExactScopeSubjectTestFollowUp(
      supportGroup.files.length,
      ownerGroup.files.length,
      {
        ownerScope: ownerSubject.scope,
        ownerStructuralWords,
        sharedStructuralWordCount,
        sharedSubjectWordCount,
        supportScope: supportSubject.scope,
        supportStructuralWords: supportWords,
        supportSubjectWords: supportSubject.words,
      },
    )
  );
}
