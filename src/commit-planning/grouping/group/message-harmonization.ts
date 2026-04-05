import type { FileDiff, PlannedCommit } from "../grouping-types.js";

import {
  groupCoversGroup,
} from "../commit-coverage.js";
import {
  isSupportLikeType,
  parseSubjectWords,
} from "../subject/analysis.js";
import {
  mergeCommitMessages,
  prioritizeMergedCommits,
} from "./merge.js";

export function countMessageDetailBullets(message: string): number {
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ")).length;
}

export function harmonizeConsolidatedMessages(
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