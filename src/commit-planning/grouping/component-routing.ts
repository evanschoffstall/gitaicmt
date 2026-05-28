import { emitRepartitionByIntentEvent } from "./group/events.js";
import { mergeCommitsIntoGroup } from "./group/merge.js";
import {
  type FileChangeSignals,
  type FileDiff,
  type PlannedCommit,
} from "./grouping-types.js";
import {
  buildImplementationComponents,
  buildOwnerScopedImplementationComponents,
  getDominantGroupOwner,
  mergeRepartitionComponents,
  refineLargeOwnerMixedComponents,
} from "./implementation-components.js";
import { isSupportGroup } from "./merge-heuristics.js";
import { getPathOwnerDescriptor } from "./ownership.js";
import {
  isStyleGroup,
  shouldPreserveBroadStyleAreas,
} from "./style-splitting/index.js";
import { attachSupportIndexes } from "./support-attachment/component-attachment.js";

const LARGE_IMPLEMENTATION_COMPONENT_GROUP_THRESHOLD = 4;
const LARGE_IMPLEMENTATION_COMPONENT_OWNER_THRESHOLD = 4;

interface RepartitionExecution {
  components: number[][];
  diagnostics?: Record<string, boolean | number | string>;
  fileByPath: Map<string, FileDiff>;
  fileSignals: Map<string, FileChangeSignals>;
  groups: PlannedCommit[];
  implementationGroupCount: number;
  resolution: string;
  supportIndexes: number[];
  usedOwnerSplit?: boolean;
}

interface RepartitionImplementationInput {
  fileByPath: Map<string, FileDiff>;
  fileSignals: Map<string, FileChangeSignals>;
  groups: PlannedCommit[];
  implementationIndexes: number[];
  supportIndexes: number[];
}

interface RepartitionSummary {
  componentCount?: number;
  diagnostics?: Record<string, boolean | number | string>;
  implementationGroupCount: number;
  inputGroupCount: number;
  outputGroupCount: number;
  resolution: string;
  supportGroupCount: number;
  usedOwnerSplit?: boolean;
}

interface TrivialRepartitionResult {
  diagnostics?: Record<string, boolean | number | string>;
  groups: PlannedCommit[];
  resolution:
    | "merge-all-support-or-single-group"
    | "preserve-divergent-support-baseline"
    | "preserve-style-only-groups"
    | "single-implementation-with-support-attachment";
}

