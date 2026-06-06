import { type PlannedCommit } from "../grouping-types.js";
import { type SupportAttachmentSignals } from "./attachment-signals.js";
import {
  hasExactScopedLexicalAnchor,
  hasExactScopedPathSignal,
  hasFocusedLexicalTestOwnershipSignal,
  hasIndirectScopedPathAnchor,
} from "./single-owner-anchor.js";

export type { SupportAttachmentSignals } from "./attachment-signals.js";

/** Rejects weak test-to-implementation attachments that would smear broad support work across one owner. */
export function shouldRejectWeakTestSupportAttachment(
  signals: SupportAttachmentSignals,
  supportGroup: PlannedCommit,
): boolean {
  if (!isTestToImplementationAttachment(signals)) {
    return false;
  }

  const hasTestSpecificSignal = hasTestSpecificOwnershipSignal(
    signals,
    supportGroup,
  );
  if (signals.isBroadSupportGroup) {
    return !hasBroadTestOwnershipSignal(signals);
  }

  return !hasNarrowTestOwnershipSignal(signals, hasTestSpecificSignal);
}

function getTestSupportIntentScore(
  signals: SupportAttachmentSignals,
  supportGroup: PlannedCommit,
): number {
  if (
    signals.sharedSubjectWordCount < 2 ||
    supportGroup.files.length === 0 ||
    signals.supportSubject.type !== "test" ||
    signals.targetSubject.type === "test" ||
    !hasStructuralTestAttachmentSignal(signals)
  ) {
    return 0;
  }

  return 4;
}

function hasBroadTestOwnershipSignal(
  signals: SupportAttachmentSignals,
): boolean {
  return (
    signals.hasCoverageSignal ||
    signals.hasExactDescriptionSignal ||
    (signals.hasExactScopeSignal &&
      signals.sharedIntentScore >= Math.max(3, signals.targetFileCount)) ||
    (signals.hasScopeSignal &&
      (signals.sharedPaths || signals.sharedSubjectWordCount >= 2)) ||
    (signals.hasDependencySignal &&
      (signals.sharedPaths || signals.sharedSubjectWordCount > 0))
  );
}

function hasDependencyOrScopeLexicalSignal(
  signals: SupportAttachmentSignals,
): boolean {
  return (
    (signals.hasDependencySignal &&
      (signals.sharedPaths || signals.sharedSubjectWordCount >= 2)) ||
    (signals.hasScopeSignal && signals.sharedSubjectWordCount >= 2)
  );
}

function hasNarrowTestOwnershipSignal(
  signals: SupportAttachmentSignals,
  hasTestSpecificSignal: boolean,
): boolean {
  if (lacksAnyNarrowAttachmentAnchor(signals)) {
    return false;
  }

  if (rejectsWeakSingleTargetAttachment(signals)) {
    return false;
  }

  return (
    signals.hasCoverageSignal ||
    signals.hasExactDescriptionSignal ||
    hasExactScopedPathSignal(signals) ||
    hasDependencyOrScopeLexicalSignal(signals) ||
    hasTestSpecificSignal ||
    hasFocusedLexicalTestOwnershipSignal(signals) ||
    (signals.sharedPathScore > 0 && signals.sharedSubjectWordCount >= 2)
  );
}

function hasStructuralTestAttachmentSignal(
  signals: SupportAttachmentSignals,
): boolean {
  return (
    signals.hasCoverageSignal ||
    signals.hasExactDescriptionSignal ||
    signals.hasDependencySignal ||
    signals.hasScopeSignal ||
    signals.sharedPathScore > 0 ||
    signals.sharedPaths
  );
}

function hasTestSpecificOwnershipSignal(
  signals: SupportAttachmentSignals,
  supportGroup: PlannedCommit,
): boolean {
  return getTestSupportIntentScore(signals, supportGroup) > 0;
}

function isTestToImplementationAttachment(
  signals: SupportAttachmentSignals,
): boolean {
  return (
    signals.supportSubject.type === "test" &&
    signals.targetSubject.type !== "test"
  );
}

function lacksAnyNarrowAttachmentAnchor(
  signals: SupportAttachmentSignals,
): boolean {
  return (
    !signals.hasScopeSignal &&
    !signals.hasCoverageSignal &&
    !signals.sharedPaths &&
    !signals.hasHighWordOverlap
  );
}

function rejectsWeakSingleTargetAttachment(
  signals: SupportAttachmentSignals,
): boolean {
  if (signals.targetFileCount !== 1) {
    return false;
  }

  if (
    signals.hasCoverageSignal ||
    signals.sharedPaths ||
    signals.hasHighWordOverlap
  ) {
    return false;
  }

  return (
    !hasIndirectScopedPathAnchor(signals) &&
    !hasExactScopedLexicalAnchor(signals)
  );
}
