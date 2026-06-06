import { emitAiOutputEvent } from "../../openai-client.js";
import {
  type CoverageMismatchDiagnostics,
  groupCoversGroup,
  groupsShareCoverage,
} from "../commit-coverage.js";
import { type FileDiff, type PlannedCommit } from "../grouping-types.js";

export function emitCoverageMismatchPartialSalvage(
  coverageMismatch: CoverageMismatchDiagnostics,
  groups: PlannedCommit[],
  consolidated: PlannedCommit[],
  salvaged: PlannedCommit[],
): void {
  emitAiOutputEvent({
    content: JSON.stringify({
      decision: "consolidation-partial-salvage",
      reason: "coverage-mismatch",
      ...coverageMismatch,
      inputGroupCount: groups.length,
      outputGroupCount: consolidated.length,
      salvagedGroupCount: salvaged.length,
    }),
    kind: "planner-decision",
    stage: "consolidate",
    transport: "internal",
  });
}

/**
 * Keeps only consolidated groups that replace whole baseline groups without
 * dropping or partially overlapping any original coverage.
 */
export function salvageCoverageSafeConsolidation(
  groups: PlannedCommit[],
  consolidated: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): null | PlannedCommit[] {
  const accepted = collectCoverageSafeGroups(groups, consolidated, fileByPath);
  if (accepted.length === 0) {
    return null;
  }

  const salvaged = rebuildGroupsWithAcceptedCoverage(groups, accepted);
  return salvaged.length < groups.length ? salvaged : null;
}

function collectCoverageSafeGroups(
  groups: PlannedCommit[],
  consolidated: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): {
  candidate: PlannedCommit;
  coveredIndexes: number[];
  insertIndex: number;
}[] {
  const accepted: {
    candidate: PlannedCommit;
    coveredIndexes: number[];
    insertIndex: number;
  }[] = [];

  for (const candidate of consolidated) {
    const coveredIndexes = groups.flatMap((group, index) =>
      groupCoversGroup(candidate, group, fileByPath) ? [index] : [],
    );
    if (
      coveredIndexes.length === 0 ||
      hasPartialCoverageOverlap(groups, candidate, coveredIndexes) ||
      overlapsAcceptedCoverage(accepted, candidate)
    ) {
      continue;
    }

    accepted.push({
      candidate,
      coveredIndexes,
      insertIndex: Math.min(...coveredIndexes),
    });
  }

  return accepted;
}

function hasPartialCoverageOverlap(
  groups: PlannedCommit[],
  candidate: PlannedCommit,
  coveredIndexes: number[],
): boolean {
  return groups.some(
    (group, index) =>
      groupsShareCoverage(candidate, group) && !coveredIndexes.includes(index),
  );
}

function overlapsAcceptedCoverage(
  accepted: { candidate: PlannedCommit }[],
  candidate: PlannedCommit,
): boolean {
  return accepted.some(({ candidate: acceptedCandidate }) =>
    groupsShareCoverage(acceptedCandidate, candidate),
  );
}

function rebuildGroupsWithAcceptedCoverage(
  groups: PlannedCommit[],
  accepted: {
    candidate: PlannedCommit;
    coveredIndexes: number[];
    insertIndex: number;
  }[],
): PlannedCommit[] {
  const coveredIndexSet = new Set(
    accepted.flatMap(({ coveredIndexes }) => coveredIndexes),
  );
  const acceptedByIndex = new Map(
    accepted.map((entry) => [entry.insertIndex, entry.candidate]),
  );
  const salvaged: PlannedCommit[] = [];

  for (let index = 0; index < groups.length; index++) {
    const acceptedCandidate = acceptedByIndex.get(index);
    if (acceptedCandidate) {
      salvaged.push(acceptedCandidate);
    }
    if (!coveredIndexSet.has(index)) {
      salvaged.push(groups[index]);
    }
  }

  return salvaged;
}
