import { groupsShareCoverage, groupsSharePaths } from "../commit-coverage.js";
import { hasDependencySignalBetweenGroups } from "../dependency/index.js";
import { emitSupportAttachmentTraceEvent } from "../group/events.js";
import {
  type FileChangeSignals,
  type PlannedCommit,
} from "../grouping-types.js";
import { getSharedIntentScore } from "../intent/index.js";
import {
  getPathOwnerDescriptor,
  inferSupportScopeFromPath,
} from "../ownership.js";
import {
  countSharedSubjectWords,
  hasHighWordOverlap,
  parseMessageWords,
  parseSubjectWords,
  scopesRelated,
} from "../subject/analysis.js";
import {
  addMeaningfulOwnershipWords,
  getMeaningfulOwnershipTokens,
} from "./ownership-words.js";
import {
  shouldRejectWeakTestSupportAttachment,
  type SupportAttachmentSignals,
} from "./test-ownership.js";

export interface SupportAttachmentEvaluation {
  score: number;
  signals: AttachmentSignals;
}

interface AttachmentSignals extends SupportAttachmentSignals {
  hasExactScopeSignal: boolean;
  hasHighWordOverlap: boolean;
  sharedIntentScore: number;
  targetFileCount: number;
}

interface BreadthPenaltyDiagnostics {
  componentGroupCount: number;
  distinctFeatureRootCount: number;
  distinctOwnerCount: number;
  hasCoordinatorLikeFile: boolean;
  uniquePathCount: number;
}

/** Penalize broad multi-file implementation buckets when attaching support work. */
export function getSupportAttachmentBreadthPenalty(
  supportGroup: PlannedCommit,
  component: number[],
  groups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
): number {
  const supportSubjectType = parseMessageWords(supportGroup.message).type;
  const isSupport = ["chore", "docs", "style", "test"].includes(
    supportSubjectType,
  );
  let penalty = 0;

  if (component.length === 0 || !isSupport) {
    emitSupportAttachmentTraceEvent({
      diagnostics: {
        componentGroupCount: component.length,
        reason:
          component.length === 0 ? "empty-component" : "non-support-group",
        supportFileCount: supportGroup.files.length,
        supportSubjectType,
      },
      kind: "breadth-penalty",
      penalty,
      supportGroup,
    });
    return penalty;
  }

  const diagnostics = collectBreadthPenaltyDiagnostics(
    component,
    groups,
    fileSignals,
  );

  penalty += diagnostics.uniquePathCount > 1 ? 1 : 0;
  penalty +=
    diagnostics.hasCoordinatorLikeFile && diagnostics.uniquePathCount > 1
      ? 2
      : 0;
  penalty += diagnostics.distinctFeatureRootCount > 1 ? 2 : 0;
  penalty += diagnostics.distinctOwnerCount > 2 ? 1 : 0;

  emitSupportAttachmentTraceEvent({
    diagnostics: {
      ...diagnostics,
      supportFileCount: supportGroup.files.length,
      supportSubjectType,
    },
    kind: "breadth-penalty",
    penalty,
    supportGroup,
  });
  return penalty;
}

/** Score support attachment strength from structural, dependency, and lexical signals. */
export function getSupportAttachmentScore(
  supportGroup: PlannedCommit,
  targetGroup: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): SupportAttachmentEvaluation {
  const supportSubject = parseMessageWords(supportGroup.message);
  const targetSubject = parseMessageWords(targetGroup.message);
  const signals = getSupportAttachmentSignals(
    supportGroup,
    targetGroup,
    fileSignals,
    supportSubject,
    targetSubject,
  );
  const rejectionReason = shouldRejectStyleSupportAttachment(signals)
    ? "style-without-coverage"
    : shouldRejectWeakTestSupportAttachment(signals, supportGroup)
      ? "weak-test-support"
      : null;
  if (rejectionReason) {
    emitSupportAttachmentTraceEvent({
      diagnostics: buildSupportAttachmentTraceDiagnostics(
        supportGroup,
        targetGroup,
        signals,
        0,
        0,
      ),
      kind: "score",
      rejectionReason,
      score: 0,
      supportGroup,
      targetGroup,
    });
    return { score: 0, signals };
  }

  const surfaceScore = getSupportSurfaceScore(signals);
  const wordOverlapScore = getSupportWordOverlapScore(signals);
  const score = surfaceScore + wordOverlapScore;

  emitSupportAttachmentTraceEvent({
    diagnostics: buildSupportAttachmentTraceDiagnostics(
      supportGroup,
      targetGroup,
      signals,
      surfaceScore,
      wordOverlapScore,
    ),
    kind: "score",
    score,
    supportGroup,
    targetGroup,
  });

  return {
    score,
    signals,
  };
}

