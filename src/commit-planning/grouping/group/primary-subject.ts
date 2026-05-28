import type { PlannedCommit } from "../grouping-types.js";

import {
  countSharedSubjectWords,
  isSupportLikeType,
  parseSubjectWords,
  scopesRelated,
} from "../subject/analysis.js";
import {
  mergeCommitMessagesWithPrimarySubject,
  prioritizeMergedCommits,
} from "./merge.js";

export function maybePromotePrimaryCoveredSubject(
  messageScopedToCoverage: string,
  coveredGroups: PlannedCommit[],
): string {
  const consolidatedSubject = parseSubjectWords(
    messageScopedToCoverage.split("\n")[0] ?? "",
  );
  const strongestCovered = pickCoveredPrimarySubjectCandidate(
    consolidatedSubject,
    coveredGroups,
  );
  const strongestCoveredSubject = parseSubjectWords(
    strongestCovered.message.split("\n")[0] ?? "",
  );
  const shouldPromoteGenericUmbrellaSubject = hasGenericUmbrellaSubjectMismatch(
    consolidatedSubject,
    strongestCoveredSubject,
  );

  if (
    !shouldPromoteGenericUmbrellaSubject ||
    strongestCoveredSubject.type === "" ||
    isSupportLikeType(strongestCoveredSubject.type)
  ) {
    return messageScopedToCoverage;
  }

  return mergeCommitMessagesWithPrimarySubject(
    strongestCovered.message,
    coveredGroups,
  );
}

function hasGenericUmbrellaSubjectMismatch(
  consolidatedSubject: ReturnType<typeof parseSubjectWords>,
  strongestCoveredSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  if (
    strongestCoveredSubject.type === "" ||
    isSupportLikeType(strongestCoveredSubject.type)
  ) {
    return false;
  }

  const subjectWordOverlap = countSharedSubjectWords(
    consolidatedSubject.words,
    strongestCoveredSubject.words,
  );
  if (subjectWordOverlap === 0) {
    return true;
  }
  if (subjectWordOverlap >= 2) {
    return false;
  }

  const scopesAlign =
    consolidatedSubject.scope.length === 0 ||
    strongestCoveredSubject.scope.length === 0 ||
    scopesRelated(consolidatedSubject.scope, strongestCoveredSubject.scope);

  return !scopesAlign;
}

function haveRelatedPromotionScopes(
  leftScope: string,
  rightScope: string,
): boolean {
  return (
    leftScope.length === 0 ||
    rightScope.length === 0 ||
    scopesRelated(leftScope, rightScope)
  );
}

function pickCoveredPrimarySubjectCandidate(
  consolidatedSubject: ReturnType<typeof parseSubjectWords>,
  coveredGroups: PlannedCommit[],
): PlannedCommit {
  const sameTypeImplementationGroups = coveredGroups.filter((group) => {
    const coveredSubject = parseSubjectWords(
      group.message.split("\n")[0] ?? "",
    );
    return (
      coveredSubject.type === consolidatedSubject.type &&
      coveredSubject.type.length > 0 &&
      !isSupportLikeType(coveredSubject.type)
    );
  });
  const sameSubjectFamilyGroups = sameTypeImplementationGroups.filter(
    (group) => {
      const coveredSubject = parseSubjectWords(
        group.message.split("\n")[0] ?? "",
      );
      return haveRelatedPromotionScopes(
        consolidatedSubject.scope,
        coveredSubject.scope,
      );
    },
  );

  if (sameSubjectFamilyGroups.length > 0) {
    const strongestSameFamily = prioritizeMergedCommits(
      sameSubjectFamilyGroups,
    )[0];
    const strongestSameFamilySubject = parseSubjectWords(
      strongestSameFamily.message.split("\n")[0] ?? "",
    );

    if (
      sameTypeImplementationGroups.length > sameSubjectFamilyGroups.length &&
      hasGenericUmbrellaSubjectMismatch(
        consolidatedSubject,
        strongestSameFamilySubject,
      )
    ) {
      return prioritizeMergedCommits(sameTypeImplementationGroups)[0];
    }
  }

  return prioritizeMergedCommits(
    sameSubjectFamilyGroups.length > 0
      ? sameSubjectFamilyGroups
      : sameTypeImplementationGroups.length > 0
        ? sameTypeImplementationGroups
        : coveredGroups,
  )[0];
}
