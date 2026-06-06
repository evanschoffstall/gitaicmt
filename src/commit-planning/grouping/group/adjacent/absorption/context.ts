import type { PlannedCommit } from "../../../grouping-types.js";

import {
  getMeaningfulPathWords,
  isSupportLikePath,
} from "../../../../path/index.js";
import { groupsSharePaths } from "../../../commit-coverage.js";
import {
  getPathOwnerDescriptor,
  inferSupportScopeFromPath,
} from "../../../ownership.js";
import {
  getNormalizedSubjectDescriptionKey,
  isSupportLikeType,
  parseSubjectWords,
} from "../../../subject/analysis.js";
import { hasSharedOwner } from "../../ownership-boundaries.js";
import {
  blocksCrossAreaStyleAbsorption,
  blocksThinSupportFollowUp,
} from "../follow-up-rules.js";
import {
  getAdjacentGroupSharedSurface,
  isSingleSurfaceGroup,
} from "../surface-signals.js";

interface AbsorbableAdjacentCandidateContext extends AdjacentSubjectContext {
  sharedSurface: ReturnType<typeof getAdjacentGroupSharedSurface>;
}

interface AdjacentSubjectContext {
  candidateSubject: ReturnType<typeof parseSubjectWords>;
  previousSubject: ReturnType<typeof parseSubjectWords>;
}

function getAbsorbableAdjacentCandidateContext(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  isBroaderAdjacentGroup: (
    previous: PlannedCommit,
    candidate: PlannedCommit,
  ) => boolean,
): AbsorbableAdjacentCandidateContext | null {
  if (!isSingleSurfaceGroup(candidate)) {
    return null;
  }

  const previousSubject = parseSubjectWords(
    previous.message.split("\n")[0] ?? "",
  );
  if (isSupportLikeType(previousSubject.type)) {
    return null;
  }

  const candidateSubject = parseSubjectWords(
    candidate.message.split("\n")[0] ?? "",
  );
  if (
    blocksThinSupportFollowUp(
      previous,
      candidate,
      previousSubject,
      candidateSubject,
    ) ||
    blocksCrossAreaStyleAbsorption(previous, candidate, candidateSubject)
  ) {
    return null;
  }

  const sharedSurface = hasAdjacentAbsorptionBoundary(
    previous,
    candidate,
    previousSubject,
    candidateSubject,
  );
  if (
    sharedSurface === null ||
    isPathOnlySurfaceMismatch(
      previous,
      candidate,
      previousSubject,
      candidateSubject,
      sharedSurface,
      isBroaderAdjacentGroup,
    )
  ) {
    return null;
  }

  return { candidateSubject, previousSubject, sharedSurface };
}

function getAdjacentSubjectContext(
  previous: PlannedCommit,
  candidate: PlannedCommit,
): AdjacentSubjectContext {
  return {
    candidateSubject: parseSubjectWords(candidate.message.split("\n")[0] ?? ""),
    previousSubject: parseSubjectWords(previous.message.split("\n")[0] ?? ""),
  };
}

function hasAdjacentAbsorptionBoundary(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
): null | ReturnType<typeof getAdjacentGroupSharedSurface> {
  const sharedSurface = getAdjacentGroupSharedSurface(
    previous,
    candidate,
    previousSubject,
    candidateSubject,
  );

  if (
    !sharedSurface.hasAnyMatch ||
    !hasSharedOwnerAffinity(
      previous,
      candidate,
      previousSubject,
      candidateSubject,
    )
  ) {
    return null;
  }

  return sharedSurface;
}

function hasExactNarrativeTestFollowUpAffinity(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  const previousIsSingleTestFollowUp = isSingleTestFollowUpGroup(
    previous,
    previousSubject.type,
  );
  const candidateIsSingleTestFollowUp = isSingleTestFollowUpGroup(
    candidate,
    candidateSubject.type,
  );
  if (previousIsSingleTestFollowUp === candidateIsSingleTestFollowUp) {
    return false;
  }

  if (!isAdjacentFeatureTestPair(previousSubject.type, candidateSubject.type)) {
    return false;
  }

  const implementationGroup =
    previousSubject.type === "feat" ? previous : candidate;
  if (implementationGroup.files.some((file) => isSupportLikePath(file.path))) {
    return false;
  }

  const previousDescription = getNormalizedSubjectDescriptionKey(
    previous.message.split("\n")[0] ?? "",
  );
  const candidateDescription = getNormalizedSubjectDescriptionKey(
    candidate.message.split("\n")[0] ?? "",
  );

  return (
    previousDescription.length > 0 &&
    previousDescription === candidateDescription
  );
}

function hasSharedOwnerAffinity(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  return (
    hasSharedOwner(previous, candidate) ||
    hasExactNarrativeTestFollowUpAffinity(
      previous,
      candidate,
      previousSubject,
      candidateSubject,
    ) ||
    hasSupportScopeAlignedOwnerAffinity(
      previous,
      candidate,
      previousSubject,
      candidateSubject,
    )
  );
}

function hasSupportScopeAlignedOwnerAffinity(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  const previousIsSupport = isSupportLikeType(previousSubject.type);
  const candidateIsSupport = isSupportLikeType(candidateSubject.type);
  if (previousIsSupport === candidateIsSupport) {
    return false;
  }

  const implementationGroup = previousIsSupport ? candidate : previous;
  const supportGroup = previousIsSupport ? previous : candidate;
  const implementationWords = new Set(
    implementationGroup.files.flatMap((file) => {
      const owner = getPathOwnerDescriptor(file.path);
      return [
        ...getMeaningfulPathWords(owner.featureRoot),
        ...getMeaningfulPathWords(owner.ownerId),
      ];
    }),
  );

  return supportGroup.files.some((file) => {
    if (!isSupportLikePath(file.path)) {
      return false;
    }

    return getMeaningfulPathWords(inferSupportScopeFromPath(file.path)).some(
      (word) => implementationWords.has(word),
    );
  });
}

function isAdjacentFeatureTestPair(
  previousType: string,
  candidateType: string,
): boolean {
  return (
    (previousType === "feat" && candidateType === "test") ||
    (previousType === "test" && candidateType === "feat")
  );
}

function isPathOnlySurfaceMismatch(
  previous: PlannedCommit,
  candidate: PlannedCommit,
  previousSubject: ReturnType<typeof parseSubjectWords>,
  candidateSubject: ReturnType<typeof parseSubjectWords>,
  sharedSurface: ReturnType<typeof getAdjacentGroupSharedSurface>,
  isBroaderAdjacentGroup: (
    previous: PlannedCommit,
    candidate: PlannedCommit,
  ) => boolean,
): boolean {
  const sharesPathOnly =
    groupsSharePaths(previous, candidate) &&
    !isBroaderAdjacentGroup(previous, candidate);
  return (
    sharesPathOnly &&
    previousSubject.type !== candidateSubject.type &&
    candidateSubject.type !== "style" &&
    sharedSurface.sharedSubjectWords < 2
  );
}

function isSingleTestFollowUpGroup(
  group: PlannedCommit,
  subjectType: string,
): boolean {
  return (
    subjectType === "test" &&
    group.files.length === 1 &&
    group.files.every((file) => isSupportLikePath(file.path))
  );
}

export { getAbsorbableAdjacentCandidateContext, getAdjacentSubjectContext };

export type { AbsorbableAdjacentCandidateContext };
