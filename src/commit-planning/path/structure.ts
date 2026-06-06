import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAllContainerRootNames,
  getAllSupportRootNames,
  resolveRepositoryRootPath,
} from "./repository-structure.js";

const GENERIC_PATH_WORDS = new Set([
  "cjs",
  "cts",
  "file",
  "files",
  "index",
  "js",
  "json",
  "jsx",
  "main",
  "mjs",
  "mts",
  "readme",
  "root",
  "spec",
  "specs",
  "test",
  "tests",
  "ts",
  "tsx",
]);

const GENERIC_ARTIFACT_LABEL_TOKENS = new Set(["readme", "spec", "test"]);

export interface StructuralFeatureBoundary {
  featureRoot: string;
  pathSegments: string[];
  rootArea: string;
}

const moduleRepositoryRootPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
).replace(/\\/gu, "/");

/**
 * Returns flattened feature metadata for paths stored as
 * <container-root>/<feature>/<file>.
 */
export function getContainerFeatureFileInfo(filePath: string): null | {
  containerRoot: string;
  featureName: string;
  featureRoot: string;
  fileName: string;
  pathSegments: string[];
} {
  const pathSegments = splitProjectPathSegments(filePath);
  if (
    pathSegments.length !== 3 ||
    !pathSegments[0] ||
    !pathSegments[1] ||
    !pathSegments[2]?.includes(".") ||
    !isBroadContainerRoot(pathSegments[0])
  ) {
    return null;
  }

  return {
    containerRoot: pathSegments[0],
    featureName: pathSegments[1],
    featureRoot: pathSegments.slice(0, 2).join("/"),
    fileName: pathSegments[2],
    pathSegments,
  };
}

/** Returns a stable normalized label built from structural path words. */
export function getMeaningfulPathLabel(pathLikeValue: string): string {
  return getMeaningfulPathWords(pathLikeValue).join("-");
}

/**
 * Returns meaningful structural tokens from a path-like string while dropping
 * broad container roots and other boilerplate tokens.
 */
export function getMeaningfulPathWords(pathLikeValue: string): string[] {
  return pathLikeValue
    .split(/[^a-z0-9]+/iu)
    .filter((word) => isMeaningfulPathWord(word));
}

/** Returns a stable basename label without generic support or README suffixes. */
export function getPathArtifactLabel(pathLikeValue: string): string {
  const words = pathLikeValue
    .replace(/\.[^.]+$/u, "")
    .split(/[^a-z0-9]+/iu)
    .filter((word) => word.length > 0);

  while (
    words.length > 0 &&
    GENERIC_ARTIFACT_LABEL_TOKENS.has(words.at(-1)?.toLowerCase() ?? "")
  ) {
    words.pop();
  }

  return words.join("-").toLowerCase();
}

/** Returns an absolute path inside the repository that owns the provided project path. */
export function getProjectAbsolutePath(filePath: string): string {
  return resolve(
    resolveRepositoryRootPath(filePath, moduleRepositoryRootPath),
    getProjectRelativePath(filePath),
  ).replace(/\\/gu, "/");
}

/** Returns a normalized project-relative path when the input points into the current repo. */
export function getProjectRelativePath(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/gu, "/");
  const repositoryRootPath = resolveRepositoryRootPath(
    filePath,
    moduleRepositoryRootPath,
  );
  const repositoryPrefix = `${repositoryRootPath}/`;

  if (normalizedPath === repositoryRootPath) {
    return "";
  }

  if (normalizedPath.startsWith(repositoryPrefix)) {
    return normalizedPath.slice(repositoryPrefix.length);
  }

  return normalizedPath.replace(/^\/+/, "");
}

/**
 * Returns a stable feature boundary derived from the current working tree
 * rather than literal top-level directory comparisons.
 */
export function getStructuralFeatureBoundary(
  filePath: string,
): StructuralFeatureBoundary {
  const pathSegments = splitProjectPathSegments(filePath);
  if (pathSegments.length === 0) {
    return { featureRoot: "root", pathSegments, rootArea: "root" };
  }

  const rootArea = getTopLevelAreaName(filePath);
  const featureRoot =
    pathSegments[0] && isBroadContainerRoot(pathSegments[0]) && pathSegments[1]
      ? pathSegments.slice(0, 2).join("/")
      : rootArea;

  return { featureRoot, pathSegments, rootArea };
}

/**
 * Returns a structural top-level area. Broad container roots collapse to their
 * first owned feature so callers compare real areas instead of source buckets.
 */
export function getTopLevelAreaName(filePath: string): string {
  const pathSegments = splitProjectPathSegments(filePath);
  if (pathSegments.length === 0) {
    return "root";
  }

  if (
    pathSegments[0] &&
    isBroadContainerRoot(pathSegments[0]) &&
    pathSegments[1]
  ) {
    return pathSegments[1];
  }

  return pathSegments[0] ?? "root";
}

/** Returns true when a top-level directory behaves like a broad container root. */
export function isBroadContainerRoot(rootName: string): boolean {
  return getAllContainerRootNames(moduleRepositoryRootPath).has(
    rootName.toLowerCase(),
  );
}

/** Returns true when a token carries ownership signal instead of path boilerplate. */
export function isMeaningfulPathWord(word: string): boolean {
  const normalizedWord = word.toLowerCase();
  return (
    normalizedWord.length >= 3 &&
    !GENERIC_PATH_WORDS.has(normalizedWord) &&
    !getAllContainerRootNames(moduleRepositoryRootPath).has(normalizedWord)
  );
}

/** Returns true when the path looks like support-only regression coverage. */
export function isSupportLikePath(filePath: string): boolean {
  const normalizedPath = getProjectRelativePath(filePath);
  const topLevelSegment = normalizedPath.split("/")[0]?.toLowerCase() ?? "";
  return (
    getAllSupportRootNames(moduleRepositoryRootPath).has(topLevelSegment) ||
    normalizedPath.includes("/__tests__/") ||
    /(?:^|\/)[^.]+\.(?:spec|test)\.[^.]+$/u.test(normalizedPath)
  );
}

/** Splits a repository path into normalized project-relative segments. */
export function splitProjectPathSegments(filePath: string): string[] {
  return getProjectRelativePath(filePath)
    .split("/")
    .filter((segment) => segment.length > 0);
}
