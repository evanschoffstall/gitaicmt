import type { PlannedCommit } from "../grouping-types.js";

import { getPathOwnerDescriptor } from "../ownership.js";
import {
  emitStructuralOwnerBucketEvent,
  emitStructuralOwnerSplitEvent,
} from "./split-trace-events.js";

interface StructuralOwnerGroupingEvaluation {
  baseOwnerId: string;
  directOwnerBucketCount: number;
  filesByStructuralOwner: Map<string, PlannedCommit["files"]>;
}

/**
 * Splits a broad same-owner subtree umbrella by the next structural child
 * surface so one nested feature bucket does not hide unrelated submodules.
 */
export function splitGroupByStructuralOwner(
  group: PlannedCommit,
  buildScopedMessage: (scope: string) => string,
): null | PlannedCommit[] {
  const evaluation = evaluateStructuralOwnerBuckets(group);
  const { baseOwnerId, directOwnerBucketCount, filesByStructuralOwner } =
    evaluation;
  if (filesByStructuralOwner.size <= 1) {
    emitStructuralOwnerSplitEvent({
      diagnostics: buildStructuralOwnerSplitDiagnostics(
        group,
        baseOwnerId,
        directOwnerBucketCount,
        filesByStructuralOwner,
      ),
      group,
      reason: "single-structural-owner",
      resolution: "preserve-group",
    });
    return null;
  }

  const splitGroups = mapOwnerGroupsToCommits(
    filesByStructuralOwner,
    buildScopedMessage,
  );
  emitStructuralOwnerSplitEvent({
    diagnostics: buildStructuralOwnerSplitDiagnostics(
      group,
      baseOwnerId,
      directOwnerBucketCount,
      filesByStructuralOwner,
    ),
    group,
    outputGroups: splitGroups,
    reason:
      directOwnerBucketCount > 1
        ? "refined-multi-owner-umbrella"
        : "split-nested-surface-owner",
    resolution: "split-group",
  });
  return splitGroups;
}

function buildStructuralOwnerSplitDiagnostics(
  group: PlannedCommit,
  baseOwnerId: string,
  directOwnerBucketCount: number,
  filesByStructuralOwner: Map<string, PlannedCommit["files"]>,
): Record<string, boolean | number | string> {
  return {
    baseOwnerId,
    directOwnerBucketCount,
    fileCount: group.files.length,
    refinedStructuralOwnerBucketCount: filesByStructuralOwner.size,
  };
}

/** Evaluates structural-owner buckets before scoped messages are rebuilt. */
function evaluateStructuralOwnerBuckets(
  group: PlannedCommit,
): StructuralOwnerGroupingEvaluation {
  const directOwnerBuckets = groupFilesByOwner(group);
  const baseOwnerId = getPathOwnerDescriptor(
    group.files[0]?.path ?? "",
  ).ownerId;

  return {
    baseOwnerId,
    directOwnerBucketCount: directOwnerBuckets.size,
    filesByStructuralOwner:
      directOwnerBuckets.size > 1
        ? refineOwnerBuckets(directOwnerBuckets)
        : refineNestedSurfaceBuckets(group.files, baseOwnerId),
  };
}

function getChildSurfaceCount(
  baseOwnerId: string,
  filesBySurfaceOwner: Map<string, PlannedCommit["files"]>,
): number {
  return [...filesBySurfaceOwner.keys()].filter(
    (ownerId) => ownerId !== baseOwnerId,
  ).length;
}

function getNestedSurfaceOwnerId(
  filePath: string,
  baseOwnerId: string,
): string {
  const ownerSegments = baseOwnerId.split("/").filter(Boolean);
  const pathSegments = filePath.split("/").filter(Boolean);
  const nextSegment = pathSegments[ownerSegments.length];

  if (!nextSegment || nextSegment.includes(".")) {
    return baseOwnerId;
  }

  return `${baseOwnerId}/${nextSegment}`;
}

function getNestedSurfaceSplitReason(
  files: PlannedCommit["files"],
  baseOwnerId: string,
  filesBySurfaceOwner: Map<string, PlannedCommit["files"]>,
  childSurfaceCount: number,
  shouldSplit: boolean,
): string {
  if (filesBySurfaceOwner.size <= 1) {
    return "single-surface-owner";
  }

  if (shouldSplit) {
    return childSurfaceCount >= 2
      ? "multiple-child-surfaces"
      : "broad-single-child-surface";
  }

  return childSurfaceCount === 0
    ? "base-owner-only"
    : files.length < 5
      ? "shallow-single-child-surface"
      : "insufficient-nested-surface-spread";
}

