import { complete } from "./ai-client.js";
import {
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
} from "./ai-prompt-builders.js";
import { type PlannedCommit } from "./ai-types.js";
import { validateAndNormalizeGrouping } from "./ai-validation.js";
import { ValidationError } from "./errors.js";

type FileDiff = import("./diff.js").FileDiff;

export async function finalizePlannedGroups(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
): Promise<PlannedCommit[]> {
  if (groups.length < 2) {
    return groups;
  }

  try {
    const fileByPath = new Map(allFiles.map((file) => [file.path, file]));
    const sys = buildConsolidationSystemPrompt();
    const usr = buildConsolidationUserPrompt(allFiles, groups);
    const raw = await complete(sys, usr);
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");
    const parsed = JSON.parse(cleaned) as unknown;
    const consolidated = validateAndNormalizeGrouping(parsed, fileByPath);

    return hasMatchingCoverage(groups, consolidated, fileByPath)
      ? consolidated
      : groups;
  } catch {
    return groups;
  }
}

function getCoverageKeys(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): string[] {
  const keys: string[] = [];

  for (const group of groups) {
    for (const fileRef of group.files) {
      const file = fileByPath.get(fileRef.path);
      if (!file) {
        throw new ValidationError(
          `Missing file for coverage check: ${fileRef.path}`,
        );
      }

      if (fileRef.hunks && fileRef.hunks.length > 0) {
        keys.push(
          ...fileRef.hunks.map((hunk) => `${fileRef.path}#${String(hunk)}`),
        );
        continue;
      }

      if (file.hunks.length === 0) {
        keys.push(`${fileRef.path}#file`);
        continue;
      }

      for (let index = 0; index < file.hunks.length; index++) {
        keys.push(`${fileRef.path}#${String(index)}`);
      }
    }
  }

  keys.sort();
  return keys;
}

function hasMatchingCoverage(
  before: PlannedCommit[],
  after: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): boolean {
  const beforeKeys = getCoverageKeys(before, fileByPath);
  const afterKeys = getCoverageKeys(after, fileByPath);

  if (beforeKeys.length !== afterKeys.length) {
    return false;
  }

  for (let index = 0; index < beforeKeys.length; index++) {
    if (beforeKeys[index] !== afterKeys[index]) {
      return false;
    }
  }

  return new Set(afterKeys).size === afterKeys.length;
}
