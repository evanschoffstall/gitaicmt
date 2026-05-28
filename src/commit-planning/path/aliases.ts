import { readdirSync } from "node:fs";

import {
  getContainerFeatureFileInfo,
  getProjectAbsolutePath,
  getProjectRelativePath,
  getStructuralFeatureBoundary,
  splitProjectPathSegments,
} from "./structure.js";

interface FlatFeatureFileInfo {
  containerRoot: string;
  extension: string;
  featureName: string;
  featureRoot: string;
  fileName: string;
  stem: string;
}

const featureBarrelStemCache = new Map<string, string[]>();

/**
 * Returns the flat feature-file shape for paths like src/<feature>/<file>.ts.
 */
export function getFlatFeatureFileInfo(
  filePath: string,
): FlatFeatureFileInfo | null {
  const containerFeatureFileInfo = getContainerFeatureFileInfo(filePath);
  if (!containerFeatureFileInfo) {
    return null;
  }

  const fileName = containerFeatureFileInfo.fileName;
  if (!fileName.includes(".")) {
    return null;
  }

  const extensionMatch = /\.[^.]+$/u.exec(fileName);
  if (!extensionMatch) {
    return null;
  }

  return {
    containerRoot: containerFeatureFileInfo.containerRoot,
    extension: extensionMatch[0],
    featureName: containerFeatureFileInfo.featureName,
    featureRoot: containerFeatureFileInfo.featureRoot,
    fileName,
    stem: fileName.slice(0, -extensionMatch[0].length),
  };
}

/**
 * Infers the top-level nested subtree owner encoded in a flattened file name.
 */
export function getFlattenedSubtreeOwnerId(filePath: string): null | string {
  const flatFileInfo = getFlatFeatureFileInfo(filePath);
  if (!flatFileInfo || flatFileInfo.stem === "index") {
    return null;
  }

  const prefixChain = getFeaturePrefixChain(flatFileInfo);
  const topLevelPrefix = prefixChain[0];
  return topLevelPrefix
    ? `${flatFileInfo.featureRoot}/${topLevelPrefix}`
    : null;
}

/**
 * Returns both workspace-relative and absolute aliases for repository paths.
 */
export function getProjectPathAliases(filePath: string): string[] {
  const aliases = new Set<string>([filePath]);
  const normalizedPath = filePath.replace(/\\/gu, "/");
  const projectRelativePath = getProjectRelativePath(normalizedPath);
  aliases.add(normalizedPath);
  if (projectRelativePath.length > 0) {
    aliases.add(projectRelativePath);
  }

  if (!normalizedPath.startsWith("/")) {
    aliases.add(getProjectAbsolutePath(projectRelativePath));
  }

  return [...aliases];
}

/**
 * Reconstructs the old nested path shape represented by a flattened file name.
 */
export function getVirtualNestedPath(filePath: string): null | string {
  const flatFileInfo = getFlatFeatureFileInfo(filePath);
  if (!flatFileInfo || flatFileInfo.stem === "index") {
    return null;
  }

  const prefixChain = getFeaturePrefixChain(flatFileInfo);
  if (prefixChain.length === 0) {
    return null;
  }

  const directorySegments: string[] = [];
  let consumedTokenCount = 0;
  for (const prefix of prefixChain) {
    const prefixTokens = prefix.split("-");
    const addedTokens = prefixTokens.slice(consumedTokenCount);
    if (addedTokens.length === 0) {
      continue;
    }

    directorySegments.push(addedTokens.join("-"));
    consumedTokenCount = prefixTokens.length;
  }

  const stemTokens = flatFileInfo.stem.split("-");
  const remainderTokens = stemTokens.slice(consumedTokenCount);
  const nestedFileName =
    remainderTokens.length === 0
      ? `index${flatFileInfo.extension}`
      : `${remainderTokens.join("-")}${flatFileInfo.extension}`;

  return [flatFileInfo.featureRoot, ...directorySegments, nestedFileName].join(
    "/",
  );
}

/**
 * Returns virtual aliases for full nested paths and planner paths that drop
 * intermediate directories inside a subtree.
 */
export function getVirtualPathAliases(filePath: string): string[] {
  const nestedPath =
    getNestedFeatureFilePath(filePath) ?? getVirtualNestedPath(filePath);
  if (!nestedPath) {
    return [];
  }

  const aliases = new Set<string>([nestedPath]);
  const pathSegments = splitProjectPathSegments(nestedPath);
  const { featureRoot } = getStructuralFeatureBoundary(nestedPath);
  const featureDepth =
    featureRoot === "root" ? 0 : featureRoot.split("/").length;
  const subtreeSegments = pathSegments.slice(featureDepth, -1);
  const fileName = pathSegments.at(-1);

  if (fileName && subtreeSegments.length > 0 && featureDepth > 0) {
    aliases.add(
      [...featureRoot.split("/"), subtreeSegments[0], fileName].join("/"),
    );
  }

  return [...aliases];
}

function getFeatureBarrelStems(featureRoot: string): string[] {
  const cachedBarrelStems = featureBarrelStemCache.get(featureRoot);
  if (cachedBarrelStems) {
    return cachedBarrelStems;
  }

  const featureDirectoryPath = getProjectAbsolutePath(featureRoot);
  try {
    const fileStems = readdirSync(featureDirectoryPath, { withFileTypes: true })
      .filter((directoryEntry) => directoryEntry.isFile())
      .map((directoryEntry) => directoryEntry.name)
      .filter((fileName) => /\.[cm]?ts$/u.test(fileName))
      .map((fileName) => fileName.replace(/\.[^.]+$/u, ""))
      .filter((stem) => stem !== "index")
      .sort((left, right) => left.split("-").length - right.split("-").length);

    const barrelStems = fileStems.filter((stem) =>
      fileStems.some((candidateStem) => candidateStem.startsWith(`${stem}-`)),
    );

    featureBarrelStemCache.set(featureRoot, barrelStems);
    return barrelStems;
  } catch {
    featureBarrelStemCache.set(featureRoot, []);
    return [];
  }
}

function getFeaturePrefixChain(flatFileInfo: FlatFeatureFileInfo): string[] {
  const barrelStems = getFeatureBarrelStems(flatFileInfo.featureRoot);
  return barrelStems.filter(
    (barrelStem) =>
      flatFileInfo.stem === barrelStem ||
      flatFileInfo.stem.startsWith(`${barrelStem}-`),
  );
}

function getNestedFeatureFilePath(filePath: string): null | string {
  const normalizedPath = getProjectRelativePath(filePath);
  const { featureRoot } = getStructuralFeatureBoundary(normalizedPath);
  const featureDepth =
    featureRoot === "root" ? 0 : featureRoot.split("/").length;
  return splitProjectPathSegments(normalizedPath).length > featureDepth + 1
    ? normalizedPath
    : null;
}
