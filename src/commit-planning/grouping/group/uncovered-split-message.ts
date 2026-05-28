import type { PlannedCommit } from "../grouping-types.js";

import {
  normalizeConventionalScope,
  normalizeConventionalSubjectScope,
} from "../../../commit-messages/subject-parser.js";
import { getPathOwnerDescriptor } from "../ownership.js";
import { parseSubjectWords } from "../subject/analysis.js";

/**
 * Rewrites split commit messages that no longer cover any source group but
 * still represent a public export surface split out of a broader umbrella.
 */
export function rewriteUncoveredSplitMessage(
  group: PlannedCommit,
): PlannedCommit {
  const subjectLine = group.message.split("\n")[0] ?? "";
  const rewrittenSubject = rewriteExportSurfaceSubject(subjectLine, group);
  const normalizedSubject =
    rewrittenSubject !== subjectLine
      ? rewrittenSubject
      : rewriteSingleOwnerUntypedSubject(subjectLine, group);

  if (normalizedSubject !== subjectLine) {
    return {
      ...group,
      message: normalizedSubject,
    };
  }

  const hasBody = group.message
    .split("\n")
    .slice(1)
    .some((line) => line.trim().length > 0);
  if (!hasBody) {
    return group;
  }

  return {
    ...group,
    message: subjectLine,
  };
}

function isExportSurfaceOnlyGroup(group: PlannedCommit): boolean {
  return (
    group.files.length > 0 &&
    group.files.every((file) => isExportSurfacePath(file.path))
  );
}

function isExportSurfacePath(filePath: string): boolean {
  const basename = filePath.split("/").at(-1) ?? "";
  if (!/^index\.[^.]+$/u.test(basename)) {
    return false;
  }

  const owner = getPathOwnerDescriptor(filePath);
  return owner.kind === "direct-file" || owner.kind === "nested-subtree";
}

function rewriteExportSurfaceSubject(
  subjectLine: string,
  group: PlannedCommit,
): string {
  const subject = parseSubjectWords(subjectLine);
  if (subject.type.length === 0 || !isExportSurfaceOnlyGroup(group)) {
    return subjectLine;
  }

  const normalizedScope =
    subject.scope.length > 0 ? normalizeConventionalScope(subject.scope) : "";
  const subjectPrefix =
    normalizedScope.length > 0
      ? `${subject.type}(${normalizedScope})`
      : subject.type;
  return normalizeConventionalSubjectScope(
    `${subjectPrefix}: update public exports`,
  );
}

function rewriteSingleOwnerUntypedSubject(
  subjectLine: string,
  group: PlannedCommit,
): string {
  const subject = parseSubjectWords(subjectLine);
  if (subject.type.length > 0 || group.files.length === 0) {
    return subjectLine;
  }

  const owners = new Set(
    group.files.map((file) => getPathOwnerDescriptor(file.path).ownerId),
  );
  const singleOwner = [...owners][0];
  if (owners.size !== 1 || !singleOwner || singleOwner === "root") {
    return subjectLine;
  }

  const normalizedScope = normalizeConventionalScope(singleOwner);
  const subjectPrefix =
    normalizedScope.length > 0 ? `chore(${normalizedScope})` : "chore";
  return normalizeConventionalSubjectScope(
    `${subjectPrefix}: update related slice`,
  );
}
