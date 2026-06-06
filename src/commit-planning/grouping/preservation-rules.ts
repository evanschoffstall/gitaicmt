import { groupsSharePaths } from "./commit-coverage.js";
import {
  type FileChangeSignals,
  type PlannedCommit,
} from "./grouping-types.js";
import { inferSplitSupportScopeFromPath } from "./ownership.js";
import { isDeepNestedInternalUmbrella } from "./structural-fanout.js";
import {
  countSharedSubjectWords,
  isSupportLikeType,
  parseSubjectWords,
  scopesRelated,
} from "./subject/analysis.js";
import { getSupportAttachmentScore } from "./support-attachment/scoring.js";

export { isDeepNestedInternalUmbrella };

interface ImplementationSupportPairContext {
  consolidatedSubject: ReturnType<typeof parseSubjectWords>;
  implementationGroup: PlannedCommit;
  implementationSubject: ReturnType<typeof parseSubjectWords>;
  supportGroup: PlannedCommit;
  supportSubject: ReturnType<typeof parseSubjectWords>;
}

export function hasSharedSupportSubtree(group: PlannedCommit): boolean {
  if (group.files.length < 2) {
    return false;
  }

  const directories = group.files.map((file) =>
    file.path.split("/").slice(0, -1),
  );
  const minimumDepth = Math.min(...directories.map((parts) => parts.length));
  let sharedDepth = 0;

  for (let depth = 0; depth < minimumDepth; depth++) {
    const segment = directories[0][depth];
    if (directories.some((parts) => parts[depth] !== segment)) {
      break;
    }
    sharedDepth++;
  }

  return sharedDepth >= 2;
}

export function shouldPreserveCompactImplementationSupportRollout(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): boolean {
  const pair = getSupportImplementationPairContext(group, coveredGroups);
  if (!pair) {
    return false;
  }

  return (
    pair.consolidatedSubject.type === pair.supportSubject.type &&
    pair.consolidatedSubject.scope === pair.supportSubject.scope &&
    countSharedSubjectWords(
      pair.consolidatedSubject.words,
      pair.supportSubject.words,
    ) >= 2 &&
    countSharedSubjectWords(
      pair.consolidatedSubject.words,
      pair.implementationSubject.words,
    ) >= 2
  );
}