function groupFilesByNestedSurfaceOwner(
  files: PlannedCommit["files"],
  baseOwnerId: string,
): Map<string, PlannedCommit["files"]> {
  const filesBySurfaceOwner = new Map<string, PlannedCommit["files"]>();

  for (const file of files) {
    const surfaceOwnerId = getNestedSurfaceOwnerId(file.path, baseOwnerId);
    const existing = filesBySurfaceOwner.get(surfaceOwnerId);
    if (existing) {
      existing.push(file);
      continue;
    }

    filesBySurfaceOwner.set(surfaceOwnerId, [file]);
  }

  return filesBySurfaceOwner;
}

function groupFilesByOwner(
  group: PlannedCommit,
): Map<string, PlannedCommit["files"]> {
  const filesByOwner = new Map<string, PlannedCommit["files"]>();

  for (const file of group.files) {
    const root = getPathOwnerDescriptor(file.path).ownerId;
    const existing = filesByOwner.get(root);
    if (existing) {
      existing.push(file);
      continue;
    }

    filesByOwner.set(root, [file]);
  }

  return filesByOwner;
}

function mapOwnerGroupsToCommits(
  filesByOwner: Map<string, PlannedCommit["files"]>,
  buildScopedMessage: (scope: string) => string,
): PlannedCommit[] {
  return [...filesByOwner.entries()].map(([root, files]) => ({
    files,
    message: buildScopedMessage(root),
  }));
}

function refineNestedSurfaceBuckets(
  files: PlannedCommit["files"],
  baseOwnerId: string,
): Map<string, PlannedCommit["files"]> {
  const filesBySurfaceOwner = groupFilesByNestedSurfaceOwner(
    files,
    baseOwnerId,
  );
  const childSurfaceCount = getChildSurfaceCount(
    baseOwnerId,
    filesBySurfaceOwner,
  );
  const shouldSplit = shouldSplitNestedSurfaceOwnerGroup(
    files,
    baseOwnerId,
    filesBySurfaceOwner,
  );
  emitStructuralOwnerBucketEvent({
    baseOwnerId,
    diagnostics: {
      childSurfaceCount,
      fileCount: files.length,
      includesBaseOwnerBucket: filesBySurfaceOwner.has(baseOwnerId),
      surfaceOwnerBucketCount: filesBySurfaceOwner.size,
    },
    reason: getNestedSurfaceSplitReason(
      files,
      baseOwnerId,
      filesBySurfaceOwner,
      childSurfaceCount,
      shouldSplit,
    ),
    resolution: shouldSplit ? "split-bucket" : "preserve-bucket",
  });
  if (!shouldSplit) {
    return new Map([[baseOwnerId, files]]);
  }

  const refinedBuckets = new Map<string, PlannedCommit["files"]>();
  for (const [surfaceOwnerId, surfaceFiles] of filesBySurfaceOwner.entries()) {
    if (surfaceOwnerId === baseOwnerId) {
      refinedBuckets.set(surfaceOwnerId, surfaceFiles);
      continue;
    }

    const nestedBuckets = refineNestedSurfaceBuckets(
      surfaceFiles,
      surfaceOwnerId,
    );
    for (const [nestedOwnerId, nestedFiles] of nestedBuckets.entries()) {
      refinedBuckets.set(nestedOwnerId, nestedFiles);
    }
  }

  return refinedBuckets;
}

function refineOwnerBuckets(
  filesByOwner: Map<string, PlannedCommit["files"]>,
): Map<string, PlannedCommit["files"]> {
  const refinedBuckets = new Map<string, PlannedCommit["files"]>();

  for (const [ownerId, files] of filesByOwner.entries()) {
    const nestedBuckets = refineNestedSurfaceBuckets(files, ownerId);
    for (const [nestedOwnerId, nestedFiles] of nestedBuckets.entries()) {
      refinedBuckets.set(nestedOwnerId, nestedFiles);
    }
  }

  return refinedBuckets;
}

/**
 * Only broad same-owner umbrellas should split by child surface. A small root
 * file plus one shallow helper surface is still one rollout.
 */
function shouldSplitNestedSurfaceOwnerGroup(
  files: PlannedCommit["files"],
  baseOwnerId: string,
  filesBySurfaceOwner: Map<string, PlannedCommit["files"]>,
): boolean {
  if (filesBySurfaceOwner.size <= 1) {
    return false;
  }

  const childSurfaceCount = getChildSurfaceCount(
    baseOwnerId,
    filesBySurfaceOwner,
  );

  return (
    childSurfaceCount >= 2 || (childSurfaceCount >= 1 && files.length >= 5)
  );
}
