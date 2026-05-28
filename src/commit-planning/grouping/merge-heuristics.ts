import { groupCoversGroup } from "./commit-coverage.js";
import { type FileDiff, type PlannedCommit } from "./grouping-types.js";
import { hasImplementationMergeSignal } from "./implementation-merge/index.js";
import { isSupportLikeType, parseSubjectWords } from "./subject/analysis.js";
import { chooseSupportAttachment } from "./support-attachment/index.js";

export { chooseSupportAttachment, hasImplementationMergeSignal };

/** Filter consolidated groups down to the ones that still cover more than one baseline group. */
export function getCoveredBaselineGroups(
  baselineGroups: PlannedCommit[],
  group: PlannedCommit,
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  return baselineGroups.filter((baseline) =>
    groupCoversGroup(group, baseline, fileByPath),
  );
}

/** Return true when a group is primarily support work rather than implementation work. */
export function isSupportGroup(group: PlannedCommit): boolean {
  return isSupportLikeType(
    parseSubjectWords(group.message.split("\n")[0] ?? "").type,
  );
}