export function shouldPreserveCompactSupportFamily(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): boolean {
  if (coveredGroups.length > 3 || group.files.length > 6) {
    return false;
  }

  const subjects = coveredGroups.map((coveredGroup) =>
    parseSubjectWords(
      coveredGroup.message.split("\n")[0] ?? coveredGroup.message,
    ),
  );
  if (subjects.some((subject) => !isSupportLikeType(subject.type))) {
    return false;
  }

  const scopes = new Set(
    subjects.map((subject) => subject.scope).filter(Boolean),
  );
  if (scopes.size !== 1) {
    return false;
  }

  for (let leftIndex = 0; leftIndex < coveredGroups.length; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < coveredGroups.length;
      rightIndex++
    ) {
      if (
        groupsSharePaths(coveredGroups[leftIndex], coveredGroups[rightIndex])
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Keeps broad support-only umbrellas from collapsing unrelated support scopes
 * when the covered groups already express distinct support intents.
 */
export function shouldPreserveDivergentSupportBaseline(
  groups: PlannedCommit[],
): boolean {
  if (groups.length <= 1) {
    return false;
  }

  const supportSubjects = groups.map((group) =>
    parseSubjectWords(group.message.split("\n")[0] ?? group.message),
  );
  if (supportSubjects.some((subject) => !isSupportLikeType(subject.type))) {
    return false;
  }

  const distinctSupportTypes = new Set(
    supportSubjects.map((subject) => subject.type),
  );
  if (distinctSupportTypes.size <= 1) {
    return false;
  }

  const distinctSupportScopes = new Set(
    groups.flatMap((group) =>
      group.files.map((file) => inferSplitSupportScopeFromPath(file.path)),
    ),
  );

  return distinctSupportScopes.size >= 3;
}

export function shouldPreserveImplementationLedChoreRollout(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): boolean {
  if (coveredGroups.length < 2 || coveredGroups.length > 4) {
    return false;
  }

  const consolidatedSubject = parseSubjectWords(
    group.message.split("\n")[0] ?? group.message,
  );
  if (isSupportLikeType(consolidatedSubject.type)) {
    return false;
  }

  const coveredSubjects = coveredGroups.map((coveredGroup) =>
    parseSubjectWords(
      coveredGroup.message.split("\n")[0] ?? coveredGroup.message,
    ),
  );
  const implementationIndexes = coveredSubjects
    .map((subject, index) => (isSupportLikeType(subject.type) ? -1 : index))
    .filter((index) => index !== -1);
  if (implementationIndexes.length !== 1) {
    return false;
  }

  const implementationSubject = coveredSubjects[implementationIndexes[0]];
  if (
    consolidatedSubject.type !== implementationSubject.type ||
    consolidatedSubject.scope !== implementationSubject.scope
  ) {
    return false;
  }

  const supportSubjects = coveredSubjects.filter((subject) =>
    isSupportLikeType(subject.type),
  );
  if (
    supportSubjects.length === 0 ||
    supportSubjects.some((subject) => subject.type !== "chore")
  ) {
    return false;
  }

  return supportSubjects.some(
    (subject) =>
      countSharedSubjectWords(implementationSubject.words, subject.words) >= 1,
  );
}

export function shouldPreserveScopedSingleTestRollout(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
): boolean {
  const pair = getTestImplementationPairContext(group, coveredGroups);
  if (!pair) {
    return false;
  }

  if (
    pair.supportGroup.files.length !== 1 ||
    pair.implementationGroup.files.length !== 1 ||
    pair.consolidatedSubject.type !== pair.implementationSubject.type ||
    pair.consolidatedSubject.scope !== pair.implementationSubject.scope ||
    !scopesRelated(pair.supportSubject.scope, pair.implementationSubject.scope)
  ) {
    return false;
  }

  const attachmentEvaluation = getSupportAttachmentScore(
    pair.supportGroup,
    pair.implementationGroup,
    fileSignals,
  );

  return (
    attachmentEvaluation.signals.sharedPathScore === 0 &&
    !attachmentEvaluation.signals.sharedPaths
  );
}

export function shouldRestoreBroadTestCoverageBaseline(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): boolean {
  const pair = getTestImplementationPairContext(group, coveredGroups);
  if (!pair || pair.supportGroup.files.length <= 1) {
    return false;
  }

  if (
    pair.consolidatedSubject.type !== pair.implementationSubject.type ||
    pair.consolidatedSubject.scope !== pair.implementationSubject.scope
  ) {
    return false;
  }

  const splitSupportScopes = new Set(
    pair.supportGroup.files.map((file) =>
      inferSplitSupportScopeFromPath(file.path),
    ),
  );
  if (
    (splitSupportScopes.size > 2 &&
      !hasSharedSupportSubtree(pair.supportGroup)) ||
    (splitSupportScopes.size <= 2 &&
      !splitSupportScopes.has(pair.implementationSubject.scope))
  ) {
    return true;
  }

  return (
    countSharedSubjectWords(
      pair.supportSubject.words,
      pair.implementationSubject.words,
    ) === 0 && !groupsSharePaths(pair.supportGroup, pair.implementationGroup)
  );
}

function getSupportImplementationPairContext(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): ImplementationSupportPairContext | null {
  if (coveredGroups.length !== 2) {
    return null;
  }

  const consolidatedSubject = parseSubjectWords(
    group.message.split("\n")[0] ?? group.message,
  );
  const coveredSubjects = coveredGroups.map((coveredGroup) =>
    parseSubjectWords(
      coveredGroup.message.split("\n")[0] ?? coveredGroup.message,
    ),
  );
  const supportIndex = coveredSubjects.findIndex((subject) =>
    isSupportLikeType(subject.type),
  );
  if (supportIndex === -1) {
    return null;
  }

  const implementationIndex = supportIndex === 0 ? 1 : 0;
  const supportGroup = coveredGroups[supportIndex];
  const implementationGroup = coveredGroups[implementationIndex];
  const supportSubject = coveredSubjects[supportIndex];
  const implementationSubject = coveredSubjects[implementationIndex];
  if (isSupportLikeType(implementationSubject.type)) {
    return null;
  }

  return {
    consolidatedSubject,
    implementationGroup,
    implementationSubject,
    supportGroup,
    supportSubject,
  };
}

function getTestImplementationPairContext(
  group: PlannedCommit,
  coveredGroups: PlannedCommit[],
): ImplementationSupportPairContext | null {
  const pair = getSupportImplementationPairContext(group, coveredGroups);
  if (pair?.supportSubject.type !== "test") {
    return null;
  }

  return pair;
}
