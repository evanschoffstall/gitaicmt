import { readFileSync } from "node:fs";
import { posix as pathPosix } from "node:path";

import { complete } from "./ai-client.js";
import {
  buildClusterSystemPrompt,
  buildClusterUserPrompt,
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
} from "./ai-prompt-builders.js";
import { type PlannedCommit, type PlannedCommitFile } from "./ai-types.js";
import { validateAndNormalizeGrouping } from "./ai-validation.js";
import {
  parseConventionalSubject,
  sanitizeSubjectWords,
} from "./commit-subject.js";
import {
  CLUSTERING_THRESHOLD,
  MAX_CLUSTER_PASSES,
  MAX_CONSOLIDATION_PASSES,
} from "./constants.js";
import { ValidationError } from "./errors.js";

interface ChangedFileSignals {
  importedPaths: Set<string>;
  intentWords: Set<string>;
  isCoordinatorLike: boolean;
  pathWords: Set<string>;
  providedSymbols: Set<string>;
  referencedSymbols: Set<string>;
}

type FileDiff = import("./diff.js").FileDiff;

export async function finalizePlannedGroups(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
): Promise<PlannedCommit[]> {
  if (groups.length < 2) {
    return groups;
  }

  const fileByPath = new Map(allFiles.map((file) => [file.path, file]));
  const fileSignals = buildChangedFileSignals(allFiles);

  let current = premergeBySubject(groups, fileByPath);
  const baselineGroups = current;

  if (!hasPotentialMergeSignals(current)) {
    return orderCommitsByDependencies(current, fileSignals);
  }

  current = await clusterAndMerge(current, fileByPath);

  for (
    let pass = 0;
    pass < MAX_CONSOLIDATION_PASSES && current.length > 1;
    pass++
  ) {
    if (!hasPotentialMergeSignals(current)) {
      break;
    }

    const previousLength = current.length;
    const consolidated = await consolidateOnce(allFiles, current, fileByPath);

    if (!consolidated) {
      break;
    }

    current = consolidated;
    if (consolidated.length >= previousLength || consolidated.length <= 2) {
      break;
    }
  }

  current = splitWeakConsolidations(
    baselineGroups,
    current,
    fileByPath,
    fileSignals,
  );

  return orderCommitsByDependencies(current, fileSignals);
}

function addChangedPathAlias(
  aliases: Map<string, string[]>,
  alias: string,
  changedPath: string,
): void {
  const existing = aliases.get(alias);
  if (!existing) {
    aliases.set(alias, [changedPath]);
    return;
  }

  if (!existing.includes(changedPath)) {
    existing.push(changedPath);
  }
}

function applyCommitClusters(
  groups: PlannedCommit[],
  clusters: number[][],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const result: PlannedCommit[] = [];

  for (const cluster of clusters) {
    if (cluster.length === 0) continue;
    if (cluster.length === 1) {
      result.push(groups[cluster[0]]);
      continue;
    }

    const commitsToMerge = cluster.map((index) => groups[index]);
    if (commitsToMerge.length === 0) continue;

    result.push({
      files: mergeCommitFiles(commitsToMerge, fileByPath),
      message: mergeCommitMessages(commitsToMerge),
    });
  }

  return result;
}

function buildChangedFileSignals(
  allFiles: FileDiff[],
): Map<string, ChangedFileSignals> {
  const changedPaths = new Set(allFiles.map((file) => file.path));
  const changedPathAliases = buildChangedPathAliases(changedPaths);
  const fileSignals = new Map<string, ChangedFileSignals>();

  for (const file of allFiles) {
    const importedPaths = new Set<string>();
    const pathWords = extractPathWords(file.path);
    const providedSymbols = new Set<string>();
    const referencedSymbols = new Set<string>();

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("---") || line.startsWith("-")) {
          continue;
        }

        const sourceLine =
          line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : line;
        collectChangedFileLineSignals(
          sourceLine,
          file.path,
          changedPathAliases,
          importedPaths,
          providedSymbols,
          referencedSymbols,
        );
      }
    }

    for (const sourceLine of readCurrentFileSignalLines(file.path)) {
      collectChangedFileLineSignals(
        sourceLine,
        file.path,
        changedPathAliases,
        importedPaths,
        providedSymbols,
        referencedSymbols,
      );
    }

    fileSignals.set(file.path, {
      importedPaths,
      intentWords: extractIntentWords(file.path, file.hunks),
      isCoordinatorLike: isCoordinatorLikeFile(
        importedPaths,
        pathWords,
        providedSymbols,
      ),
      pathWords,
      providedSymbols,
      referencedSymbols,
    });
  }

  return fileSignals;
}

/**
 * Build lookup aliases from the actual changed paths so dependency ordering can
 * compare exact module paths and generic path stems without a fixed extension
 * whitelist or directory-entry convention.
 */
function buildChangedPathAliases(
  changedPaths: Iterable<string>,
): Map<string, string[]> {
  const aliases = new Map<string, string[]>();

  for (const changedPath of changedPaths) {
    const normalizedPath = pathPosix.normalize(changedPath);
    addChangedPathAlias(aliases, normalizedPath, changedPath);

    const stemPath = stripPathExtension(normalizedPath);
    if (stemPath !== normalizedPath) {
      addChangedPathAlias(aliases, stemPath, changedPath);
    }
  }

  return aliases;
}