function buildSupportAttachmentTraceDiagnostics(
  supportGroup: PlannedCommit,
  targetGroup: PlannedCommit,
  signals: AttachmentSignals,
  surfaceScore: number,
  wordOverlapScore: number,
): Record<string, boolean | number | string> {
  return {
    hasCoverageSignal: signals.hasCoverageSignal,
    hasDependencySignal: signals.hasDependencySignal,
    hasExactScopeSignal: signals.hasExactScopeSignal,
    hasHighWordOverlap: signals.hasHighWordOverlap,
    hasScopeSignal: signals.hasScopeSignal,
    isBroadSupportGroup: signals.isBroadSupportGroup,
    sharedIntentScore: signals.sharedIntentScore,
    sharedPaths: signals.sharedPaths,
    sharedPathScore: signals.sharedPathScore,
    sharedSubjectWordCount: signals.sharedSubjectWordCount,
    supportFileCount: supportGroup.files.length,
    supportSubjectScope: signals.supportSubject.scope,
    supportSubjectType: signals.supportSubject.type,
    surfaceScore,
    targetFileCount: targetGroup.files.length,
    targetSubjectScope: signals.targetSubject.scope,
    targetSubjectType: signals.targetSubject.type,
    wordOverlapScore,
  };
}

function collectBreadthPenaltyDiagnostics(
  component: number[],
  groups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
): BreadthPenaltyDiagnostics {
  const componentGroups = component.map((index) => groups[index]);
  const uniquePaths = new Set(
    componentGroups.flatMap((group) => group.files.map((file) => file.path)),
  );
  const distinctFeatureRoots = new Set(
    componentGroups.flatMap((group) =>
      group.files.map((file) => getPathOwnerDescriptor(file.path).featureRoot),
    ),
  );
  const distinctOwners = new Set(
    componentGroups.flatMap((group) =>
      group.files.map((file) => getPathOwnerDescriptor(file.path).ownerId),
    ),
  );

  return {
    componentGroupCount: componentGroups.length,
    distinctFeatureRootCount: distinctFeatureRoots.size,
    distinctOwnerCount: distinctOwners.size,
    hasCoordinatorLikeFile: componentGroups.some((group) =>
      group.files.some(
        (file) => fileSignals.get(file.path)?.isCoordinatorLike === true,
      ),
    ),
    uniquePathCount: uniquePaths.size,
  };
}

function collectOwnershipWords(
  group: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
  options: { includeSupportScope: boolean },
): Set<string> {
  const words = new Set<string>();

  for (const file of group.files) {
    addMeaningfulOwnershipWords(
      words,
      fileSignals.get(file.path)?.pathWords ?? [],
    );
    if (options.includeSupportScope) {
      addMeaningfulOwnershipWords(
        words,
        getMeaningfulOwnershipTokens(inferSupportScopeFromPath(file.path)),
      );
    }
    const owner = getPathOwnerDescriptor(file.path);
    if (owner.featureRoot !== "root") {
      addMeaningfulOwnershipWords(
        words,
        getMeaningfulOwnershipTokens(owner.featureRoot),
      );
    }
    if (owner.ownerId !== "root") {
      addMeaningfulOwnershipWords(
        words,
        getMeaningfulOwnershipTokens(owner.ownerId),
      );
    }
  }

  return words;
}

