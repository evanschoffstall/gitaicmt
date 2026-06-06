import type { PlannedCommit } from "../grouping-types.js";

import { getTopLevelAreaName } from "../../path/index.js";
import { buildScopedMessage } from "../scoped-message.js";

const MULTI_AREA_STYLE_FILE_THRESHOLD = 6;
const MULTI_AREA_STYLE_MIN_AREA_FILE_COUNT = 2;

/** Splits broad style sweeps by substantial top-level path areas. */
export function splitMultiAreaStyleGroup(
  group: PlannedCommit,
): null | PlannedCommit[] {
  if (!shouldSplitMultiAreaStyleGroup(group)) {
    return null;
  }

  const filesByArea = new Map<string, PlannedCommit["files"]>();
  for (const file of group.files) {
    const area = getTopLevelArea(file.path);
    const existing = filesByArea.get(area);
    if (existing) {
      existing.push(file);
      continue;
    }
    filesByArea.set(area, [file]);
  }

  return [...filesByArea.entries()].map(([area, files]) => ({
    files,
    message: buildStyleAreaMessage(group, area),
  }));
}

function buildStyleAreaMessage(group: PlannedCommit, area: string): string {
  return buildScopedMessage(group.message, area);
}

function getTopLevelArea(filePath: string): string {
  return getTopLevelAreaName(filePath);
}

function getTopLevelAreaCounts(group: PlannedCommit): Map<string, number> {
  const areaCounts = new Map<string, number>();
  for (const file of group.files) {
    const area = getTopLevelArea(file.path);
    areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
  }
  return areaCounts;
}

function shouldSplitMultiAreaStyleGroup(group: PlannedCommit): boolean {
  if (group.files.length < MULTI_AREA_STYLE_FILE_THRESHOLD) {
    return false;
  }

  const areaCounts = getTopLevelAreaCounts(group);
  const counts = [...areaCounts.values()];
  const dominantAreaCount = Math.max(...counts);
  const residualAreaCount = group.files.length - dominantAreaCount;

  return (
    counts.filter((count) => count >= MULTI_AREA_STYLE_MIN_AREA_FILE_COUNT)
      .length > 1 ||
    (areaCounts.size >= 2 &&
      dominantAreaCount >= MULTI_AREA_STYLE_FILE_THRESHOLD &&
      residualAreaCount > 0 &&
      residualAreaCount <= 2)
  );
}
