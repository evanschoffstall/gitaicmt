import type { PlannedCommit } from "../grouping-types.js";

import { parseConventionalSubject } from "../../../commit-messages/subject-parser.js";
import { getPathOwnerDescriptor } from "../ownership.js";
import { isSupportLikeType, parseSubjectWords } from "../subject/analysis.js";

const BREAKING_CHANGE_FOOTER_PATTERN = /^BREAKING[ -]CHANGE:\s+\S/i;

export function getGroupOwnerIds(group: PlannedCommit): Set<string> {
  return new Set(
    group.files.map((file) => getPathOwnerDescriptor(file.path).ownerId),
  );
}

export function getSingleCoveredImplementationSubjectLine(
  coveredGroups: PlannedCommit[],
): null | string {
  const implementationSubjects = coveredGroups
    .map((coveredGroup) => coveredGroup.message.split("\n")[0] ?? "")
    .filter((subjectLine) => {
      const subject = parseSubjectWords(subjectLine);
      return subject.type.length > 0 && !isSupportLikeType(subject.type);
    });

  if (implementationSubjects.length !== 1) {
    return null;
  }

  return implementationSubjects[0];
}

export function hasBreakingMetadata(message: string): boolean {
  const [subject, ...bodyLines] = message.split("\n");
  return (
    parseConventionalSubject(subject).isBreaking ||
    bodyLines.some((line) => BREAKING_CHANGE_FOOTER_PATTERN.test(line))
  );
}

export function replaceSubjectLine(
  message: string,
  subjectLine: string,
): string {
  const [, ...bodyLines] = message.split("\n");
  return bodyLines.length === 0
    ? subjectLine
    : [subjectLine, ...bodyLines].join("\n");
}