async function callCluster(
  groups: PlannedCommit[],
): Promise<null | number[][]> {
  try {
    const sys = buildClusterSystemPrompt();
    const usr = buildClusterUserPrompt(groups);
    const raw = await complete(sys, usr, { stage: "cluster" });
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");
    const parsed = JSON.parse(cleaned) as unknown;

    if (!Array.isArray(parsed)) return null;

    const seen = new Set<number>();
    for (const cluster of parsed) {
      if (!Array.isArray(cluster)) return null;
      for (const idx of cluster) {
        if (typeof idx !== "number" || idx < 0 || idx >= groups.length) {
          return null;
        }
        if (seen.has(idx)) {
          return null;
        }
        seen.add(idx);
      }
    }

    const clusters = parsed as number[][];
    for (let index = 0; index < groups.length; index++) {
      if (!seen.has(index)) {
        clusters.push([index]);
      }
    }

    if (!clusters.some((cluster) => cluster.length > 1)) {
      return null;
    }

    return clusters;
  } catch {
    return null;
  }
}

function chooseDependencyOrderIndex(
  remainingIndexes: Set<number>,
  indegree: number[],
  edges: Map<number, Set<number>>,
  edgeWeights: Map<string, number>,
): number | undefined {
  let selectedIndex: number | undefined;
  let selectedIndegree = Number.POSITIVE_INFINITY;
  let selectedIncomingWeight = Number.POSITIVE_INFINITY;
  let selectedOutgoingWeight = Number.NEGATIVE_INFINITY;

  for (const index of remainingIndexes) {
    const incomingWeight = getIncomingDependencyWeight(
      index,
      remainingIndexes,
      edgeWeights,
    );
    const outgoingWeight = getOutgoingDependencyWeight(
      index,
      remainingIndexes,
      edges,
      edgeWeights,
    );

    if (indegree[index] < selectedIndegree) {
      selectedIndex = index;
      selectedIndegree = indegree[index];
      selectedIncomingWeight = incomingWeight;
      selectedOutgoingWeight = outgoingWeight;
      continue;
    }
    if (indegree[index] > selectedIndegree) {
      continue;
    }

    if (incomingWeight < selectedIncomingWeight) {
      selectedIndex = index;
      selectedIncomingWeight = incomingWeight;
      selectedOutgoingWeight = outgoingWeight;
      continue;
    }
    if (incomingWeight > selectedIncomingWeight) {
      continue;
    }

    if (outgoingWeight > selectedOutgoingWeight) {
      selectedIndex = index;
      selectedOutgoingWeight = outgoingWeight;
    }
  }

  return selectedIndex;
}

// ─── Consolidation ───────────────────────────────────────────────────────────

function chooseSupportAttachment(
  supportGroup: PlannedCommit,
  groups: PlannedCommit[],
  components: number[][],
  fileSignals: Map<string, ChangedFileSignals>,
): number {
  let bestComponentIndex = -1;
  let bestScore = 0;
  let secondBestScore = 0;

  for (
    let componentIndex = 0;
    componentIndex < components.length;
    componentIndex++
  ) {
    const component = components[componentIndex];
    let componentScore = 0;

    for (const index of component) {
      componentScore = Math.max(
        componentScore,
        getSupportAttachmentScore(supportGroup, groups[index], fileSignals),
      );
    }

    componentScore -= getSupportAttachmentBreadthPenalty(
      supportGroup,
      component,
      groups,
      fileSignals,
    );

    if (componentScore > bestScore) {
      secondBestScore = bestScore;
      bestScore = componentScore;
      bestComponentIndex = componentIndex;
      continue;
    }

    if (componentScore > secondBestScore) {
      secondBestScore = componentScore;
    }
  }

  if (bestScore - secondBestScore <= 1) {
    return -1;
  }

  return bestScore >= 3 ? bestComponentIndex : -1;
}

async function clusterAndMerge(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): Promise<PlannedCommit[]> {
  let current = groups;

  for (
    let pass = 0;
    pass < MAX_CLUSTER_PASSES &&
    current.length >= CLUSTERING_THRESHOLD &&
    hasPotentialMergeSignals(current);
    pass++
  ) {
    const clusters = await callCluster(current);
    if (!clusters) {
      break;
    }

    const merged = applyCommitClusters(current, clusters, fileByPath);
    if (!hasMatchingCoverage(current, merged, fileByPath)) {
      break;
    }
    if (merged.length >= current.length) {
      break;
    }

    current = merged;
  }

  return current;
}

function collectChangedFileLineSignals(
  sourceLine: string,
  importerPath: string,
  changedPathAliases: Map<string, string[]>,
  importedPaths: Set<string>,
  providedSymbols: Set<string>,
  referencedSymbols: Set<string>,
): void {
  for (const modulePath of extractModuleSpecifiers(sourceLine)) {
    if (!modulePath.startsWith(".")) {
      continue;
    }

    const resolvedPath = resolveChangedModulePath(
      importerPath,
      modulePath,
      changedPathAliases,
    );
    if (resolvedPath) {
      importedPaths.add(resolvedPath);
    }
  }

  for (const symbol of extractReferencedSymbols(sourceLine)) {
    referencedSymbols.add(symbol);
  }
  for (const symbol of extractProvidedSymbols(sourceLine)) {
    providedSymbols.add(symbol);
  }
}

function commitDependsOn(
  dependent: PlannedCommit,
  dependency: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
): boolean {
  return getCommitDependencyScore(dependent, dependency, fileSignals) >= 4;
}

async function consolidateOnce(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): Promise<null | PlannedCommit[]> {
  try {
    const sys = buildConsolidationSystemPrompt();
    const usr = buildConsolidationUserPrompt(allFiles, groups);
    const raw = await complete(sys, usr, { stage: "consolidate" });
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");
    const parsed = JSON.parse(cleaned) as unknown;
    const consolidated = validateAndNormalizeGrouping(parsed, fileByPath);

    if (!hasMatchingCoverage(groups, consolidated, fileByPath)) {
      return null;
    }

    return harmonizeConsolidatedMessages(groups, consolidated, fileByPath);
  } catch {
    return null;
  }
}

