import type { FileDiff, PlannedCommit } from "../grouping-types.js";

import { isSupportLikePath } from "../../path/index.js";
import {
  inferSplitSupportScopeFromPath,
  inferSupportScopeFromPath,
} from "../ownership.js";
import { buildSplitSupportMessage } from "../repartition.js";
import { buildScopedMessage } from "../scoped-message.js";
import {
  isSupportLikeType,
  parseSubjectWords,
  scopesRelated,
} from "../subject/analysis.js";
import { emitNormalizationEvent } from "./events.js";
import { rescopeGroupMessageToCoveredGroups } from "./message-harmonization.js";
import { shouldPreserveFeatureSurfaceRollout } from "./rollout-preservation.js";
import { splitGroupByStructuralOwner } from "./structural-owner-splitting.js";

export function hasOnlyScopedSingleFileTestPairs(
  groups: PlannedCommit[],
): boolean {
  let foundScopedTestPair = false;

  for (const group of groups) {
    const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
    if (!isSupportLikeType(subject.type)) {
      continue;
    }

    if (subject.type !== "test" || group.files.length !== 1) {
      return false;
    }

    const matchingImplementationCount = groups.filter((candidate) => {
      if (candidate === group || candidate.files.length !== 1) {
        return false;
      }

      const candidateSubject = parseSubjectWords(
        candidate.message.split("\n")[0] ?? "",
      );
      return (
        !isSupportLikeType(candidateSubject.type) &&
        subject.scope.length > 0 &&
        candidateSubject.scope.length > 0 &&
        scopesRelated(subject.scope, candidateSubject.scope)
      );
    }).length;

    if (matchingImplementationCount !== 1) {
      return false;
    }

    foundScopedTestPair = true;
  }

  return foundScopedTestPair;
}

export function normalizeBroadSupportGroups(
  groups: PlannedCommit[],
  sourceGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  return normalizeRescopedSplitGroups(
    groups,
    sourceGroups,
    fileByPath,
    "broad-support",
    splitBroadSupportGroup,
  );
}

export function normalizeMixedRootImplementationGroups(
  groups: PlannedCommit[],
  sourceGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  return normalizeRescopedSplitGroups(
    groups,
    sourceGroups,
    fileByPath,
    "mixed-root-implementation",
    splitMixedRootImplementationGroup,
  );
}

function countLexicallyAlignedSupportScopes(
  supportScopes: Set<string>,
  subjectLine: string,
): number {
  const normalizedSubjectTokens = new Set(
    subjectLine
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length >= 2),
  );
  let alignedScopeCount = 0;

  for (const supportScope of supportScopes) {
    const scopeWords = supportScope
      .split(/[^a-z0-9]+/iu)
      .filter((word) => word.length >= 2);
    if (scopeWords.length === 0) {
      continue;
    }
    if (scopeWords.some((word) => normalizedSubjectTokens.has(word))) {
      alignedScopeCount++;
    }
  }

  return alignedScopeCount;
}

function getBroadSupportPreservationReason(
  group: PlannedCommit,
  subjectType: string,
  supportScopes: Set<string>,
): string {
  if (subjectType !== "test") {
    return "non-test-support-subject";
  }

  if (group.files.length <= 1) {
    return "single-file-support-group";
  }

  if (supportScopes.size <= 1) {
    return "single-support-scope";
  }

  return "preserve-broad-support-group";
}

function isNonSplitImplementationSubject(subjectType: string): boolean {
  return (
    subjectType.length === 0 ||
    subjectType === "style" ||
    subjectType === "test"
  );
}

function normalizeRescopedSplitGroups(
  groups: PlannedCommit[],
  sourceGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  normalizationKind: string,
  splitGroup: (group: PlannedCommit) => PlannedCommit[],
): PlannedCommit[] {
  return groups.flatMap((group) => {
    const splitGroups = splitGroup(group);
    if (splitGroups.length === 1 && splitGroups[0] === group) {
      return group;
    }

    const rescopedSplitGroups = splitGroups.map((splitGroup) =>
      rescopeGroupMessageToCoveredGroups(splitGroup, sourceGroups, fileByPath),
    );

    emitNormalizationEvent({
      inputGroup: group,
      normalizationKind,
      outputGroups: rescopedSplitGroups,
      resolution: "split",
    });

    return rescopedSplitGroups;
  });
}

function shouldPreserveCompactSupportRollout(
  group: PlannedCommit,
  subjectLine: string,
  subjectWords: Set<string>,
  supportScopes: Set<string>,
): boolean {
  return (
    parseSubjectWords(group.message.split("\n")[0] ?? "").type === "test" &&
    group.files.length <= 4 &&
    supportScopes.size <= 3 &&
    subjectWords.size >= 2 &&
    countLexicallyAlignedSupportScopes(supportScopes, subjectLine) <= 1
  );
}

function splitBroadSupportGroup(group: PlannedCommit): PlannedCommit[] {
  const subjectLine = group.message.split("\n")[0] ?? "";
  const subject = parseSubjectWords(subjectLine);
  const supportScopes = new Set(
    group.files.map(
      (file) =>
        inferSplitSupportScopeFromPath(file.path) ||
        inferSupportScopeFromPath(file.path),
    ),
  );
  if (
    shouldPreserveCompactSupportRollout(
      group,
      subjectLine,
      subject.words,
      supportScopes,
    )
  ) {
    emitNormalizationEvent({
      inputGroup: group,
      normalizationKind: "broad-support",
      reason: "compact-support-rollout",
      resolution: "preserve",
    });
    return [group];
  }
  if (
    subject.type !== "test" ||
    group.files.length <= 1 ||
    supportScopes.size <= 1
  ) {
    emitNormalizationEvent({
      inputGroup: group,
      normalizationKind: "broad-support",
      reason: getBroadSupportPreservationReason(
        group,
        subject.type,
        supportScopes,
      ),
      resolution: "preserve",
    });
    return [group];
  }

  return group.files.map((file) => ({
    files: [file],
    message: buildSplitSupportMessage(group, file.path),
  }));
}

function splitMixedRootImplementationGroup(
  group: PlannedCommit,
): PlannedCommit[] {
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
  if (isNonSplitImplementationSubject(subject.type)) {
    emitNormalizationEvent({
      inputGroup: group,
      normalizationKind: "mixed-root-implementation",
      reason: "non-split-implementation-subject",
      resolution: "preserve",
    });
    return [group];
  }

  if (group.files.some((file) => isSupportLikePath(file.path))) {
    emitNormalizationEvent({
      inputGroup: group,
      normalizationKind: "mixed-root-implementation",
      reason: "support-like-path-present",
      resolution: "preserve",
    });
    return [group];
  }

  const splitGroups = splitGroupByStructuralOwner(group, (root) =>
    buildScopedMessage(group.message, root),
  );
  if (splitGroups === null) {
    emitNormalizationEvent({
      inputGroup: group,
      normalizationKind: "mixed-root-implementation",
      reason: "single-structural-owner",
      resolution: "preserve",
    });
    return [group];
  }

  if (shouldPreserveFeatureSurfaceRollout(group)) {
    emitNormalizationEvent({
      inputGroup: group,
      normalizationKind: "mixed-root-implementation",
      reason: "feature-surface-rollout",
      resolution: "preserve",
    });
    return [group];
  }

  return splitGroups;
}
