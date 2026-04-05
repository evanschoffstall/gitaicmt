import { mergeCommitsIntoGroup } from "./group/merge.js";
import { type FileChangeSignals, type FileDiff, type PlannedCommit } from "./grouping-types.js";
import {
  getCommonActionWords,
  getCommonIntentWords,
} from "./intent-scoring.js";
import {
  chooseSupportAttachment,
  getCoveredBaselineGroups,
  hasImplementationMergeSignal,
  isSupportGroup,
} from "./merge-heuristics.js";

interface ImplementationComponentContext {
  commonActionWords: Set<string>;
  commonIntentWords: Set<string>;
  fileSignals: Map<string, FileChangeSignals>;
  groups: PlannedCommit[];
  implementationIndexes: number[];
}

/**
 * Splits over-consolidated groups by re-grouping via intent affinity, then
 * re-attaches support commits to the closest implementation cluster.
 */
export function splitWeakConsolidations(
  baselineGroups: PlannedCommit[],
  consolidatedGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
): PlannedCommit[] {
  const result: PlannedCommit[] = [];

  for (const group of consolidatedGroups) {
    const coveredGroups = getCoveredBaselineGroups(
      baselineGroups,
      group,
      fileByPath,
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

function attachSupportIndexes(
  groups: PlannedCommit[],
  supportIndexes: number[],
  components: number[][],
  fileSignals: Map<string, FileChangeSignals>,
): void {
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
}

function buildImplementationComponents(
  groups: PlannedCommit[],
  implementationIndexes: number[],
  fileSignals: Map<string, FileChangeSignals>,
  commonActionWords: Set<string>,
  commonIntentWords: Set<string>,
): number[][] {
  const components: number[][] = [];
  const visited = new Set<number>();
  const context: ImplementationComponentContext = {
    commonActionWords,
    commonIntentWords,
    fileSignals,
    groups,
    implementationIndexes,
  };

  for (const startIndex of implementationIndexes) {
    if (visited.has(startIndex)) {
      continue;
    }

    components.push(collectImplementationComponent(startIndex, visited, context));
  }

  return components;
}

function collectImplementationComponent(
  startIndex: number,
  visited: Set<number>,
  context: ImplementationComponentContext,
): number[] {
  const stack = [startIndex];
  const component: number[] = [];
  visited.add(startIndex);

  while (stack.length > 0) {
    const currentIndex = stack.pop();
    if (currentIndex === undefined) {
      continue;
    }

    component.push(currentIndex);
    enqueueImplementationNeighbors(currentIndex, visited, stack, context);
  }

  return component.sort((left, right) => left - right);
}

function enqueueImplementationNeighbors(
  currentIndex: number,
  visited: Set<number>,
  stack: number[],
  context: ImplementationComponentContext,
): void {
  for (const candidateIndex of context.implementationIndexes) {
    if (visited.has(candidateIndex) || candidateIndex === currentIndex) {
      continue;
    }

    if (
      hasImplementationMergeSignal(
        context.groups[currentIndex],
        context.groups[candidateIndex],
        context.fileSignals,
        context.commonActionWords,
        context.commonIntentWords,
      )
    ) {
      visited.add(candidateIndex);
      stack.push(candidateIndex);
    }
  }
}

function mergeRepartitionComponents(
  groups: PlannedCommit[],
  components: number[][],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
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

function partitionGroupIndexes(groups: PlannedCommit[]): {
  implementationIndexes: number[];
  supportIndexes: number[];
} {
  const implementationIndexes: number[] = [];
  const supportIndexes: number[] = [];

  for (let index = 0; index < groups.length; index++) {
    if (isSupportGroup(groups[index])) {
      supportIndexes.push(index);
      continue;
    }

    implementationIndexes.push(index);
  }

  return { implementationIndexes, supportIndexes };
}

function repartitionByIntent(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
): PlannedCommit[] {
  const { implementationIndexes, supportIndexes } = partitionGroupIndexes(groups);

  if (implementationIndexes.length <= 1) {
    return [mergeCommitsIntoGroup(groups, fileByPath)];
  }

  const implementationGroups = implementationIndexes.map(
    (index) => groups[index],
  );
  const commonActionWords = getCommonActionWords(implementationGroups);
  const commonIntentWords = getCommonIntentWords(
    implementationGroups,
    fileSignals,
  );
  const components = buildImplementationComponents(
    groups,
    implementationIndexes,
    fileSignals,
    commonActionWords,
    commonIntentWords,
  );

  if (components.length <= 1) {
    return [mergeCommitsIntoGroup(groups, fileByPath)];
  }

  attachSupportIndexes(groups, supportIndexes, components, fileSignals);
  return mergeRepartitionComponents(groups, components, fileByPath);
}