function countSharedSubjectWords(
  left: Set<string>,
  right: Set<string>,
): number {
  let count = 0;
  for (const leftWord of left) {
    for (const rightWord of right) {
      if (wordsRelated(leftWord, rightWord)) {
        count++;
        break;
      }
    }
  }
  return count;
}

function extractIntentWords(
  path: string,
  hunks: FileDiff["hunks"],
): Set<string> {
  const intentWords = new Set<string>();

  for (const word of extractPathWords(path)) {
    intentWords.add(word);
  }

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("---") || line.startsWith("-")) {
        continue;
      }

      const sourceLine =
        line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : line;
      for (const word of sanitizeSubjectWords(sourceLine)) {
        if (word.length >= 4 && !STOP_WORDS.has(word)) {
          intentWords.add(word);
        }
      }
    }
  }

  return intentWords;
}

/**
 * Collect relative path-like tokens from diff text without assuming a specific
 * language, import syntax, or file format.
 */
function extractModuleSpecifiers(line: string): Set<string> {
  const specifiers = new Set<string>();
  const matches = line.matchAll(
    new RegExp(
      "(^|[^A-Za-z0-9_./-])(\\.{1,2}\\/[^\\s\"'`(){};,\\]]+)(?=$|[^A-Za-z0-9_./-])",
      "gu",
    ),
  );

  for (const match of matches) {
    const specifier = match[2];
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  return specifiers;
}

function extractPathWords(path: string): Set<string> {
  const baseName = pathPosix.basename(path).replace(/\.[^.]+$/u, "");
  return new Set(
    sanitizeSubjectWords(baseName).filter((word) => word.length >= 3),
  );
}

function extractProvidedSymbols(line: string): Set<string> {
  const provided = new Set<string>();
  const tokens = line.split(/[^A-Za-z0-9_$]+/u).filter(Boolean);

  if (tokens[0] !== "export") {
    return provided;
  }

  const declarationIndex = tokens[1] === "async" ? 2 : 1;
  const declarationType = tokens[declarationIndex];
  const symbol = tokens[declarationIndex + 1];

  if (
    declarationType &&
    symbol &&
    [
      "class",
      "const",
      "enum",
      "function",
      "interface",
      "let",
      "type",
      "var",
    ].includes(declarationType) &&
    isSignalIdentifier(symbol)
  ) {
    provided.add(symbol);
  }

  return provided;
}

function extractReferencedSymbols(line: string): Set<string> {
  const referenced = new Set<string>();
  const tokens = line.split(/[^A-Za-z0-9_$]+/u);

  for (const symbol of tokens) {
    if (symbol && isSignalIdentifier(symbol)) {
      referenced.add(symbol);
    }
  }

  return referenced;
}

/**
 * Treat the leading significant subject word as the primary action so merge
 * decisions stay anchored on what changed, not on broad workflow vocabulary.
 */
function getCommitActionWords(group: PlannedCommit): Set<string> {
  const subjectWords = getOrderedSubjectWords(
    group.message.split("\n")[0] ?? "",
  );
  return new Set(subjectWords.slice(0, 1));
}

function getCommitArtifactWords(
  group: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
): Set<string> {
  const artifactWords = new Set<string>();
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
  const subjectWords = getOrderedSubjectWords(
    group.message.split("\n")[0] ?? "",
  );
  const actionWords = getCommitActionWords(group);

  for (const word of subjectWords) {
    if (!actionWords.has(word)) {
      artifactWords.add(word);
    }
  }

  for (const scopeWord of sanitizeSubjectWords(subject.scope)) {
    if (scopeWord.length >= 3 && !STOP_WORDS.has(scopeWord)) {
      artifactWords.add(scopeWord);
    }
  }

  for (const word of getCommitIntentWords(group, fileSignals)) {
    if (!actionWords.has(word)) {
      artifactWords.add(word);
    }
  }

  return artifactWords;
}

function getCommitDependencyScore(
  dependent: PlannedCommit,
  dependency: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
): number {
  let score = 0;
  const dependencyPaths = new Set(dependency.files.map((file) => file.path));
  const dependencyProvidedSymbols = new Set<string>();
  const dependencyPathWords = new Set<string>();
  const dependencySubject = parseSubjectWords(
    dependency.message.split("\n")[0] ?? "",
  );
  const dependentSubject = parseSubjectWords(
    dependent.message.split("\n")[0] ?? "",
  );

  for (const file of dependency.files) {
    const signals = fileSignals.get(file.path);
    if (!signals) {
      continue;
    }

    for (const symbol of signals.providedSymbols) {
      dependencyProvidedSymbols.add(symbol);
    }
    for (const word of signals.pathWords) {
      dependencyPathWords.add(word);
    }
  }

  for (const file of dependent.files) {
    const signals = fileSignals.get(file.path);
    if (!signals) {
      continue;
    }

    for (const importedPath of signals.importedPaths) {
      if (dependencyPaths.has(importedPath)) {
        score += 6;
      }
    }

    for (const symbol of signals.referencedSymbols) {
      if (dependencyProvidedSymbols.has(symbol)) {
        score += 4;
      }
    }
  }

  const sharedPathWordCount = countSharedSubjectWords(
    dependentSubject.words,
    dependencyPathWords,
  );
  const sharedSubjectWordCount = countSharedSubjectWords(
    dependentSubject.words,
    dependencySubject.words,
  );

  if (sharedPathWordCount > 0 && sharedSubjectWordCount > 0) {
    score += Math.min(sharedPathWordCount + sharedSubjectWordCount, 3);
  }

  return score;
}

function getCommitIntentWords(
  group: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
): Set<string> {
  const intentWords = new Set<string>();
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");

  for (const word of subject.words) {
    intentWords.add(word);
  }
  for (const scopeWord of sanitizeSubjectWords(subject.scope)) {
    if (scopeWord.length >= 3 && !STOP_WORDS.has(scopeWord)) {
      intentWords.add(scopeWord);
    }
  }

  for (const file of group.files) {
    const signals = fileSignals.get(file.path);
    if (!signals) {
      continue;
    }

    if (signals.isCoordinatorLike && group.files.length > 1) {
      continue;
    }

    for (const word of signals.pathWords) {
      intentWords.add(word);
    }
    for (const word of signals.intentWords) {
      intentWords.add(word);
    }
  }

  return intentWords;
}

function getCommonActionWords(groups: PlannedCommit[]): Set<string> {
  const counts = new Map<string, number>();

  for (const group of groups) {
    for (const word of getCommitActionWords(group)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  const commonWords = new Set<string>();
  for (const [word, count] of counts) {
    if (count >= 3) {
      commonWords.add(word);
    }
  }

  return commonWords;
}

function getCommonIntentWords(
  groups: PlannedCommit[],
  fileSignals: Map<string, ChangedFileSignals>,
): Set<string> {
  const counts = new Map<string, number>();

  for (const group of groups) {
    for (const word of getCommitIntentWords(group, fileSignals)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  const commonWords = new Set<string>();
  for (const [word, count] of counts) {
    if (count >= 2) {
      commonWords.add(word);
    }
  }

  return commonWords;
}

function getCoverageKeys(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): string[] {
  const keys: string[] = [];

  for (const group of groups) {
    for (const fileRef of group.files) {
      const file = fileByPath.get(fileRef.path);
      if (!file) {
        throw new ValidationError(
          `Missing file for coverage check: ${fileRef.path}`,
        );
      }

      if (fileRef.hunks && fileRef.hunks.length > 0) {
        keys.push(
          ...fileRef.hunks.map((hunk) => `${fileRef.path}#${String(hunk)}`),
        );
        continue;
      }

      if (file.hunks.length === 0) {
        keys.push(`${fileRef.path}#file`);
        continue;
      }

      for (let index = 0; index < file.hunks.length; index++) {
        keys.push(`${fileRef.path}#${String(index)}`);
      }
    }
  }

  keys.sort();
  return keys;
}

function getCoverageKeySet(
  group: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): Set<string> {
  return new Set(getCoverageKeys([group], fileByPath));
}

function getDistinctActionScore(
  left: PlannedCommit,
  right: PlannedCommit,
  commonActionWords: Set<string>,
): number {
  return countSharedSubjectWords(
    getDistinctActionWords(left, commonActionWords),
    getDistinctActionWords(right, commonActionWords),
  );
}

function getDistinctActionWords(
  group: PlannedCommit,
  commonActionWords: Set<string>,
): Set<string> {
  return new Set(
    [...getCommitActionWords(group)].filter(
      (word) => !commonActionWords.has(word),
    ),
  );
}

function getDistinctArtifactScore(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
  commonIntentWords: Set<string>,
): number {
  return countSharedSubjectWords(
    getDistinctArtifactWords(left, fileSignals, commonIntentWords),
    getDistinctArtifactWords(right, fileSignals, commonIntentWords),
  );
}

function getDistinctArtifactWords(
  group: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
  commonIntentWords: Set<string>,
): Set<string> {
  return new Set(
    [...getCommitArtifactWords(group, fileSignals)].filter(
      (word) => !commonIntentWords.has(word),
    ),
  );
}

function getDistinctIntentScore(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
  commonIntentWords: Set<string>,
): number {
  return countSharedSubjectWords(
    getDistinctIntentWords(left, fileSignals, commonIntentWords),
    getDistinctIntentWords(right, fileSignals, commonIntentWords),
  );
}

function getDistinctIntentWords(
  group: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
  commonIntentWords: Set<string>,
): Set<string> {
  return new Set(
    [...getCommitIntentWords(group, fileSignals)].filter(
      (word) => !commonIntentWords.has(word),
    ),
  );
}

function getIncomingDependencyWeight(
  targetIndex: number,
  remainingIndexes: Set<number>,
  edgeWeights: Map<string, number>,
): number {
  let weight = 0;

  for (const index of remainingIndexes) {
    weight += edgeWeights.get(`${String(index)}:${String(targetIndex)}`) ?? 0;
  }

  return weight;
}

function getOutgoingDependencyWeight(
  sourceIndex: number,
  remainingIndexes: Set<number>,
  edges: Map<number, Set<number>>,
  edgeWeights: Map<string, number>,
): number {
  let weight = 0;

  for (const targetIndex of edges.get(sourceIndex) ?? []) {
    if (!remainingIndexes.has(targetIndex)) {
      continue;
    }

    weight +=
      edgeWeights.get(`${String(sourceIndex)}:${String(targetIndex)}`) ?? 0;
  }

  return weight;
}

function getSharedIntentScore(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
): number {
  const leftIntentWords = getCommitIntentWords(left, fileSignals);
  const rightIntentWords = getCommitIntentWords(right, fileSignals);
  const leftSubject = parseSubjectWords(left.message.split("\n")[0] ?? "");
  const rightSubject = parseSubjectWords(right.message.split("\n")[0] ?? "");

  let score = countSharedSubjectWords(leftIntentWords, rightIntentWords);

  if (
    leftSubject.scope !== "" &&
    rightSubject.scope !== "" &&
    scopesRelated(leftSubject.scope, rightSubject.scope)
  ) {
    score += 2;
  }

  if (hasHighWordOverlap(leftSubject.words, rightSubject.words)) {
    score += 2;
  }

  return score;
}

function getSupportAttachmentBreadthPenalty(
  supportGroup: PlannedCommit,
  component: number[],
  groups: PlannedCommit[],
  fileSignals: Map<string, ChangedFileSignals>,
): number {
  if (!isSupportGroup(supportGroup) || component.length === 0) {
    return 0;
  }

  const componentGroups = component.map((index) => groups[index]);
  const uniquePaths = new Set(
    componentGroups.flatMap((group) => group.files.map((file) => file.path)),
  );
  const hasCoordinatorLikeFile = componentGroups.some((group) =>
    group.files.some(
      (file) => fileSignals.get(file.path)?.isCoordinatorLike === true,
    ),
  );

  let penalty = 0;
  if (uniquePaths.size > 1) {
    penalty += 1;
  }
  if (hasCoordinatorLikeFile && uniquePaths.size > 1) {
    penalty += 2;
  }

  return penalty;
}

function getSupportAttachmentScore(
  supportGroup: PlannedCommit,
  targetGroup: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
): number {
  let score = 0;
  const supportSubject = parseSubjectWords(
    supportGroup.message.split("\n")[0] ?? "",
  );
  const targetSubject = parseSubjectWords(
    targetGroup.message.split("\n")[0] ?? "",
  );

  if (groupsSharePaths(supportGroup, targetGroup)) {
    score += 5;
  }

  if (
    hasDependencySignalBetweenGroups(supportGroup, targetGroup, fileSignals)
  ) {
    score += 4;
  }

  if (
    supportSubject.scope &&
    targetSubject.scope &&
    scopesRelated(supportSubject.scope, targetSubject.scope)
  ) {
    score += 3;
  }

  const sharedWordCount = countSharedSubjectWords(
    supportSubject.words,
    targetSubject.words,
  );
  score += Math.min(sharedWordCount, 3);

  if (hasHighWordOverlap(supportSubject.words, targetSubject.words)) {
    score += 2;
  }

  return score;
}

function groupCoversGroup(
  candidate: PlannedCommit,
  original: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): boolean {
  const candidateKeys = getCoverageKeySet(candidate, fileByPath);
  const originalKeys = getCoverageKeySet(original, fileByPath);

  for (const key of originalKeys) {
    if (!candidateKeys.has(key)) {
      return false;
    }
  }

  return true;
}

function groupsShareCoverage(
  left: PlannedCommit,
  right: PlannedCommit,
): boolean {
  const rightFiles = new Map(right.files.map((file) => [file.path, file]));

  for (const leftFile of left.files) {
    const rightFile = rightFiles.get(leftFile.path);
    if (!rightFile) {
      continue;
    }

    if (
      !leftFile.hunks ||
      leftFile.hunks.length === 0 ||
      !rightFile.hunks ||
      rightFile.hunks.length === 0
    ) {
      return true;
    }

    const rightHunks = new Set(rightFile.hunks);
    for (const hunk of leftFile.hunks) {
      if (rightHunks.has(hunk)) {
        return true;
      }
    }
  }

  return false;
}

function groupsSharePaths(left: PlannedCommit, right: PlannedCommit): boolean {
  const leftPaths = new Set(left.files.map((file) => file.path));
  return right.files.some((file) => leftPaths.has(file.path));
}

function harmonizeConsolidatedMessages(
  originalGroups: PlannedCommit[],
  consolidatedGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  return consolidatedGroups.map((group) => {
    const coveredGroups = originalGroups.filter((original) =>
      groupCoversGroup(group, original, fileByPath),
    );

    if (coveredGroups.length <= 1) {
      return group;
    }

    const consolidatedSubject = parseSubjectWords(
      group.message.split("\n")[0] ?? "",
    );
    const strongestCovered = prioritizeMergedCommits(coveredGroups)[0];
    const strongestCoveredSubject = parseSubjectWords(
      strongestCovered.message.split("\n")[0] ?? "",
    );

    if (
      consolidatedSubject.type !== "test" ||
      strongestCoveredSubject.type === "" ||
      isSupportLikeType(strongestCoveredSubject.type)
    ) {
      return group;
    }

    return {
      ...group,
      message: mergeCommitMessages([
        { ...group, files: coveredGroups.flatMap((commit) => commit.files) },
        ...coveredGroups,
      ]),
    };
  });
}

function hasDependencySignalBetweenGroups(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
): boolean {
  return (
    commitDependsOn(left, right, fileSignals) ||
    commitDependsOn(right, left, fileSignals)
  );
}

function hasImplementationMergeSignal(
  left: PlannedCommit,
  right: PlannedCommit,
  fileSignals: Map<string, ChangedFileSignals>,
  commonActionWords: Set<string>,
  commonIntentWords: Set<string>,
): boolean {
  if (groupsShareCoverage(left, right)) {
    return true;
  }

  const leftSubject = parseSubjectWords(left.message.split("\n")[0] ?? "");
  const rightSubject = parseSubjectWords(right.message.split("\n")[0] ?? "");
  const sharedWordCount = countSharedSubjectWords(
    leftSubject.words,
    rightSubject.words,
  );
  const sharedIntentScore = getSharedIntentScore(left, right, fileSignals);
  const distinctIntentScore = getDistinctIntentScore(
    left,
    right,
    fileSignals,
    commonIntentWords,
  );
  const distinctActionScore = getDistinctActionScore(
    left,
    right,
    commonActionWords,
  );
  const distinctArtifactScore = getDistinctArtifactScore(
    left,
    right,
    fileSignals,
    commonIntentWords,
  );
  const dependencyScore = Math.max(
    getCommitDependencyScore(left, right, fileSignals),
    getCommitDependencyScore(right, left, fileSignals),
  );

  if (
    dependencyScore >= 4 &&
    distinctActionScore === 0 &&
    distinctArtifactScore === 0
  ) {
    return false;
  }

  if (hasDependencySignalBetweenGroups(left, right, fileSignals)) {
    return distinctActionScore >= 1 && distinctArtifactScore >= 1;
  }

  if (
    leftSubject.scope &&
    rightSubject.scope &&
    scopesRelated(leftSubject.scope, rightSubject.scope) &&
    distinctActionScore >= 1 &&
    distinctArtifactScore >= 1
  ) {
    return true;
  }

  if (
    leftSubject.type !== "" &&
    leftSubject.type === rightSubject.type &&
    hasHighWordOverlap(leftSubject.words, rightSubject.words) &&
    distinctArtifactScore >= 1 &&
    (distinctActionScore >= 1 || distinctIntentScore >= 2)
  ) {
    return true;
  }

  return (
    distinctActionScore >= 1 &&
    distinctArtifactScore >= 1 &&
    sharedIntentScore >= 3 &&
    (sharedWordCount >= 1 || distinctIntentScore >= 2)
  );
}

function hasMatchingCoverage(
  before: PlannedCommit[],
  after: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): boolean {
  const beforeKeys = getCoverageKeys(before, fileByPath);
  const afterKeys = getCoverageKeys(after, fileByPath);

  // Compare unique key sets — the AI may assign the same hunk to multiple
  // commits, so the raw arrays can legitimately contain duplicates in
  // "before".  The invariant we enforce is: every hunk covered before is
  // still covered after (and vice-versa).
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);

  if (beforeSet.size !== afterSet.size) return false;

  for (const key of beforeSet) {
    if (!afterSet.has(key)) return false;
  }

  return true;
}

function isCoordinatorLikeFile(
  importedPaths: Set<string>,
  pathWords: Set<string>,
  providedSymbols: Set<string>,
): boolean {
  return (
    importedPaths.size >= 2 && pathWords.size <= 1 && providedSymbols.size <= 1
  );
}

function isSignalIdentifier(symbol: string): boolean {
  return symbol.length >= 5 && /[A-Z]/u.test(symbol);
}

function isSupportGroup(group: PlannedCommit): boolean {
  return isSupportLikeType(
    parseSubjectWords(group.message.split("\n")[0] ?? "").type,
  );
}

function mergeCommitFiles(
  commits: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommitFile[] {
  const fileHunkMap = new Map<string, null | Set<number>>();

  for (const commit of commits) {
    for (const fileRef of commit.files) {
      if (!fileRef.hunks || fileRef.hunks.length === 0) {
        fileHunkMap.set(fileRef.path, null);
        continue;
      }

      if (!fileHunkMap.has(fileRef.path)) {
        fileHunkMap.set(fileRef.path, new Set(fileRef.hunks));
        continue;
      }

      const existing = fileHunkMap.get(fileRef.path);
      if (existing === null || existing === undefined) {
        continue;
      }

      for (const hunk of fileRef.hunks) {
        existing.add(hunk);
      }
    }
  }

  const mergedFiles: PlannedCommitFile[] = [];
  for (const [path, hunks] of fileHunkMap) {
    const file = fileByPath.get(path);
    if (!file || file.hunks.length === 0 || hunks === null) {
      mergedFiles.push({ path });
      continue;
    }

    mergedFiles.push({
      hunks: [...hunks].sort((left, right) => left - right),
      path,
    });
  }

  return mergedFiles;
}

function mergeCommitsIntoGroup(
  commits: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit {
  return {
    files: mergeCommitFiles(commits, fileByPath),
    message: mergeCommitMessages(commits),
  };
}

function orderCommitsByDependencies(
  groups: PlannedCommit[],
  fileSignals: Map<string, ChangedFileSignals>,
): PlannedCommit[] {
  if (groups.length < 2) {
    return groups;
  }

  const edges = new Map<number, Set<number>>();
  const edgeWeights = new Map<string, number>();
  const indegree = groups.map(() => 0);

  for (
    let dependentIndex = 0;
    dependentIndex < groups.length;
    dependentIndex++
  ) {
    for (
      let dependencyIndex = 0;
      dependencyIndex < groups.length;
      dependencyIndex++
    ) {
      if (dependentIndex === dependencyIndex) {
        continue;
      }

      const dependencyScore = getCommitDependencyScore(
        groups[dependentIndex],
        groups[dependencyIndex],
        fileSignals,
      );
      if (dependencyScore < 4) {
        continue;
      }

      const existing = edges.get(dependencyIndex);
      if (existing?.has(dependentIndex)) {
        continue;
      }

      if (existing) {
        existing.add(dependentIndex);
      } else {
        edges.set(dependencyIndex, new Set([dependentIndex]));
      }
      edgeWeights.set(
        `${String(dependencyIndex)}:${String(dependentIndex)}`,
        dependencyScore,
      );
      indegree[dependentIndex]++;
    }
  }

  const queue = indegree
    .map((degree, index) => ({ degree, index }))
    .filter((entry) => entry.degree === 0)
    .map((entry) => entry.index);
  const orderedIndexes: number[] = [];
  const remainingIndexes = new Set(groups.map((_, index) => index));

  while (orderedIndexes.length < groups.length) {
    const index =
      queue.shift() ??
      chooseDependencyOrderIndex(
        remainingIndexes,
        indegree,
        edges,
        edgeWeights,
      );
    if (index === undefined) {
      break;
    }
    if (!remainingIndexes.has(index)) {
      continue;
    }

    remainingIndexes.delete(index);
    orderedIndexes.push(index);
    const outgoing = edges.get(index);
    if (!outgoing) {
      continue;
    }

    for (const nextIndex of outgoing) {
      indegree[nextIndex]--;
      if (indegree[nextIndex] === 0) {
        queue.push(nextIndex);
      }
    }
  }

  if (orderedIndexes.length !== groups.length) {
    return groups;
  }

  return orderedIndexes.map((index) => groups[index]);
}

/**
 * Dependency ordering should reflect the current changed file contents even
 * when the import line is outside the edited hunk selection.
 */
function readCurrentFileSignalLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/u);
  } catch {
    return [];
  }
}

function repartitionByIntent(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, ChangedFileSignals>,
): PlannedCommit[] {
  const implementationIndexes: number[] = [];
  const supportIndexes: number[] = [];

  for (let index = 0; index < groups.length; index++) {
    if (isSupportGroup(groups[index])) {
      supportIndexes.push(index);
    } else {
      implementationIndexes.push(index);
    }
  }

  if (implementationIndexes.length <= 1) {
    return [mergeCommitsIntoGroup(groups, fileByPath)];
  }

  const commonActionWords = getCommonActionWords(
    implementationIndexes.map((index) => groups[index]),
  );
  const commonIntentWords = getCommonIntentWords(
    implementationIndexes.map((index) => groups[index]),
    fileSignals,
  );

  const components: number[][] = [];
  const visited = new Set<number>();

  for (const startIndex of implementationIndexes) {
    if (visited.has(startIndex)) {
      continue;
    }

    const stack = [startIndex];
    const component: number[] = [];
    visited.add(startIndex);

    while (stack.length > 0) {
      const currentIndex = stack.pop();
      if (currentIndex === undefined) {
        continue;
      }

      component.push(currentIndex);

      for (const candidateIndex of implementationIndexes) {
        if (visited.has(candidateIndex) || candidateIndex === currentIndex) {
          continue;
        }

        if (
          hasImplementationMergeSignal(
            groups[currentIndex],
            groups[candidateIndex],
            fileSignals,
            commonActionWords,
            commonIntentWords,
          )
        ) {
          visited.add(candidateIndex);
          stack.push(candidateIndex);
        }
      }
    }

    components.push(component.sort((left, right) => left - right));
  }

  if (components.length <= 1) {
    return [mergeCommitsIntoGroup(groups, fileByPath)];
  }

  for (const supportIndex of supportIndexes) {
    const attachmentIndex = chooseSupportAttachment(
      groups[supportIndex],
      groups,
      components,
      fileSignals,
    );

    if (attachmentIndex === -1) {
      components.push([supportIndex]);
      continue;
    }

    components[attachmentIndex]?.push(supportIndex);
  }

  return components
    .map((component) => component.sort((left, right) => left - right))
    .sort((left, right) => left[0] - right[0])
    .map((component) =>
      mergeCommitsIntoGroup(
        component.map((index) => groups[index]),
        fileByPath,
      ),
    );
}

/**
 * Resolve a relative module reference against the known changed-path aliases so
 * the planner follows dependencies based on the actual diff, not a hardcoded
 * extension whitelist or directory-entry assumption.
 */
function resolveChangedModulePath(
  importerPath: string,
  modulePath: string,
  changedPathAliases: Map<string, string[]>,
): null | string {
  const resolvedPath = pathPosix.normalize(
    pathPosix.join(pathPosix.dirname(importerPath), modulePath),
  );
  const lookupAliases = [resolvedPath, stripPathExtension(resolvedPath)];
  const seenPaths = new Set<string>();

  for (const alias of lookupAliases) {
    const candidates = changedPathAliases.get(alias);
    if (!candidates) {
      continue;
    }

    for (const candidate of candidates) {
      if (seenPaths.has(candidate)) {
        continue;
      }

      seenPaths.add(candidate);
      return candidate;
    }
  }

  return null;
}

function scopesRelated(left: string, right: string): boolean {
  return left === right || left.includes(right) || right.includes(left);
}

function splitWeakConsolidations(
  baselineGroups: PlannedCommit[],
  consolidatedGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, ChangedFileSignals>,
): PlannedCommit[] {
  const result: PlannedCommit[] = [];

  for (const group of consolidatedGroups) {
    const coveredGroups = baselineGroups.filter((baseline) =>
      groupCoversGroup(group, baseline, fileByPath),
    );

    if (coveredGroups.length <= 1) {
      result.push(group);
      continue;
    }

    const repartitioned = repartitionByIntent(
      coveredGroups,
      fileByPath,
      fileSignals,
    );

    if (repartitioned.length <= 1) {
      result.push(group);
      continue;
    }

    result.push(...repartitioned);
  }

  return result;
}

function stripPathExtension(path: string): string {
  const extension = pathPosix.extname(path);
  if (extension === "") {
    return path;
  }

  return path.slice(0, -extension.length);
}

// ─── Deterministic pre-merge ─────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a",
  "across",
  "all",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "no",
  "not",
  "of",
  "on",
  "or",
  "the",
  "to",
  "up",
  "via",
  "with",
]);

interface SubjectWords {
  scope: string;
  type: string;
  words: Set<string>;
}

/** True when ≥50% of the shorter word-set appears in the longer one. */
export function hasHighWordOverlap(a: Set<string>, b: Set<string>): boolean {
  if (a.size < 2 || b.size < 2) return false;
  let shared = 0;
  for (const wordA of a) {
    for (const wordB of b) {
      if (wordsRelated(wordA, wordB)) {
        shared++;
        break;
      }
    }
  }
  return shared / Math.min(a.size, b.size) >= 0.5;
}

/** Extract conventional-commit type and significant description words. */
export function parseSubjectWords(subject: string): SubjectWords {
  const parsed = parseConventionalSubject(subject);
  const words = new Set(
    sanitizeSubjectWords(parsed.description).filter(
      (w) => w.length >= 3 && !STOP_WORDS.has(w),
    ),
  );
  return { scope: parsed.scope, type: parsed.type, words };
}

/**
 * Deterministically merge commits whose subjects share the same conventional-
 * commit type AND whose descriptions have ≥50% significant-word overlap.
 * Uses union-find for transitive closure (A~B, B~C → A+B+C merge).
 */
export function premergeBySubject(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  if (groups.length < 2) return groups;

  const wordSets = groups.map((g) => {
    const subject = g.message.split("\n")[0];
    return parseSubjectWords(subject);
  });

  // Union-Find
  const parent = groups.map((_, i) => i);

  const find = (x: number): number => {
    let node = x;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  };

  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (
        wordSets[i].type !== "" &&
        wordSets[i].type === wordSets[j].type &&
        hasHighWordOverlap(wordSets[i].words, wordSets[j].words)
      ) {
        unite(i, j);
      }
    }
  }

  // Build clusters from union-find roots
  const clusterMap = new Map<number, number[]>();
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    const existing = clusterMap.get(root);
    if (existing) existing.push(i);
    else clusterMap.set(root, [i]);
  }

  const clusters = [...clusterMap.values()];

  // Only apply if at least one cluster has >1 item (actual merge happened)
  if (!clusters.some((c) => c.length > 1)) return groups;

  const merged = applyCommitClusters(groups, clusters, fileByPath);
  return hasMatchingCoverage(groups, merged, fileByPath) ? merged : groups;
}

