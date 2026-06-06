import { isSupportLikePath } from "../../path/index.js";
import { type PlannedCommit } from "../grouping-types.js";
import { getPathOwnerDescriptor } from "../ownership.js";
import { parseSubjectWords } from "../subject/analysis.js";

export function getClusterSizeDiagnostics(
  groups: PlannedCommit[],
  clusters: number[][],
  maxSingleClusterSize: number,
): {
  hasOversizedNonStyleCluster: boolean;
  largestClusterSize: number;
  oversizedClusterCount: number;
} {
  return {
    hasOversizedNonStyleCluster: clusters.some(
      (cluster) =>
        cluster.length > maxSingleClusterSize &&
        !isHomogeneousStyleCluster(groups, cluster),
    ),
    largestClusterSize: Math.max(
      0,
      ...clusters.map((cluster) => cluster.length),
    ),
    oversizedClusterCount: clusters.filter(
      (cluster) => cluster.length > maxSingleClusterSize,
    ).length,
  };
}

export function hasMeaningfulConsolidationChange(
  previousGroups: PlannedCommit[],
  nextGroups: PlannedCommit[],
): boolean {
  if (previousGroups.length !== nextGroups.length) {
    return true;
  }

  const previousByCoverage = new Map(
    previousGroups.map((group) => [getGroupCoverageKey(group), group.message]),
  );

  return nextGroups.some((group) => {
    const previousMessage = previousByCoverage.get(getGroupCoverageKey(group));
    return previousMessage !== undefined && previousMessage !== group.message;
  });
}

export function hasSupportAttachedToMixedImplementationRoots(
  groups: PlannedCommit[],
): boolean {
  return groups.some((group) => {
    const implementationRoots = new Set(
      group.files
        .filter((file) => !isSupportLikePath(file.path))
        .map((file) => getPathOwnerDescriptor(file.path).featureRoot)
        .filter((featureRoot) => featureRoot !== "root"),
    );

    return (
      group.files.some((file) => isSupportLikePath(file.path)) &&
      implementationRoots.size > 1
    );
  });
}

function getGroupCoverageKey(group: PlannedCommit): string {
  return group.files
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right))
    .join("\u0000");
}

function isHomogeneousStyleCluster(
  groups: PlannedCommit[],
  cluster: number[],
): boolean {
  return cluster.every((index) => {
    const subject = parseSubjectWords(
      groups[index]?.message.split("\n")[0] ?? "",
    );
    return subject.type === "style";
  });
}
