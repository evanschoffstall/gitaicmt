import { type FileChangeSignals, type FileDiff } from "./grouping-types.js";
import {
  buildChangedPathAliases,
  collectFileSignalLines,
  extractIntentWords,
  extractModuleSpecifiers,
  extractPathWords,
  extractProvidedSymbols,
  extractReferencedSymbols,
  isCoordinatorLikeFile,
  resolveChangedModulePath,
} from "./signal-support.js";

/** Builds file-level semantic signals for dependency ordering and merge gating. */
export function buildFileChangeSignals(
  allFiles: FileDiff[],
): Map<string, FileChangeSignals> {
  const changedPaths = new Set(allFiles.map((file) => file.path));
  const changedPathAliases = buildChangedPathAliases(changedPaths);
  const fileSignals = new Map<string, FileChangeSignals>();

  for (const file of allFiles) {
    fileSignals.set(
      file.path,
      buildSingleFileChangeSignals(file, changedPathAliases),
    );
  }

  return fileSignals;
}

function buildSingleFileChangeSignals(
  file: FileDiff,
  changedPathAliases: Map<string, string[]>,
): FileChangeSignals {
  const importedPaths = new Set<string>();
  const pathWords = extractPathWords(file.path);
  const providedSymbols = new Set<string>();
  const referencedSymbols = new Set<string>();

  for (const sourceLine of collectFileSignalLines(file)) {
    collectChangedFileLineSignals(
      sourceLine,
      file.path,
      changedPathAliases,
      importedPaths,
      providedSymbols,
      referencedSymbols,
    );
  }

  return {
    importedPaths,
    intentWords: extractIntentWords(file.path, file.hunks),
    isCoordinatorLike: isCoordinatorLikeFile(
      importedPaths,
      pathWords,
      providedSymbols,
    ),
    pathWords,
    providedSymbols,
    referencedSymbols,
  };
}

function collectChangedFileLineSignals(
  sourceLine: string,
  importerPath: string,
  changedPathAliases: Map<string, string[]>,
  importedPaths: Set<string>,
  providedSymbols: Set<string>,
  referencedSymbols: Set<string>,
): void {
  for (const modulePath of extractModuleSpecifiers(sourceLine)) {
    if (!modulePath.startsWith(".")) {
      continue;
    }

    const resolvedPath = resolveChangedModulePath(
      importerPath,
      modulePath,
      changedPathAliases,
    );
    if (resolvedPath) {
      importedPaths.add(resolvedPath);
    }
  }

  for (const symbol of extractReferencedSymbols(sourceLine)) {
    referencedSymbols.add(symbol);
  }
  for (const symbol of extractProvidedSymbols(sourceLine)) {
    providedSymbols.add(symbol);
  }
}
