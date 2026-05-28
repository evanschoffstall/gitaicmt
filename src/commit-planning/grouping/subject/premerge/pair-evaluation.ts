import { emitPremergePairEvaluationEvent } from "../../group/events.js";
import { type FileDiff, type PlannedCommit } from "../../grouping-types.js";
import {
  countSharedSubjectWords,
  getOrderedSubjectWords,
  hasHighWordOverlap,
  isSupportLikeType,
  parseSubjectWords,
} from "../analysis.js";
import {
  shouldPremergeCleanupFollowUp,
  shouldPremergeFeatureEntrypointFollowUp,
  shouldPremergeIdentifierFollowUp,
  shouldPremergeStyleSweep,
  shouldPremergeTestFollowUp,
} from "./follow-ups.js";
import { getSingleOwnerId } from "./structural-signals.js";

export interface PremergePairPassResult {
  matchedPairCount: number;
  pairCount: number;
  parent: number[];
}

interface PremergePairEvaluation {
  diagnostics: Record<string, boolean | number | string>;
  matchedRules: string[];
  shouldMerge: boolean;
}

export function findSubjectClusterRoot(
  parent: number[],
  value: number,
): number {
  let node = value;
  while (parent[node] !== node) {
    parent[node] = parent[parent[node]];
    node = parent[node];
  }

  return node;
}

/** Runs and emits deterministic pair-level premerge evaluations. */
export function runPremergePairPass(
  groups: PlannedCommit[],
  wordSets: ReturnType<typeof parseSubjectWords>[],
  fileByPath: Map<string, FileDiff>,
): PremergePairPassResult {
  const parent = groups.map((_, index) => index);
  let matchedPairCount = 0;
  const pairCount = (groups.length * (groups.length - 1)) / 2;

  for (let leftIndex = 0; leftIndex < groups.length; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < groups.length;
      rightIndex++
    ) {
      const evaluation = evaluatePremergePair(
        groups[leftIndex],
        groups[rightIndex],
        wordSets[leftIndex],
        wordSets[rightIndex],
        fileByPath,
      );
      emitPremergePairEvaluationEvent({
        diagnostics: evaluation.diagnostics,
        leftGroup: groups[leftIndex],
        matchedRules: evaluation.matchedRules,
        resolution: evaluation.shouldMerge ? "merge" : "keep-separate",
        rightGroup: groups[rightIndex],
      });
      if (!evaluation.shouldMerge) {
        continue;
      }

      matchedPairCount++;
      uniteSubjectCluster(parent, leftIndex, rightIndex);
    }
  }

  return { matchedPairCount, pairCount, parent };
}

function buildPremergePairDiagnostics(
  structuredAnchorDiagnostics: ReturnType<
    typeof getStructuredSubjectAnchorDiagnostics
  >,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
  matchedRules: string[],
): Record<string, boolean | number | string> {
  const matchedRuleSet = new Set(matchedRules);

  return {
    hasHighWordOverlap: hasHighWordOverlap(left.words, right.words),
    hasMatchingPrimaryAction:
      structuredAnchorDiagnostics.hasMatchingPrimaryAction,
    hasSharedOwner: structuredAnchorDiagnostics.hasSharedOwner,
    hasSharedStructuredScope:
      structuredAnchorDiagnostics.hasSharedStructuredScope,
    hasStructuredSubjectAnchor:
      structuredAnchorDiagnostics.hasStructuredSubjectAnchor,
    hasSupportStructuredAnchor:
      structuredAnchorDiagnostics.hasSupportStructuredAnchor,
    leftSubjectType: left.type,
    requiresMatchingAction: structuredAnchorDiagnostics.requiresMatchingAction,
    rightSubjectType: right.type,
    sharedSubjectWordCount: countSharedSubjectWords(left.words, right.words),
    shouldPremergeCleanupFollowUp: matchedRuleSet.has("cleanup-follow-up"),
    shouldPremergeFeatureEntrypointFollowUp: matchedRuleSet.has(
      "feature-entrypoint-follow-up",
    ),
    shouldPremergeIdentifierFollowUp: matchedRuleSet.has(
      "identifier-follow-up",
    ),
    shouldPremergeStyleSweep: matchedRuleSet.has("style-sweep"),
    shouldPremergeSubjects: matchedRuleSet.has("subjects"),
    shouldPremergeTestFollowUp: matchedRuleSet.has("test-follow-up"),
  };
}

/** Aggregates deterministic pair-level premerge heuristics in one place. */
function evaluatePremergePair(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
  fileByPath: Map<string, FileDiff>,
): PremergePairEvaluation {
  const structuredAnchorDiagnostics = getStructuredSubjectAnchorDiagnostics(
    leftGroup,
    rightGroup,
    left,
    right,
  );
  const matchedRules = getPremergeMatchedRules(
    leftGroup,
    rightGroup,
    left,
    right,
    fileByPath,
  );

  return {
    diagnostics: buildPremergePairDiagnostics(
      structuredAnchorDiagnostics,
      left,
      right,
      matchedRules,
    ),
    matchedRules,
    shouldMerge: matchedRules.length > 0,
  };
}

