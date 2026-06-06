import type { FileDiff, PlannedCommit } from "../grouping-types.js";

import { getMeaningfulPathWords, isSupportLikePath } from "../../path/index.js";
import { mergeCompactExactRolloutFamilies } from "../compact-rollout-families.js";
import {
  getPathOwnerDescriptor,
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

function collectImplementationOwnershipWords(
  group: PlannedCommit,
): Set<string> {
  const words = new Set<string>();

  for (const file of group.files) {
    if (isSupportLikePath(file.path)) {
      continue;
    }

    const owner = getPathOwnerDescriptor(file.path);
    for (const word of getMeaningfulPathWords(file.path)) {
      words.add(word);
    }
    for (const word of getMeaningfulPathWords(owner.featureRoot)) {
      words.add(word);
    }
    for (const word of getMeaningfulPathWords(owner.ownerId)) {
      words.add(word);
    }
  }

  return words;
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
  const alignedScopeWords = new Set<string>();

  for (const supportScope of supportScopes) {
    const scopeWords = supportScope
      .split(/[^a-z0-9]+/iu)
      .filter((word) => word.length >= 2);
    if (scopeWords.length === 0) {
      continue;
    }
    for (const word of scopeWords) {
      if (normalizedSubjectTokens.has(word)) {
        alignedScopeWords.add(word);
      }
    }
  }

  return alignedScopeWords.size;
}

function hasImplementationOwnershipOverlap(
  filePath: string,
  implementationWords: Set<string>,
): boolean {
  const supportWords = [
    ...getMeaningfulPathWords(filePath),
    ...getMeaningfulPathWords(inferSupportScopeFromPath(filePath)),
    ...getMeaningfulPathWords(inferSplitSupportScopeFromPath(filePath)),
  ];

  return supportWords.some((word) => implementationWords.has(word));
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

    const rescopedSplitGroups = mergeCompactExactRolloutFamilies(
      splitGroups.map((splitGroup) =>
        rescopeGroupMessageToCoveredGroups(
          splitGroup,
          sourceGroups,
          fileByPath,
        ),
      ),
      fileByPath,
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

function partitionSupportLikeFiles(group: PlannedCommit): {
  implementationFiles: PlannedCommit["files"];
  supportFiles: PlannedCommit["files"];
} {
  return {
    implementationFiles: group.files.filter(
      (file) => !isSupportLikePath(file.path),
    ),
    supportFiles: group.files.filter((file) => isSupportLikePath(file.path)),
  };
}

function preserveMixedRootImplementationGroup(
  group: PlannedCommit,
  reason:
    | "feature-surface-rollout"
    | "non-split-implementation-subject"
    | "single-structural-owner"
    | "support-like-path-present",
): PlannedCommit[] {
  emitNormalizationEvent({
    inputGroup: group,
    normalizationKind: "mixed-root-implementation",
    reason,
    resolution: "preserve",
  });

  return [group];
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
    const reason =
      subject.type !== "test"
        ? "non-test-support-subject"
        : group.files.length <= 1
          ? "single-file-support-group"
          : supportScopes.size <= 1
            ? "single-support-scope"
            : "preserve-broad-support-group";
    emitNormalizationEvent({
      inputGroup: group,
      normalizationKind: "broad-support",
      reason,
      resolution: "preserve",
    });
    return [group];
  }

  return group.files.map((file) => ({
    files: [file],
    message: buildSplitSupportMessage(group, file.path),
  }));
}

function splitMisalignedSupportFiles(
  group: PlannedCommit,
): null | PlannedCommit[] {
  const { implementationFiles, supportFiles } =
    partitionSupportLikeFiles(group);
  if (implementationFiles.length === 0 || supportFiles.length <= 1) {
    return null;
  }

  const implementationWords = collectImplementationOwnershipWords(group);
  const alignedSupportFiles = supportFiles.filter((file) =>
    hasImplementationOwnershipOverlap(file.path, implementationWords),
  );
  if (alignedSupportFiles.length === supportFiles.length) {
    return null;
  }

  const alignedSupportPaths = new Set(
    alignedSupportFiles.map((file) => file.path),
  );
  const detachedSupportFiles = supportFiles.filter(
    (file) => !alignedSupportPaths.has(file.path),
  );

  return [
    {
      files: [...implementationFiles, ...alignedSupportFiles],
      message: group.message,
    },
    ...detachedSupportFiles.map((file) => ({
      files: [file],
      message: buildSplitSupportMessage(group, file.path),
    })),
  ];
}

function splitMixedRootImplementationGroup(
  group: PlannedCommit,
): PlannedCommit[] {
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
  if (isNonSplitImplementationSubject(subject.type)) {
    return preserveMixedRootImplementationGroup(
      group,
      "non-split-implementation-subject",
    );
  }

  if (group.files.some((file) => isSupportLikePath(file.path))) {
    const splitSupportGroups = splitMisalignedSupportFiles(group);
    if (splitSupportGroups !== null) {
      return splitSupportGroups.flatMap((splitGroup) =>
        splitGroup.files.some((file) => isSupportLikePath(file.path))
          ? [splitGroup]
          : splitMixedRootImplementationGroup(splitGroup),
      );
    }

    const splitImplementationOwners =
      subject.type === "chore"
        ? null
        : splitSupportBearingImplementationOwners(group);
    if (splitImplementationOwners !== null) {
      return splitImplementationOwners;
    }

    return preserveMixedRootImplementationGroup(
      group,
      "support-like-path-present",
    );
  }

  const splitGroups = splitGroupByStructuralOwner(group, (root) =>
    buildScopedMessage(group.message, root),
  );
  if (splitGroups === null) {
    return preserveMixedRootImplementationGroup(
      group,
      "single-structural-owner",
    );
  }

  if (shouldPreserveFeatureSurfaceRollout(group)) {
    return preserveMixedRootImplementationGroup(
      group,
      "feature-surface-rollout",
    );
  }

  return splitGroups;
}

function splitSupportBearingImplementationOwners(
  group: PlannedCommit,
): null | PlannedCommit[] {
  const { implementationFiles, supportFiles } =
    partitionSupportLikeFiles(group);

  if (implementationFiles.length === 0 || supportFiles.length === 0) {
    return null;
  }

  const implementationGroup = {
    files: implementationFiles,
    message: group.message,
  };
  const splitImplementationGroups = splitGroupByStructuralOwner(
    implementationGroup,
    (root) => buildScopedMessage(group.message, root),
  );
  if (splitImplementationGroups === null) {
    return null;
  }

  // When the implementation files include a direct-file (e.g. a parent index)
  // alongside nested-subtree children, splitting them fragments a parent-child
  // delivery and leaves support files homeless. Only split when all impl files
  // are in independent sibling subtrees with no shared direct-file anchor.
  const hasDirectFileAnchor = implementationFiles.some(
    (file) => getPathOwnerDescriptor(file.path).kind === "direct-file",
  );
  if (hasDirectFileAnchor) {
    return null;
  }

  return [
    ...splitImplementationGroups,
    ...supportFiles.map((file) => ({
      files: [file],
      message: buildSplitSupportMessage(group, file.path),
    })),
  ];
}