/**
 * Two words are "related" if they are equal or one is a prefix of the other
 * (handles common English inflections like import/imports, order/ordering).
 */
export function wordsRelated(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter);
}

function getCommitAreas(group: PlannedCommit): Set<string> {
  return new Set(group.files.map((file) => getTopLevelArea(file.path)));
}

function getOrderedSubjectWords(subject: string): string[] {
  const parsed = parseConventionalSubject(subject);
  return sanitizeSubjectWords(parsed.description).filter(
    (word) => word.length >= 3 && !STOP_WORDS.has(word),
  );
}

function getTopLevelArea(path: string): string {
  const [head, tail] = path.split("/");
  return tail ? head : "(root)";
}

function hasPotentialMergeSignals(groups: PlannedCommit[]): boolean {
  if (groups.length < 2) {
    return false;
  }

  const subjects = groups.map((group) =>
    parseSubjectWords(group.message.split("\n")[0] ?? ""),
  );
  const areas = groups.map((group) => getCommitAreas(group));
  const seenPaths = new Set<string>();

  for (const group of groups) {
    for (const file of group.files) {
      if (seenPaths.has(file.path)) {
        return true;
      }
      seenPaths.add(file.path);
    }
  }

  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (subjects[i].scope && subjects[i].scope === subjects[j].scope) {
        return true;
      }

      if (hasHighWordOverlap(subjects[i].words, subjects[j].words)) {
        return true;
      }

      if (
        isSupportLikeType(subjects[i].type) ||
        isSupportLikeType(subjects[j].type)
      ) {
        for (const area of areas[i]) {
          if (areas[j].has(area)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function isSupportLikeType(type: string): boolean {
  return (
    type === "chore" || type === "docs" || type === "style" || type === "test"
  );
}

/** Combine subjects and body bullets from multiple commits into one message. */
function mergeCommitMessages(commits: PlannedCommit[]): string {
  if (commits.length === 1) return commits[0].message;

  const orderedCommits = prioritizeMergedCommits(commits);
  const firstSubject = orderedCommits[0].message.split("\n")[0].trim();
  const bulletBlocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const commit of orderedCommits) {
    const lines = commit.message.split("\n");
    // Body starts at line 2 (after subject + blank line)
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*-\s+\S/.test(line)) {
        if (currentBlock.length > 0) {
          bulletBlocks.push(currentBlock);
        }
        currentBlock = [line];
        continue;
      }

      if (/^\s{2,}\S/.test(line) && currentBlock.length > 0) {
        currentBlock.push(line);
      }
    }
  }
  if (currentBlock.length > 0) {
    bulletBlocks.push(currentBlock);
  }

  const dedupedBlocks = bulletBlocks.filter(
    (block, index, blocks) =>
      blocks.findIndex(
        (candidate) => candidate.join("\n") === block.join("\n"),
      ) === index,
  );

  if (dedupedBlocks.length === 0) {
    return firstSubject;
  }

  return `${firstSubject}\n\n${dedupedBlocks
    .map((block) => block.join("\n"))
    .join("\n")}`;
}

function prioritizeMergedCommits(commits: PlannedCommit[]): PlannedCommit[] {
  return [...commits].sort((left, right) => {
    const leftSubject = parseSubjectWords(left.message.split("\n")[0] ?? "");
    const rightSubject = parseSubjectWords(right.message.split("\n")[0] ?? "");
    const leftScore =
      (isSupportLikeType(leftSubject.type) ? 0 : 10) +
      leftSubject.words.size +
      left.files.length;
    const rightScore =
      (isSupportLikeType(rightSubject.type) ? 0 : 10) +
      rightSubject.words.size +
      right.files.length;

    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }

    return left.message.localeCompare(right.message);
  });
}
