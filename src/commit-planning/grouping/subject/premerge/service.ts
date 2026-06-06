import { hasMatchingCoverage } from "../../commit-coverage.js";
import { emitPremergeSummaryEvent } from "../../group/events.js";
import { mergeCommitClusters } from "../../group/merge.js";
import { type FileDiff, type PlannedCommit } from "../../grouping-types.js";
import { parseSubjectWords } from "../analysis.js";
import {
  findSubjectClusterRoot,
  runPremergePairPass,
} from "./pair-evaluation.js";

type PremergeReason =
  | "coverage-mismatch-fallback"
  | "merged-clusters"
  | "no-premerge-pairs"
  | "single-group-input";

interface PremergeSummaryInput {
  clusterCount: number;
  inputGroups: PlannedCommit[];
  matchedPairCount: number;
  multiGroupClusterCount?: number;
  outputGroups: PlannedCommit[];
  pairCount: number;
  reason: PremergeReason;
  resolution: "preserve-input" | "use-premerged";
}

/**
 * Deterministically merges obviously related commits before asking AI to do
 * more expensive clustering or consolidation work.
 */
export function premergeBySubject(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  if (groups.length < 2) {
    emitPreservedPremergeSummary({
      clusterCount: groups.length,
      groups,
      matchedPairCount: 0,
      pairCount: 0,
      reason: "single-group-input",
    });
    return groups;
  }

  const wordSets = groups.map((group) =>
    parseSubjectWords(group.message.split("\n")[0] ?? ""),
  );
  const { matchedPairCount, pairCount, parent } = runPremergePairPass(
    groups,
    wordSets,
    fileByPath,
  );

  const clusters = buildSubjectClusters(groups.length, parent);
  if (!clusters.some((cluster) => cluster.length > 1)) {
    emitPreservedPremergeSummary({
      clusterCount: clusters.length,
      groups,
      matchedPairCount,
      pairCount,
      reason: "no-premerge-pairs",
    });
    return groups;
  }

  const merged = mergeCommitClusters(groups, clusters, fileByPath);
  const hasCoverageMatch = hasMatchingCoverage(groups, merged, fileByPath);
  const outputGroups = hasCoverageMatch ? merged : groups;

  emitMergedPremergeSummary(
    groups,
    outputGroups,
    clusters,
    matchedPairCount,
    pairCount,
    hasCoverageMatch,
  );

  return outputGroups;
}

function buildSubjectClusters(
  groupCount: number,
  parent: number[],
): number[][] {
  const clusterMap = new Map<number, number[]>();

  for (let index = 0; index < groupCount; index++) {
    const root = findSubjectClusterRoot(parent, index);
    const existing = clusterMap.get(root);
    if (existing) {
      existing.push(index);
    } else {
      clusterMap.set(root, [index]);
    }
  }

  return [...clusterMap.values()];
}

function emitMergedPremergeSummary(
  groups: PlannedCommit[],
  outputGroups: PlannedCommit[],
  clusters: number[][],
  matchedPairCount: number,
  pairCount: number,
  hasCoverageMatch: boolean,
): void {
  emitPremergeSummary({
    clusterCount: clusters.length,
    inputGroups: groups,
    matchedPairCount,
    multiGroupClusterCount: clusters.filter((cluster) => cluster.length > 1)
      .length,
    outputGroups,
    pairCount,
    reason: hasCoverageMatch ? "merged-clusters" : "coverage-mismatch-fallback",
    resolution: hasCoverageMatch ? "use-premerged" : "preserve-input",
  });
}

function emitPremergeSummary(summary: PremergeSummaryInput): void {
  emitPremergeSummaryEvent({
    diagnostics: {
      clusterCount: summary.clusterCount,
      matchedPairCount: summary.matchedPairCount,
      multiGroupClusterCount: summary.multiGroupClusterCount ?? 0,
      pairCount: summary.pairCount,
    },
    inputGroups: summary.inputGroups,
    outputGroups: summary.outputGroups,
    reason: summary.reason,
    resolution: summary.resolution,
  });
}

function emitPreservedPremergeSummary(input: {
  clusterCount: number;
  groups: PlannedCommit[];
  matchedPairCount: number;
  pairCount: number;
  reason: Extract<PremergeReason, "no-premerge-pairs" | "single-group-input">;
}): void {
  emitPremergeSummary({
    clusterCount: input.clusterCount,
    inputGroups: input.groups,
    matchedPairCount: input.matchedPairCount,
    outputGroups: input.groups,
    pairCount: input.pairCount,
    reason: input.reason,
    resolution: "preserve-input",
  });
}
