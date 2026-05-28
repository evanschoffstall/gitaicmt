import {
  mergeCommitFiles,
  mergeCommitMessagesWithPrimarySubject,
  mergeCommitsIntoGroup,
  prioritizeMergedCommits,
} from "./group/merge.js";
import {
  type FileChangeSignals,
  type FileDiff,
  type PlannedCommit,
} from "./grouping-types.js";
import { getCommonActionWords, getCommonIntentWords } from "./intent/index.js";
import { hasImplementationMergeSignal } from "./merge-heuristics.js";
import { getPathOwnerDescriptor } from "./ownership.js";
import { isStyleGroup } from "./style-splitting/index.js";

interface ImplementationComponentContext {
  commonActionWords: Set<string>;
  commonIntentWords: Set<string>;
  fileSignals: Map<string, FileChangeSignals>;
  groups: PlannedCommit[];
  implementationIndexes: number[];
}

export function buildImplementationComponents(
  groups: PlannedCommit[],
  implementationIndexes: number[],
  fileSignals: Map<string, FileChangeSignals>,
): number[][] {
  const implementationGroups = implementationIndexes.map(
    (index) => groups[index],
  );
  const context: ImplementationComponentContext = {
    commonActionWords: getCommonActionWords(implementationGroups),
    commonIntentWords: getCommonIntentWords(implementationGroups, fileSignals),
    fileSignals,
    groups,
    implementationIndexes,
  };
  const components: number[][] = [];
  const visited = new Set<number>();

  for (const startIndex of implementationIndexes) {
    if (visited.has(startIndex)) {
      continue;
    }

    components.push(
      collectImplementationComponent(startIndex, visited, context),
    );
  }

  return components;
}

export function buildOwnerScopedImplementationComponents(
  groups: PlannedCommit[],
  implementationIndexes: number[],
): number[][] {
  const indexesByOwner = new Map<string, number[]>();

  for (const index of implementationIndexes) {
    const owner = getDominantGroupOwner(groups[index]);
    const existing = indexesByOwner.get(owner);
    if (existing) {
      existing.push(index);
      continue;
    }
    indexesByOwner.set(owner, [index]);
  }

  return [...indexesByOwner.values()];
}

export function collapseSharedDescriptionStyleGroups(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const styleGroups = groups.filter((group) => isStyleGroup(group));
  const otherGroups = groups.filter((group) => !isStyleGroup(group));

  if (styleGroups.length <= 1) {
    return groups;
  }

  const byDescriptionAndArea = new Map<string, PlannedCommit[]>();
  for (const group of styleGroups) {
    const subjectLine = group.message.split("\n")[0] ?? "";
    const colonIndex = subjectLine.indexOf(":");
    const description =
      colonIndex >= 0 ? subjectLine.slice(colonIndex + 1).trim() : "";
    const area =
      [
        ...group.files
          .reduce((counts, file) => {
            const featureRoot = getPathOwnerDescriptor(file.path).featureRoot;
            counts.set(featureRoot, (counts.get(featureRoot) ?? 0) + 1);
            return counts;
          }, new Map<string, number>())
          .entries(),
      ].sort(([, left], [, right]) => right - left)[0]?.[0] ?? "root";
    const key = `${description}::${area}`;
    const siblings = byDescriptionAndArea.get(key);
    if (siblings) {
      siblings.push(group);
    } else {
      byDescriptionAndArea.set(key, [group]);
    }
  }

  if (
    ![...byDescriptionAndArea.values()].some((siblings) => siblings.length > 1)
  ) {
    return groups;
  }

  const mergedStyleGroups = [...byDescriptionAndArea.values()].map(
    (siblings) =>
      siblings.length === 1
        ? siblings[0]
        : mergeStyleSiblingGroups(siblings, fileByPath),
  );

  return [...otherGroups, ...mergedStyleGroups];
}

export function getDominantGroupOwner(group: PlannedCommit): string {
  const ownerCounts = new Map<string, number>();

  for (const file of group.files) {
    const ownerId = getPathOwnerDescriptor(file.path).ownerId;
    ownerCounts.set(ownerId, (ownerCounts.get(ownerId) ?? 0) + 1);
  }

  return (
    [...ownerCounts.entries()].sort(
      ([leftOwner, leftCount], [rightOwner, rightCount]) =>
        rightCount - leftCount || leftOwner.localeCompare(rightOwner),
    )[0]?.[0] ?? "root"
  );
}

export function mergeRepartitionComponents(
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

export function refineLargeOwnerMixedComponents(
  groups: PlannedCommit[],
  components: number[][],
  shouldSplitComponent: (
    groups: PlannedCommit[],
    component: number[],
  ) => boolean,
): {
  components: number[][];
  usedOwnerSplit: boolean;
} {
  let usedOwnerSplit = false;
  const refinedComponents: number[][] = [];

  for (const component of components) {
    if (!shouldSplitComponent(groups, component)) {
      refinedComponents.push(component);
      continue;
    }

    const ownerScopedComponents = buildOwnerScopedImplementationComponents(
      groups,
      component,
    );
    if (ownerScopedComponents.length <= 1) {
      refinedComponents.push(component);
      continue;
    }

    usedOwnerSplit = true;
    refinedComponents.push(...ownerScopedComponents);
  }

  return { components: refinedComponents, usedOwnerSplit };
}

function collectImplementationComponent(
  startIndex: number,
  visited: Set<number>,
  context: ImplementationComponentContext,
): number[] {
  const stack = [startIndex];
  const component: number[] = [];
  visited.add(startIndex);

  let currentIndex: number | undefined;
  while ((currentIndex = stack.pop()) !== undefined) {
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

function mergeStyleSiblingGroups(
  siblings: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit {
  const primaryMessage = prioritizeMergedCommits(siblings)[0]?.message ?? "";

  return {
    files: mergeCommitFiles(siblings, fileByPath),
    message: mergeCommitMessagesWithPrimarySubject(primaryMessage, siblings),
  };
}
