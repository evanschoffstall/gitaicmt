import { posix as pathPosix } from "node:path";

import { getProjectPathAliases, getVirtualPathAliases } from "./aliases.js";

export interface FilePathResolver {
  exactPaths: Map<string, string>;
  uniquePathsByBasename: Map<string, string>;
  uniquePathsByStem: Map<string, string>;
}

interface AliasRegistry {
  ambiguousBasenames: Set<string>;
  ambiguousStems: Set<string>;
  canonicalByBasename: Map<string, string>;
  canonicalByStem: Map<string, string>;
  exactPaths: Map<string, string>;
}

type FileDiff = import("../../git/diff.js").FileDiff;

export function buildFilePathResolver(
  fileByPath: Map<string, FileDiff>,
): FilePathResolver {
  const files = [...fileByPath.values()];
  const aliasRegistry: AliasRegistry = {
    ambiguousBasenames: new Set<string>(),
    ambiguousStems: new Set<string>(),
    canonicalByBasename: new Map<string, string>(),
    canonicalByStem: new Map<string, string>(),
    exactPaths: new Map<string, string>(),
  };

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const canonicalPath = file.path;
    const alias = `F${String(index + 1)}`;

    aliasRegistry.exactPaths.set(canonicalPath, canonicalPath);
    aliasRegistry.exactPaths.set(alias, canonicalPath);
    aliasRegistry.exactPaths.set(`${alias}: ${canonicalPath}`, canonicalPath);
    registerPathAliases(aliasRegistry, canonicalPath, canonicalPath);

    if (file.oldPath && !aliasRegistry.exactPaths.has(file.oldPath)) {
      aliasRegistry.exactPaths.set(file.oldPath, canonicalPath);
      aliasRegistry.exactPaths.set(`${alias}: ${file.oldPath}`, canonicalPath);
      registerPathAliases(aliasRegistry, file.oldPath, canonicalPath);
    }

    registerBasenameCandidate(
      aliasRegistry.canonicalByBasename,
      aliasRegistry.ambiguousBasenames,
      canonicalPath,
    );
    if (file.oldPath) {
      registerBasenameCandidate(
        aliasRegistry.canonicalByBasename,
        aliasRegistry.ambiguousBasenames,
        file.oldPath,
      );
    }

    registerStemCandidate(
      aliasRegistry.canonicalByStem,
      aliasRegistry.ambiguousStems,
      canonicalPath,
    );
    if (file.oldPath) {
      registerStemCandidate(
        aliasRegistry.canonicalByStem,
        aliasRegistry.ambiguousStems,
        file.oldPath,
      );
    }
  }

  return {
    exactPaths: aliasRegistry.exactPaths,
    uniquePathsByBasename: new Map(
      [...aliasRegistry.canonicalByBasename].filter(
        ([basename]) => !aliasRegistry.ambiguousBasenames.has(basename),
      ),
    ),
    uniquePathsByStem: new Map(
      [...aliasRegistry.canonicalByStem].filter(
        ([stem]) => !aliasRegistry.ambiguousStems.has(stem),
      ),
    ),
  };
}

export function resolveKnownPath(
  rawPath: string,
  pathResolver: FilePathResolver,
): null | string {
  const trimmedPath = rawPath.trim();
  if (trimmedPath.length === 0) {
    return null;
  }

  const direct = pathResolver.exactPaths.get(trimmedPath);
  if (direct) {
    return direct;
  }

  const aliasPrefixedPath = /^F\d+:\s+/u.exec(trimmedPath);
  if (aliasPrefixedPath) {
    return (
      resolveStemMatchedPath(
        trimmedPath.slice(aliasPrefixedPath[0].length),
        pathResolver,
      ) ?? null
    );
  }

  return (
    resolveStemMatchedPath(trimmedPath, pathResolver) ??
    resolveCompatibleBasenamePath(trimmedPath, pathResolver)
  );
}

function getBasename(path: string): string {
  return pathPosix.basename(path);
}

function getDirectorySegments(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, -1);
}

function getExtensionlessStem(path: string): null | string {
  const extension = pathPosix.extname(path);
  if (extension.length === 0) {
    return null;
  }

  return path.slice(0, -extension.length);
}

function hasCompatibleDirectoryShape(
  candidatePath: string,
  canonicalPath: string,
): boolean {
  const candidateDirectories = getDirectorySegments(candidatePath);
  const canonicalDirectories = getDirectorySegments(canonicalPath);

  let canonicalIndex = 0;
  for (const segment of candidateDirectories) {
    while (
      canonicalIndex < canonicalDirectories.length &&
      canonicalDirectories[canonicalIndex] !== segment
    ) {
      canonicalIndex++;
    }

    if (canonicalIndex >= canonicalDirectories.length) {
      return false;
    }

    canonicalIndex++;
  }

  return true;
}

function registerBasenameCandidate(
  canonicalByBasename: Map<string, string>,
  ambiguousBasenames: Set<string>,
  path: string,
): void {
  const basename = getBasename(path);
  if (basename.length === 0 || ambiguousBasenames.has(basename)) {
    return;
  }

  const existingCanonicalPath = canonicalByBasename.get(basename);
  if (existingCanonicalPath && existingCanonicalPath !== path) {
    canonicalByBasename.delete(basename);
    ambiguousBasenames.add(basename);
    return;
  }

  canonicalByBasename.set(basename, path);
}

function registerPathAliases(
  aliasRegistry: AliasRegistry,
  aliasSeedPath: string,
  canonicalPath: string,
): void {
  const aliasCandidates = new Set<string>(getProjectPathAliases(aliasSeedPath));

  for (const projectAlias of getProjectPathAliases(aliasSeedPath)) {
    for (const virtualAlias of getVirtualPathAliases(projectAlias)) {
      aliasCandidates.add(virtualAlias);
    }
  }

  for (const aliasPath of aliasCandidates) {
    if (!aliasRegistry.exactPaths.has(aliasPath)) {
      aliasRegistry.exactPaths.set(aliasPath, canonicalPath);
    }

    registerBasenameCandidate(
      aliasRegistry.canonicalByBasename,
      aliasRegistry.ambiguousBasenames,
      aliasPath,
    );
    registerStemCandidate(
      aliasRegistry.canonicalByStem,
      aliasRegistry.ambiguousStems,
      aliasPath,
    );
  }
}

function registerStemCandidate(
  canonicalByStem: Map<string, string>,
  ambiguousStems: Set<string>,
  path: string,
): void {
  const stem = getExtensionlessStem(path);
  if (!stem || ambiguousStems.has(stem)) {
    return;
  }

  const existingCanonicalPath = canonicalByStem.get(stem);
  if (existingCanonicalPath && existingCanonicalPath !== path) {
    canonicalByStem.delete(stem);
    ambiguousStems.add(stem);
    return;
  }

  canonicalByStem.set(stem, path);
}

function resolveCompatibleBasenamePath(
  candidatePath: string,
  pathResolver: FilePathResolver,
): null | string {
  const canonicalPath = pathResolver.uniquePathsByBasename.get(
    getBasename(candidatePath),
  );
  if (!canonicalPath) {
    return null;
  }

  return hasCompatibleDirectoryShape(candidatePath, canonicalPath)
    ? canonicalPath
    : null;
}

function resolveStemMatchedPath(
  candidatePath: string,
  pathResolver: FilePathResolver,
): null | string {
  const stem = getExtensionlessStem(candidatePath);
  if (!stem) {
    return null;
  }

  return pathResolver.uniquePathsByStem.get(stem) ?? null;
}