function getExactScopePriorityBonus(signals: AttachmentSignals): number {
  return Math.max(
    0,
    signals.sharedPathScore - Math.max(0, signals.targetFileCount - 1),
  );
}

function getSupportAttachmentSignals(
  supportGroup: PlannedCommit,
  targetGroup: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
  supportSubject: ReturnType<typeof parseSubjectWords>,
  targetSubject: ReturnType<typeof parseSubjectWords>,
): AttachmentSignals {
  const hasCoverageSignal = groupsShareCoverage(supportGroup, targetGroup);
  const hasDependencySignal = hasDependencySignalBetweenGroups(
    supportGroup,
    targetGroup,
    fileSignals,
  );
  const hasScopeSignal =
    supportSubject.scope.length > 0 &&
    targetSubject.scope.length > 0 &&
    scopesRelated(supportSubject.scope, targetSubject.scope);

  return {
    hasCoverageSignal,
    hasDependencySignal,
    hasExactScopeSignal:
      supportSubject.scope.length > 0 &&
      supportSubject.scope === targetSubject.scope,
    hasHighWordOverlap: hasHighWordOverlap(
      supportSubject.words,
      targetSubject.words,
    ),
    hasScopeSignal,
    isBroadSupportGroup: supportGroup.files.length > 1,
    sharedIntentScore: getSharedIntentScore(
      supportGroup,
      targetGroup,
      fileSignals,
    ),
    sharedPaths: groupsSharePaths(supportGroup, targetGroup),
    sharedPathScore: getSupportPathAffinityScore(
      supportGroup,
      targetGroup,
      fileSignals,
    ),
    sharedSubjectWordCount: Math.min(
      countSharedSubjectWords(supportSubject.words, targetSubject.words),
      3,
    ),
    supportSubject,
    targetFileCount: targetGroup.files.length,
    targetSubject,
  };
}

function getSupportPathAffinityScore(
  supportGroup: PlannedCommit,
  targetGroup: PlannedCommit,
  fileSignals: Map<string, FileChangeSignals>,
): number {
  const supportWords = collectOwnershipWords(supportGroup, fileSignals, {
    includeSupportScope: true,
  });
  const targetWords = collectOwnershipWords(targetGroup, fileSignals, {
    includeSupportScope: false,
  });
  const sharedWordCount = countSharedSubjectWords(supportWords, targetWords);

  return sharedWordCount > 0 ? Math.min(sharedWordCount + 2, 4) : 0;
}

function getSupportSurfaceScore(signals: AttachmentSignals): number {
  let score = 0;

  if (signals.sharedPaths) {
    score += 5;
  }
  if (signals.hasDependencySignal) {
    score += 4;
  }
  if (signals.hasExactScopeSignal) {
    score += 6 + getExactScopePriorityBonus(signals);
  } else if (signals.hasScopeSignal) {
    score += 3;
  }

  return score + signals.sharedPathScore;
}

function getSupportWordOverlapScore(signals: AttachmentSignals): number {
  return (
    signals.sharedSubjectWordCount +
    (signals.hasHighWordOverlap ? 2 : 0) +
    getTestSupportIntentScore(signals)
  );
}

function getTestSupportIntentScore(signals: AttachmentSignals): number {
  if (
    signals.supportSubject.type !== "test" ||
    signals.targetSubject.type === "test" ||
    signals.sharedSubjectWordCount < 2
  ) {
    return 0;
  }

  return Math.max(4, Math.min(signals.sharedIntentScore, 4));
}

function shouldRejectStyleSupportAttachment(
  signals: AttachmentSignals,
): boolean {
  return (
    signals.supportSubject.type === "style" &&
    signals.targetSubject.type !== "style" &&
    !signals.hasCoverageSignal
  );
}
