import {
  normalizeConventionalScope,
  normalizeConventionalSubjectScope,
} from "../../commit-messages/subject-parser.js";
import { parseSubjectWords } from "./subject/analysis.js";

export function buildScopedMessage(
  message: string,
  scopeValue: string,
): string {
  const [subjectLine, ...bodyLines] = message.split("\n");
  const subject = parseSubjectWords(subjectLine);
  if (subject.type.length === 0) {
    return message;
  }

  const normalizedScope = normalizeConventionalScope(scopeValue);
  const description = extractSubjectDescription(subjectLine);
  const scopedSubject =
    normalizedScope.length > 0
      ? `${subject.type}(${normalizedScope}): ${description}`
      : `${subject.type}: ${description}`;
  return normalizeConventionalSubjectScope(
    [scopedSubject, ...bodyLines].join("\n"),
  );
}

function extractSubjectDescription(subjectLine: string): string {
  const colonIndex = subjectLine.indexOf(":");
  return colonIndex >= 0
    ? subjectLine.slice(colonIndex + 1).trim()
    : subjectLine.trim();
}
