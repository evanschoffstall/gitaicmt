import { MAX_CONSOLIDATION_PASSES } from "../application/constants.js";
import { type FileDiff } from "../git/diff.js";
import { type PlannedCommit } from "./types.js";

/** Build placeholder plan groups so token estimation can model follow-up planner passes. */
export function buildPlaceholderPlanGroupsForEstimate(
  files: FileDiff[],
  estimatedGroupCount: number,
): PlannedCommit[] {
  if (estimatedGroupCount <= 1) {
    return [
      {
        files: files.map((file) => ({ path: file.path })),
        message:
          "chore(plan): summarize staged changes\n\n- Cover the staged changes coherently.",
      },
    ];
  }

  const groups: PlannedCommit[] = [];
  const size = Math.max(1, Math.ceil(files.length / estimatedGroupCount));

  for (let index = 0; index < files.length; index += size) {
    const batch = files.slice(index, index + size);
    groups.push({
      files: batch.map((file) => ({ path: file.path })),
      message: [
        `feat(plan): change ${String(groups.length + 1)}`,
        "",
        `- Cover the staged files grouped into change ${String(groups.length + 1)}.`,
      ].join("\n"),
    });
  }

  return groups;
}

/** Estimate how many consolidation passes are likely for a provisional plan size. */
export function estimateLikelyConsolidationPassCount(
  groupCount: number,
): number {
  let remainingGroups = groupCount;
  let passCount = 0;

  while (remainingGroups > 2) {
    passCount++;
    remainingGroups = Math.max(1, Math.ceil(remainingGroups / 2));
  }

  const bufferedPassCount = groupCount >= 5 ? passCount + 1 : passCount;
  return Math.min(bufferedPassCount, MAX_CONSOLIDATION_PASSES);
}

/** Estimate the number of commit groups the planner is likely to return for a file set. */
export function estimateLikelyPlanGroupCount(files: FileDiff[]): number {
  if (files.length <= 1) {
    return 1;
  }

  const multiHunkFiles = files.filter((file) => file.hunks.length > 1).length;
  const areaCount = new Set(files.map((file) => getTopLevelArea(file.path)))
    .size;
  const complexityScore =
    files.length + multiHunkFiles + Math.max(0, areaCount - 1);

  return Math.max(2, Math.min(files.length, Math.ceil(complexityScore / 3)));
}

function getTopLevelArea(path: string): string {
  const [head, tail] = path.split("/");
  return tail ? head : "(root)";
}
