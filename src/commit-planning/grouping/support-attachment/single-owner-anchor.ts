import type { SupportAttachmentSignals as AttachmentSignals } from "./attachment-signals.js";

export function hasExactScopedLexicalAnchor(
  signals: AttachmentSignals,
): boolean {
  return (
    signals.hasExactScopeSignal &&
    signals.sharedPathScore === 0 &&
    signals.sharedSubjectWordCount >= 2
  );
}

export function hasExactScopedPathSignal(signals: AttachmentSignals): boolean {
  return signals.hasExactScopeSignal && signals.sharedPathScore > 0;
}

export function hasFocusedLexicalTestOwnershipSignal(
  signals: AttachmentSignals,
): boolean {
  return (
    signals.hasHighWordOverlap &&
    signals.sharedIntentScore > signals.targetFileCount
  );
}

export function hasIndirectScopedPathAnchor(
  signals: AttachmentSignals,
): boolean {
  return (
    signals.hasScopeSignal &&
    !signals.hasExactScopeSignal &&
    signals.sharedPathScore > 0
  );
}

/** Lone implementation owners still need a structural or scoped anchor. */
export function hasSingleOwnerAttachmentAnchor(
  signals: AttachmentSignals,
): boolean {
  return (
    signals.hasCoverageSignal ||
    signals.hasExactDescriptionSignal ||
    hasDependencySingleOwnerAnchor(signals) ||
    hasExactScopeSingleOwnerAnchor(signals) ||
    signals.sharedPaths ||
    hasPathAffinitySingleOwnerAnchor(signals) ||
    hasScopedWordSingleOwnerAnchor(signals) ||
    hasNonTestWordSingleOwnerAnchor(signals) ||
    hasNarrowTestWordSingleOwnerAnchor(signals)
  );
}

function getSingleOwnerTestPathAffinityThreshold(
  targetFileCount: number,
): number {
  return Math.max(1, Math.ceil(Math.log2(targetFileCount + 1)));
}

function hasDependencySingleOwnerAnchor(signals: AttachmentSignals): boolean {
  if (!signals.hasDependencySignal) {
    return false;
  }

  if (signals.supportSubject.type !== "test") {
    return true;
  }

  return signals.sharedPaths || signals.sharedSubjectWordCount >= 2;
}

function hasExactScopeSingleOwnerAnchor(signals: AttachmentSignals): boolean {
  if (!signals.hasExactScopeSignal) {
    return false;
  }

  if (signals.supportSubject.type !== "test") {
    return true;
  }

  return (
    signals.hasCoverageSignal ||
    signals.sharedPaths ||
    signals.sharedPathScore >=
      getSingleOwnerTestPathAffinityThreshold(signals.targetFileCount) ||
    signals.sharedSubjectWordCount >= 2
  );
}

function hasFocusedLexicalSingleOwnerAnchor(
  signals: AttachmentSignals,
): boolean {
  return hasFocusedLexicalTestOwnershipSignal(signals);
}

function hasFocusedNonTestLexicalSingleOwnerAnchor(
  signals: AttachmentSignals,
): boolean {
  return (
    signals.hasHighWordOverlap &&
    signals.sharedIntentScore > signals.targetFileCount + 2
  );
}

function hasNarrowTestWordSingleOwnerAnchor(
  signals: AttachmentSignals,
): boolean {
  return (
    signals.supportSubject.type === "test" &&
    !signals.isBroadSupportGroup &&
    signals.sharedSubjectWordCount >= 2 &&
    (signals.hasScopeSignal ||
      signals.sharedPathScore > 0 ||
      hasFocusedLexicalSingleOwnerAnchor(signals))
  );
}

function hasNonTestWordSingleOwnerAnchor(signals: AttachmentSignals): boolean {
  return (
    signals.supportSubject.type !== "test" &&
    !signals.isBroadSupportGroup &&
    signals.sharedSubjectWordCount >= 2 &&
    (signals.hasScopeSignal ||
      signals.sharedPathScore > 0 ||
      hasFocusedNonTestLexicalSingleOwnerAnchor(signals))
  );
}

function hasPathAffinitySingleOwnerAnchor(signals: AttachmentSignals): boolean {
  return (
    signals.sharedPathScore >=
      getSingleOwnerTestPathAffinityThreshold(signals.targetFileCount) &&
    !isBroadTestSupportGroup(signals) &&
    (signals.supportSubject.type !== "test" ||
      signals.sharedSubjectWordCount >= 2)
  );
}

function hasScopedWordSingleOwnerAnchor(signals: AttachmentSignals): boolean {
  return signals.hasScopeSignal && signals.sharedSubjectWordCount >= 2;
}

function isBroadTestSupportGroup(signals: AttachmentSignals): boolean {
  return signals.supportSubject.type === "test" && signals.isBroadSupportGroup;
}
