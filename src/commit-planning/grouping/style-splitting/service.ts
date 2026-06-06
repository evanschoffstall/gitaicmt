import type { PlannedCommit } from "../grouping-types.js";

import {
  normalizeConventionalScope,
  normalizeConventionalSubjectScope,
} from "../../../commit-messages/subject-parser.js";
import { getPathOwnerDescriptor } from "../ownership.js";
import { parseSubjectWords } from "../subject/analysis.js";
import { splitMultiAreaStyleGroup } from "./area-splitting.js";

const BROAD_STYLE_FILE_THRESHOLD = 12;
const LARGE_STYLE_OWNER_FILE_THRESHOLD = 8;
const BROAD_STYLE_OWNER_THRESHOLD = 3;

interface StyleOwnerGroup {
  files: PlannedCommit["files"];
  ownerId: string;
}

interface StyleOwnerProfile {
  hasDirectFile: boolean;
}

/** Identifies conventional-commit style groups for support repartitioning. */
export function isStyleGroup(group: PlannedCommit): boolean {
  return parseSubjectWords(group.message.split("\n")[0] ?? "").type === "style";
}

/** Keeps already-separated broad style areas from being folded into one bucket. */
export function shouldPreserveBroadStyleAreas(
  groups: PlannedCommit[],
): boolean {
  const totalFileCount = groups.reduce(
    (count, group) => count + group.files.length,
    0,
  );
  const largeStyleGroupCount = groups.filter(
    (group) => group.files.length >= 3,
  ).length;
  const styleOwnerCount = countStyleOwners(groups);

  return (
    (totalFileCount >= BROAD_STYLE_FILE_THRESHOLD &&
      largeStyleGroupCount >= 2 &&
      styleOwnerCount >= 2) ||
    (largeStyleGroupCount >= 2 && countDistinctTopAreas(groups) >= 2)
  );
}

/** Splits oversized style buckets along structural ownership boundaries. */
export function splitBroadStyleGroups(
  groups: PlannedCommit[],
): PlannedCommit[] {
  return groups.flatMap((group) => splitBroadStyleGroup(group));
}

function buildResidualStyleMessage(group: PlannedCommit): string {
  const [subjectLine, ...bodyLines] = group.message.split("\n");
  const subject = parseSubjectWords(subjectLine);
  const description = extractSubjectDescription(subjectLine);
  return [`${subject.type}: ${description}`, ...bodyLines].join("\n");
}

function buildStyleOwnershipMessage(
  group: PlannedCommit,
  ownerId: string,
): string {
  const [subjectLine, ...bodyLines] = group.message.split("\n");
  const subject = parseSubjectWords(subjectLine);
  if (subject.type !== "style") {
    return group.message;
  }

  const scope = getStyleOwnerScope(ownerId);
  const description = extractSubjectDescription(subjectLine);
  const nextSubject =
    scope.length > 0
      ? `style(${scope}): ${description}`
      : `style: ${description}`;
  return normalizeConventionalSubjectScope(
    [nextSubject, ...bodyLines].join("\n"),
  );
}

function countDistinctTopAreas(groups: PlannedCommit[]): number {
  const areas = new Set<string>();
  for (const group of groups) {
    for (const file of group.files) {
      areas.add(file.path.split("/").find(Boolean) ?? "root");
    }
  }
  return areas.size;
}

function countStyleOwners(groups: PlannedCommit[]): number {
  const ownerIds = new Set<string>();

  for (const group of groups) {
    const ownerProfiles = getStyleOwnerProfiles(group);
    for (const ownerGroup of splitStyleOwners(group, ownerProfiles)) {
      ownerIds.add(ownerGroup.ownerId);
    }
  }

  return ownerIds.size;
}

function extractSubjectDescription(subjectLine: string): string {
  const colonIndex = subjectLine.indexOf(":");
  return colonIndex >= 0
    ? subjectLine.slice(colonIndex + 1).trim()
    : subjectLine.trim();
}

function getStyleOwnerProfiles(
  group: PlannedCommit,
): Map<string, StyleOwnerProfile> {
  const profiles = new Map<string, StyleOwnerProfile>();

  for (const file of group.files) {
    const descriptor = getPathOwnerDescriptor(file.path);
    const profile = profiles.get(descriptor.featureRoot) ?? {
      hasDirectFile: false,
    };

    if (descriptor.kind !== "nested-subtree") {
      profile.hasDirectFile = true;
    }

    profiles.set(descriptor.featureRoot, profile);
  }

  return profiles;
}

function getStyleOwnerScope(ownerId: string): string {
  const candidate = ownerId.split("/").filter(Boolean).at(-1) ?? ownerId;
  return normalizeConventionalScope(candidate);
}

function getStyleOwnershipId(
  filePath: string,
  ownerProfiles: Map<string, StyleOwnerProfile>,
): string {
  const descriptor = getPathOwnerDescriptor(filePath);
  const profile = ownerProfiles.get(descriptor.featureRoot);
  if (profile?.hasDirectFile) {
    return descriptor.featureRoot;
  }

  return descriptor.kind === "nested-subtree"
    ? descriptor.ownerId
    : descriptor.featureRoot;
}

function shouldSplitBroadStyleGroup(group: PlannedCommit): boolean {
  return (
    isStyleGroup(group) &&
    (group.files.length >= BROAD_STYLE_FILE_THRESHOLD ||
      splitMultiAreaStyleGroup(group) !== null)
  );
}

function splitBroadStyleGroup(group: PlannedCommit): PlannedCommit[] {
  if (!shouldSplitBroadStyleGroup(group)) {
    return [group];
  }

  const areaGroups = splitMultiAreaStyleGroup(group);
  if (areaGroups) {
    return areaGroups.flatMap((areaGroup) => splitBroadStyleGroup(areaGroup));
  }

  const ownerProfiles = getStyleOwnerProfiles(group);
  const ownerGroups = splitStyleOwners(group, ownerProfiles);

  if (ownerGroups.length < BROAD_STYLE_OWNER_THRESHOLD) {
    return [group];
  }

  const largeOwnerGroups = ownerGroups.filter(
    (ownerGroup) => ownerGroup.files.length >= LARGE_STYLE_OWNER_FILE_THRESHOLD,
  );
  if (largeOwnerGroups.length === 0) {
    return [group];
  }

  const residualFiles = ownerGroups
    .filter(
      (ownerGroup) =>
        ownerGroup.files.length < LARGE_STYLE_OWNER_FILE_THRESHOLD,
    )
    .flatMap((ownerGroup) => ownerGroup.files);

  return [
    ...largeOwnerGroups.map((ownerGroup) => ({
      files: ownerGroup.files,
      message: buildStyleOwnershipMessage(group, ownerGroup.ownerId),
    })),
    ...(residualFiles.length > 0
      ? [
          {
            files: residualFiles,
            message: buildResidualStyleMessage(group),
          },
        ]
      : []),
  ];
}

function splitStyleOwners(
  group: PlannedCommit,
  ownerProfiles: Map<string, StyleOwnerProfile>,
): StyleOwnerGroup[] {
  const filesByOwner = new Map<string, PlannedCommit["files"]>();
  for (const file of group.files) {
    const ownerId = getStyleOwnershipId(file.path, ownerProfiles);
    const existing = filesByOwner.get(ownerId);
    if (existing) {
      existing.push(file);
      continue;
    }
    filesByOwner.set(ownerId, [file]);
  }

  return [...filesByOwner.entries()].map(([ownerId, files]) => ({
    files,
    ownerId,
  }));
}
