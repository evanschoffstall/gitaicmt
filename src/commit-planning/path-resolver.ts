import { posix as pathPosix } from "node:path";

export interface FilePathResolver {
  exactPaths: Map<string, string>;
  uniquePathsByStem: Map<string, string>;
}

type FileDiff = import("../git/diff.js").FileDiff;

export function buildFilePathResolver(
  fileByPath: Map<string, FileDiff>,
): FilePathResolver {
  const exactPaths = new Map<string, string>();
  const files = [...fileByPath.values()];
  const canonicalByStem = new Map<string, string>();
  const ambiguousStems = new Set<string>();

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const canonicalPath = file.path;
    const alias = `F${String(index + 1)}`;

    exactPaths.set(canonicalPath, canonicalPath);
    exactPaths.set(alias, canonicalPath);
    exactPaths.set(`${alias}: ${canonicalPath}`, canonicalPath);

    if (file.oldPath && !exactPaths.has(file.oldPath)) {
      exactPaths.set(file.oldPath, canonicalPath);
      exactPaths.set(`${alias}: ${file.oldPath}`, canonicalPath);
    }

    registerStemCandidate(canonicalByStem, ambiguousStems, canonicalPath);
    if (file.oldPath) {
      registerStemCandidate(canonicalByStem, ambiguousStems, file.oldPath);
    }
  }

  return {
    exactPaths,
    uniquePathsByStem: new Map(
      [...canonicalByStem].filter(([stem]) => !ambiguousStems.has(stem)),
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

  return resolveStemMatchedPath(trimmedPath, pathResolver);
}

function getExtensionlessStem(path: string): null | string {
  const extension = pathPosix.extname(path);
  if (extension.length === 0) {
    return null;
  }

  return path.slice(0, -extension.length);
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