export function partitionGroupIndexes(groups: PlannedCommit[]): {
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

/** Repartitions covered baseline groups into implementation-led components. */
export function repartitionByIntent(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  shouldPreserveDivergentSupportBaseline: (groups: PlannedCommit[]) => boolean,
): PlannedCommit[] {
  const { implementationIndexes, supportIndexes } =
    partitionGroupIndexes(groups);
  const trivialResult = repartitionTrivialGroupSets(
    groups,
    implementationIndexes,
    supportIndexes,
    fileByPath,
    fileSignals,
    shouldPreserveDivergentSupportBaseline,
  );

  if (trivialResult) {
    emitRepartitionSummary({
      diagnostics: trivialResult.diagnostics,
      implementationGroupCount: implementationIndexes.length,
      inputGroupCount: groups.length,
      outputGroupCount: trivialResult.groups.length,
      resolution: trivialResult.resolution,
      supportGroupCount: supportIndexes.length,
    });
    return trivialResult.groups;
  }

  return repartitionImplementationComponents({
    fileByPath,
    fileSignals,
    groups,
    implementationIndexes,
    supportIndexes,
  });
}

function buildMergedSupportOnlyResult(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  styleOnlySupportGroups: boolean,
): TrivialRepartitionResult {
  return {
    diagnostics: {
      mergedSupportOnlyOrSingleGroup: true,
      styleOnlySupportGroups,
    },
    groups: [mergeCommitsIntoGroup(groups, fileByPath)],
    resolution: "merge-all-support-or-single-group",
  };
}

function buildSupportOnlyTrivialResult(
  groups: PlannedCommit[],
  resolution:
    | "preserve-divergent-support-baseline"
    | "preserve-style-only-groups",
  diagnostics: Record<string, boolean>,
): TrivialRepartitionResult {
  return { diagnostics, groups, resolution };
}

function emitRepartitionSummary(summary: RepartitionSummary): void {
  emitRepartitionByIntentEvent({
    ...summary,
    supportAttachmentEnabled: summary.supportGroupCount > 0,
  });
}

function finalizeImplementationRepartition(
  input: RepartitionImplementationInput,
  components: number[][],
  implementationGroupCount: number,
  resolution:
    | "multi-component-repartition"
    | "owner-scoped-implementation-components"
    | "single-implementation-component-with-support-attachment",
  diagnostics?: Record<string, boolean | number | string>,
  usedOwnerSplit?: boolean,
): PlannedCommit[] {
  return finalizeRepartitionedComponents({
    components,
    diagnostics,
    fileByPath: input.fileByPath,
    fileSignals: input.fileSignals,
    groups: input.groups,
    implementationGroupCount,
    resolution,
    supportIndexes: input.supportIndexes,
    usedOwnerSplit,
  });
}

function finalizeMultiComponentRepartition(
  input: RepartitionImplementationInput,
  components: number[][],
  implementationGroupCount: number,
  ownerSplitEligibility: {
    largeImplementationOwnerSplitEligible: boolean;
    supportBearingOwnerSplitEligible: boolean;
  },
): PlannedCommit[] {
  const refinedComponents = refineLargeOwnerMixedComponents(
    input.groups,
    components,
    shouldSplitLargeImplementationComponent,
  );
  return finalizeImplementationRepartition(
    input,
    refinedComponents.components,
    implementationGroupCount,
    refinedComponents.usedOwnerSplit
      ? "owner-scoped-implementation-components"
      : "multi-component-repartition",
    {
      initialComponentCount: components.length,
      largeImplementationOwnerSplitEligible:
        ownerSplitEligibility.largeImplementationOwnerSplitEligible,
      refinedComponentCount: refinedComponents.components.length,
      refinedOwnerSplitApplied: refinedComponents.usedOwnerSplit,
      supportBearingOwnerSplitEligible:
        ownerSplitEligibility.supportBearingOwnerSplitEligible,
    },
    refinedComponents.usedOwnerSplit || undefined,
  );
}

function finalizeRepartitionedComponents(
  execution: RepartitionExecution,
): PlannedCommit[] {
  attachSupportIndexes(
    execution.groups,
    execution.supportIndexes,
    execution.components,
    execution.fileSignals,
  );
  const outputGroups = mergeRepartitionComponents(
    execution.groups,
    execution.components,
    execution.fileByPath,
  );
  emitRepartitionSummary({
    componentCount: execution.components.length,
    diagnostics: execution.diagnostics,
    implementationGroupCount: execution.implementationGroupCount,
    inputGroupCount: execution.groups.length,
    outputGroupCount: outputGroups.length,
    resolution: execution.resolution,
    supportGroupCount: execution.supportIndexes.length,
    usedOwnerSplit: execution.usedOwnerSplit,
  });
  return outputGroups;
}

function finalizeSingleComponentRepartition(
  input: RepartitionImplementationInput,
  componentCount: number,
  implementationGroupCount: number,
  ownerSplitEligibility: {
    largeImplementationOwnerSplitEligible: boolean;
    supportBearingOwnerSplitEligible: boolean;
  },
  components: number[][],
): PlannedCommit[] {
  if (
    ownerSplitEligibility.largeImplementationOwnerSplitEligible ||
    ownerSplitEligibility.supportBearingOwnerSplitEligible
  ) {
    const ownerComponents = buildOwnerScopedImplementationComponents(
      input.groups,
      input.implementationIndexes,
    );
    return finalizeImplementationRepartition(
      input,
      ownerComponents,
      implementationGroupCount,
      "owner-scoped-implementation-components",
      {
        initialComponentCount: componentCount,
        largeImplementationOwnerSplitEligible:
          ownerSplitEligibility.largeImplementationOwnerSplitEligible,
        ownerScopedComponentCount: ownerComponents.length,
        supportBearingOwnerSplitEligible:
          ownerSplitEligibility.supportBearingOwnerSplitEligible,
      },
      true,
    );
  }

  if (input.supportIndexes.length > 0) {
    return finalizeImplementationRepartition(
      input,
      components,
      implementationGroupCount,
      "single-implementation-component-with-support-attachment",
      {
        initialComponentCount: componentCount,
        largeImplementationOwnerSplitEligible:
          ownerSplitEligibility.largeImplementationOwnerSplitEligible,
        supportBearingOwnerSplitEligible:
          ownerSplitEligibility.supportBearingOwnerSplitEligible,
      },
    );
  }

  return mergeSingleImplementationComponent(
    input,
    componentCount,
    implementationGroupCount,
  );
}

function getOwnerSplitEligibility(input: RepartitionImplementationInput): {
  largeImplementationOwnerSplitEligible: boolean;
  supportBearingOwnerSplitEligible: boolean;
} {
  return {
    largeImplementationOwnerSplitEligible:
      shouldSplitLargeImplementationComponent(
        input.groups,
        input.implementationIndexes,
      ),
    supportBearingOwnerSplitEligible:
      shouldOwnerSplitSupportBearingImplementationComponent(
        input.groups,
        input.implementationIndexes,
        input.supportIndexes,
      ),
  };
}

function mergeSingleImplementationComponent(
  input: RepartitionImplementationInput,
  componentCount: number,
  implementationGroupCount: number,
): PlannedCommit[] {
  const mergedGroups = [mergeCommitsIntoGroup(input.groups, input.fileByPath)];
  emitRepartitionSummary({
    componentCount,
    diagnostics: {
      mergedSingleImplementationComponent: true,
      originalComponentCount: componentCount,
    },
    implementationGroupCount,
    inputGroupCount: input.groups.length,
    outputGroupCount: mergedGroups.length,
    resolution: "merge-single-implementation-component",
    supportGroupCount: input.supportIndexes.length,
  });
  return mergedGroups;
}

function repartitionImplementationComponents(
  input: RepartitionImplementationInput,
): PlannedCommit[] {
  const implementationGroupCount = input.implementationIndexes.length;
  const ownerSplitEligibility = getOwnerSplitEligibility(input);
  const components = buildImplementationComponents(
    input.groups,
    input.implementationIndexes,
    input.fileSignals,
  );

  if (components.length > 1) {
    return finalizeMultiComponentRepartition(
      input,
      components,
      implementationGroupCount,
      ownerSplitEligibility,
    );
  }

  return finalizeSingleComponentRepartition(
    input,
    components.length,
    implementationGroupCount,
    ownerSplitEligibility,
    components,
  );
}

function repartitionTrivialGroupSets(
  groups: PlannedCommit[],
  implementationIndexes: number[],
  supportIndexes: number[],
  fileByPath: Map<string, FileDiff>,
  fileSignals: Map<string, FileChangeSignals>,
  shouldPreserveDivergentSupportBaseline: (groups: PlannedCommit[]) => boolean,
): null | TrivialRepartitionResult {
  const styleOnlySupportGroups =
    implementationIndexes.length === 0 &&
    supportIndexes.every((index) => isStyleGroup(groups[index]));
  const preservesBroadStyleAreas =
    styleOnlySupportGroups && shouldPreserveBroadStyleAreas(groups);
  const preservesDivergentSupportBaseline =
    shouldPreserveDivergentSupportBaseline(groups);

  if (implementationIndexes.length > 1) {
    return null;
  }

  if (implementationIndexes.length === 1 && supportIndexes.length > 0) {
    const singleComponent = [implementationIndexes.slice()];
    attachSupportIndexes(groups, supportIndexes, singleComponent, fileSignals);
    return {
      diagnostics: {
        hasSingleImplementationGroup: true,
        supportGroupCount: supportIndexes.length,
      },
      groups: mergeRepartitionComponents(groups, singleComponent, fileByPath),
      resolution: "single-implementation-with-support-attachment",
    };
  }

  if (preservesBroadStyleAreas) {
    return buildSupportOnlyTrivialResult(groups, "preserve-style-only-groups", {
      preservesBroadStyleAreas,
      styleOnlySupportGroups,
    });
  }

  if (preservesDivergentSupportBaseline) {
    return buildSupportOnlyTrivialResult(
      groups,
      "preserve-divergent-support-baseline",
      {
        preservesDivergentSupportBaseline,
        styleOnlySupportGroups,
      },
    );
  }

  return buildMergedSupportOnlyResult(
    groups,
    fileByPath,
    styleOnlySupportGroups,
  );
}

function shouldOwnerSplitSupportBearingImplementationComponent(
  groups: PlannedCommit[],
  implementationIndexes: number[],
  supportIndexes: number[],
): boolean {
  if (supportIndexes.length === 0 || implementationIndexes.length < 2) {
    return false;
  }

  const ownerIds = new Set(
    implementationIndexes.map((index) => getDominantGroupOwner(groups[index])),
  );
  if (ownerIds.size < 2) {
    return false;
  }

  const featureRoots = new Set(
    implementationIndexes.flatMap((index) =>
      groups[index].files.map(
        (file) => getPathOwnerDescriptor(file.path).featureRoot,
      ),
    ),
  );
  return featureRoots.size >= 2;
}

function shouldSplitLargeImplementationComponent(
  groups: PlannedCommit[],
  implementationIndexes: number[],
): boolean {
  if (
    implementationIndexes.length <
    LARGE_IMPLEMENTATION_COMPONENT_GROUP_THRESHOLD
  ) {
    return false;
  }

  const ownerIds = new Set(
    implementationIndexes.map((index) => getDominantGroupOwner(groups[index])),
  );
  const requiredOwnerCount = Math.min(
    LARGE_IMPLEMENTATION_COMPONENT_OWNER_THRESHOLD,
    Math.ceil(implementationIndexes.length / 2),
  );

  return ownerIds.size >= requiredOwnerCount;
}
