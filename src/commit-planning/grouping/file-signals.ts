import { readFileSync } from "node:fs";
import { posix as pathPosix } from "node:path";

import { sanitizeSubjectWords } from "../../commit-messages/subject-parser.js";
import { type FileChangeSignals, type FileDiff } from "./grouping-types.js";
import { filterSignificantWords } from "./subject-analysis.js";

/** Builds file-level semantic signals for dependency ordering and merge gating. */
export function buildFileChangeSignals(
  allFiles: FileDiff[],
): Map<string, FileChangeSignals> {
  const changedPaths = new Set(allFiles.map((file) => file.path));
  const changedPathAliases = buildChangedPathAliases(changedPaths);
  const fileSignals = new Map<string, FileChangeSignals>();

  for (const file of allFiles) {
    const importedPaths = new Set<string>();
    const pathWords = extractPathWords(file.path);
    const providedSymbols = new Set<string>();
    const referencedSymbols = new Set<string>();

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("---") || line.startsWith("-")) {
          continue;
        }

        const sourceLine =
          line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : line;
        collectChangedFileLineSignals(
          sourceLine,
          file.path,
          changedPathAliases,
          importedPaths,
          providedSymbols,
          referencedSymbols,
        );
      }
    }

    for (const sourceLine of readCurrentFileSignalLines(file.path)) {
      collectChangedFileLineSignals(
        sourceLine,
        file.path,
        changedPathAliases,
        importedPaths,
        providedSymbols,
        referencedSymbols,
      );
    }

    fileSignals.set(file.path, {
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
    });
  }

  return fileSignals;
}

function addChangedPathAlias(
  aliases: Map<string, string[]>,
  alias: string,
  changedPath: string,
): void {
  const existing = aliases.get(alias);
  if (!existing) {
    aliases.set(alias, [changedPath]);
    return;
  }

  if (!existing.includes(changedPath)) {
    existing.push(changedPath);
  }
}

/**
 * Build lookup aliases from actual changed paths so dependency tracking can
 * resolve exact module paths and extensionless stems without fixed rules.
 */
function buildChangedPathAliases(
  changedPaths: Iterable<string>,
): Map<string, string[]> {
  const aliases = new Map<string, string[]>();

  for (const changedPath of changedPaths) {
    const normalizedPath = pathPosix.normalize(changedPath);
    addChangedPathAlias(aliases, normalizedPath, changedPath);

    const stemPath = stripPathExtension(normalizedPath);
    if (stemPath !== normalizedPath) {
      addChangedPathAlias(aliases, stemPath, changedPath);
    }
  }

  return aliases;
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

function extractIntentWords(
  path: string,
  hunks: FileDiff["hunks"],
): Set<string> {
  const intentWords = new Set<string>();

  for (const word of extractPathWords(path)) {
    intentWords.add(word);
  }

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("---") || line.startsWith("-")) {
        continue;
      }

      const sourceLine =
        line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : line;
      for (const word of filterSignificantWords(sanitizeSubjectWords(sourceLine), 4)) {
        intentWords.add(word);
      }
    }
  }

  return intentWords;
}

/** Collect relative module-like path tokens without assuming a file type. */
function extractModuleSpecifiers(line: string): Set<string> {
  const specifiers = new Set<string>();
  const matches = line.matchAll(
    new RegExp(
      "(^|[^A-Za-z0-9_./-])(\\.{1,2}\\/[^\\s\"'`(){};,\\]]+)(?=$|[^A-Za-z0-9_./-])",
      "gu",
    ),
  );

  for (const match of matches) {
    const specifier = match[2];
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  return specifiers;
}

function extractPathWords(path: string): Set<string> {
  const baseName = pathPosix.basename(path).replace(/\.[^.]+$/u, "");
  return new Set(filterSignificantWords(sanitizeSubjectWords(baseName)));
}

function extractProvidedSymbols(line: string): Set<string> {
  const provided = new Set<string>();
  const tokens = line.split(/[^A-Za-z0-9_$]+/u).filter(Boolean);

  if (tokens[0] !== "export") {
    return provided;
  }

  const declarationIndex = tokens[1] === "async" ? 2 : 1;
  const declarationType = tokens[declarationIndex];
  const symbol = tokens[declarationIndex + 1];

  if (
    declarationType &&
    symbol &&
    [
      "class",
      "const",
      "enum",
      "function",
      "interface",
      "let",
      "type",
      "var",
    ].includes(declarationType) &&
    isSignalIdentifier(symbol)
  ) {
    provided.add(symbol);
  }

  return provided;
}

function extractReferencedSymbols(line: string): Set<string> {
  const referenced = new Set<string>();
  const tokens = line.split(/[^A-Za-z0-9_$]+/u);

  for (const symbol of tokens) {
    if (symbol && isSignalIdentifier(symbol)) {
      referenced.add(symbol);
    }
  }

  return referenced;
}

function isCoordinatorLikeFile(
  importedPaths: Set<string>,
  pathWords: Set<string>,
  providedSymbols: Set<string>,
): boolean {
  return (
    importedPaths.size >= 2 && pathWords.size <= 1 && providedSymbols.size <= 1
  );
}

function isSignalIdentifier(symbol: string): boolean {
  return symbol.length >= 5 && /[A-Z]/u.test(symbol);
}

/**
 * Dependency ordering must inspect the current file contents even when the
 * import line sits outside the edited hunk selection.
 */
function readCurrentFileSignalLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/u);
  } catch {
    return [];
  }
}

/**
 * Resolve a relative module reference against changed-file aliases so planner
 * dependencies follow the actual diff instead of a hardcoded extension list.
 */
function resolveChangedModulePath(
  importerPath: string,
  modulePath: string,
  changedPathAliases: Map<string, string[]>,
): null | string {
  const resolvedPath = pathPosix.normalize(
    pathPosix.join(pathPosix.dirname(importerPath), modulePath),
  );
  const lookupAliases = [resolvedPath, stripPathExtension(resolvedPath)];
  const seenPaths = new Set<string>();

  for (const alias of lookupAliases) {
    const candidates = changedPathAliases.get(alias);
    if (!candidates) {
      continue;
    }

    for (const candidate of candidates) {
      if (seenPaths.has(candidate)) {
        continue;
      }

      seenPaths.add(candidate);
      return candidate;
    }
  }

  return null;
}

function stripPathExtension(path: string): string {
  const extension = pathPosix.extname(path);
  if (extension === "") {
    return path;
  }

  return path.slice(0, -extension.length);
}