function getPremergeMatchedRules(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
  fileByPath: Map<string, FileDiff>,
): string[] {
  return [
    shouldPremergeSubjects(leftGroup, rightGroup, left, right)
      ? "subjects"
      : null,
    shouldPremergeStyleSweep(leftGroup, rightGroup, left, right)
      ? "style-sweep"
      : null,
    shouldPremergeIdentifierFollowUp(
      leftGroup,
      rightGroup,
      left,
      right,
      fileByPath,
    )
      ? "identifier-follow-up"
      : null,
    shouldPremergeFeatureEntrypointFollowUp(leftGroup, rightGroup, left, right)
      ? "feature-entrypoint-follow-up"
      : null,
    shouldPremergeTestFollowUp(leftGroup, rightGroup, left, right)
      ? "test-follow-up"
      : null,
    shouldPremergeCleanupFollowUp(
      leftGroup,
      rightGroup,
      left,
      right,
      fileByPath,
    )
      ? "cleanup-follow-up"
      : null,
  ].filter((rule): rule is string => rule !== null);
}

function getStructuredSubjectAnchorDiagnostics(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
): {
  hasMatchingPrimaryAction: boolean;
  hasSharedOwner: boolean;
  hasSharedStructuredScope: boolean;
  hasStructuredSubjectAnchor: boolean;
  hasSupportStructuredAnchor: boolean;
  requiresMatchingAction: boolean;
} {
  const hasSharedOwner = haveSharedSingleOwner(leftGroup, rightGroup);
  const hasMatchingPrimaryAction = haveMatchingPrimaryAction(
    leftGroup,
    rightGroup,
  );
  const bothStyle = left.type === "style" && right.type === "style";
  const requiresMatchingAction =
    !bothStyle &&
    (isSupportLikeType(left.type) || isSupportLikeType(right.type));
  const supportStructuredAnchor = hasSupportStructuredAnchor(
    leftGroup,
    rightGroup,
    left,
    right,
  );
  const sharedStructuredScope = hasSharedStructuredScope(left, right);
  const hasCompatibleStructuredAnchor =
    !requiresMatchingAction || hasMatchingPrimaryAction;

  return {
    hasMatchingPrimaryAction,
    hasSharedOwner,
    hasSharedStructuredScope: sharedStructuredScope,
    hasStructuredSubjectAnchor:
      supportStructuredAnchor ||
      (sharedStructuredScope && hasCompatibleStructuredAnchor) ||
      (hasSharedOwner && hasCompatibleStructuredAnchor),
    hasSupportStructuredAnchor: supportStructuredAnchor,
    requiresMatchingAction,
  };
}

function hasSharedStructuredScope(
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
): boolean {
  return left.scope.length > 0 && left.scope === right.scope;
}

function hasStructuredSubjectAnchor(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
): boolean {
  return getStructuredSubjectAnchorDiagnostics(
    leftGroup,
    rightGroup,
    left,
    right,
  ).hasStructuredSubjectAnchor;
}

function hasSupportStructuredAnchor(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
): boolean {
  if (
    !isSupportLikeType(left.type) ||
    !isSupportLikeType(right.type) ||
    left.type === "style" ||
    right.type === "style"
  ) {
    return false;
  }

  if (
    left.type === "test" &&
    right.type === "test" &&
    countSharedSubjectWords(left.words, right.words) >= 3
  ) {
    return true;
  }

  return (
    (leftGroup.message.split("\n")[0] ?? "") ===
    (rightGroup.message.split("\n")[0] ?? "")
  );
}

function haveMatchingPrimaryAction(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
): boolean {
  const leftAction = getOrderedSubjectWords(
    leftGroup.message.split("\n")[0] ?? "",
  )[0];
  const rightAction = getOrderedSubjectWords(
    rightGroup.message.split("\n")[0] ?? "",
  )[0];

  return leftAction === rightAction;
}

function haveSharedSingleOwner(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
): boolean {
  const leftOwner = getSingleOwnerId(leftGroup);
  const rightOwner = getSingleOwnerId(rightGroup);
  return leftOwner !== null && leftOwner === rightOwner;
}

function shouldPremergeSubjects(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  left: ReturnType<typeof parseSubjectWords>,
  right: ReturnType<typeof parseSubjectWords>,
): boolean {
  if (
    left.type === "" ||
    left.type !== right.type ||
    !hasHighWordOverlap(left.words, right.words)
  ) {
    return false;
  }

  return hasStructuredSubjectAnchor(leftGroup, rightGroup, left, right);
}

function uniteSubjectCluster(
  parent: number[],
  left: number,
  right: number,
): void {
  const leftRoot = findSubjectClusterRoot(parent, left);
  const rightRoot = findSubjectClusterRoot(parent, right);
  if (leftRoot !== rightRoot) {
    parent[rightRoot] = leftRoot;
  }
}
