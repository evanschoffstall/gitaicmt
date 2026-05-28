/** Generic path-derived ownership helpers for grouping and consolidation. */

import {
  getFlattenedSubtreeOwnerId,
  getMeaningfulPathLabel,
  getStructuralFeatureBoundary,
  isSupportLikePath,
  splitProjectPathSegments,
} from "../path/index.js";

const GENERIC_SUPPORT_SCOPE_TOKENS = new Set([
  "case",
  "cases",
  "coverage",
  "index",
  "main",
  "readme",
  "spec",
  "suite",
  "suites",
  "test",
]);

const GENERIC_SUPPORT_ENTRYPOINT_TOKENS = new Set(["index", "main", "readme"]);

export interface PathOwnerDescriptor {
  featureRoot: string;
  kind: "direct-file" | "nested-subtree" | "other";
  ownerId: string;
}

/**
 * Describes whether a path belongs to a direct file owner or a nested subtree
 * owner within a top-level feature root.
 */
export function getPathOwnerDescriptor(filePath: string): PathOwnerDescriptor {
  const { featureRoot, pathSegments } = getStructuralFeatureBoundary(filePath);
  if (featureRoot.includes("/") && featureRoot !== "root") {
    const featureDepth = featureRoot.split("/").length;
    const flattenedSubtreeOwnerId = getFlattenedSubtreeOwnerId(filePath);
    if (flattenedSubtreeOwnerId) {
      return {
        featureRoot,
        kind: "nested-subtree",
        ownerId: flattenedSubtreeOwnerId,
      };
    }

    if (isDirectorySegment(pathSegments[featureDepth])) {
      return {
        featureRoot,
        kind: "nested-subtree",
        ownerId: pathSegments.slice(0, featureDepth + 1).join("/"),
      };
    }

    return {
      featureRoot,
      kind: "direct-file",
      ownerId: featureRoot,
    };
  }

  return {
    featureRoot: getPathOwnershipRoot(filePath),
    kind: "other",
    ownerId: getPathOwnershipRoot(filePath),
  };
}

/**
 * Returns a stable ownership root from a file path without relying on
 * repository-specific feature aliases.
 */
export function getPathOwnershipRoot(filePath: string): string {
  const { featureRoot, pathSegments, rootArea } =
    getStructuralFeatureBoundary(filePath);
  if (pathSegments.length === 0) {
    return "root";
  }
  if (pathSegments.length === 1) {
    return "root";
  }

  if (featureRoot.includes("/") && featureRoot !== rootArea) {
    const featureDepth = featureRoot.split("/").length;
    const flattenedSubtreeOwnerId = getFlattenedSubtreeOwnerId(filePath);
    if (flattenedSubtreeOwnerId) {
      return flattenedSubtreeOwnerId;
    }

    if (isDirectorySegment(pathSegments[featureDepth])) {
      return pathSegments.slice(0, featureDepth + 1).join("/");
    }

    return featureRoot;
  }

  if (isSupportLikePath(filePath)) {
    return `${rootArea}/${inferSupportScopeFromPath(filePath)}`;
  }

  if (isDirectorySegment(pathSegments[1])) {
    return pathSegments.slice(0, 2).join("/");
  }

  return pathSegments[0] ?? "root";
}

/**
 * Returns a display-friendly support scope for per-file split messages while
 * dropping broad suffixes such as coverage or suite from the basename.
 */
export function inferSplitSupportScopeFromPath(filePath: string): string {
  const pathSegments = splitPathSegments(filePath);
  const stemScope = buildDisplaySupportScope(pathSegments.at(-1) ?? "");
  if (stemScope.length > 0) {
    return stemScope;
  }

  return inferSupportScopeFromPath(filePath);
}

/**
 * Infers a support scope label from the filename and nearest meaningful
 * directory so split support groups remain structural rather than thematic.
 */
export function inferSupportScopeFromPath(filePath: string): string {
  const pathSegments = splitPathSegments(filePath);
  const stemScope = buildSupportScopeFromStem(
    normalizeFileStem(pathSegments.at(-1) ?? ""),
  );
  if (stemScope.length > 0) {
    return stemScope;
  }

  const directoryScope = buildSupportScopeFromDirectories(
    pathSegments.slice(0, -1),
  );
  if (directoryScope.length > 0) {
    return directoryScope;
  }

  return getStructuralFeatureBoundary(filePath).rootArea;
}

function buildDisplaySupportScope(fileName: string): string {
  const supportTokens = fileName
    .replace(/\.[^.]+$/u, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0)
    .filter((token) => !GENERIC_SUPPORT_SCOPE_TOKENS.has(token));

  return supportTokens.join("-");
}

function buildSupportScopeFromDirectories(directories: string[]): string {
  return directories
    .slice(-2)
    .map(getMeaningfulPathLabel)
    .filter(Boolean)
    .join("-");
}

function buildSupportScopeFromStem(stem: string): string {
  if (stem.length === 0) {
    return "";
  }

  const supportTokens = stem
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);

  if (supportTokens.length > 1 && supportTokens[0]?.length <= 2) {
    supportTokens.shift();
  }
  if (
    supportTokens.length === 1 &&
    GENERIC_SUPPORT_ENTRYPOINT_TOKENS.has(supportTokens[0] ?? "")
  ) {
    return "";
  }

  return supportTokens.join("-");
}

function isDirectorySegment(segment: string | undefined): boolean {
  return typeof segment === "string" && !segment.includes(".");
}

function normalizeFileStem(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/u, "")
    .replace(/\.(test|spec)$/u, "")
    .replace(/[^A-Za-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function splitPathSegments(filePath: string): string[] {
  return splitProjectPathSegments(filePath);
}
