import { readFileSync } from "node:fs";
import { posix as pathPosix } from "node:path";

import { sanitizeSubjectWords } from "../../../commit-messages/subject-parser.js";
import {
  getProjectPathAliases,
  getVirtualPathAliases,
} from "../../path/index.js";
import { filterSignificantWords } from "../subject/analysis.js";

type FileDiff = import("../grouping-types.js").FileDiff;

export function buildChangedPathAliases(
  changedPaths: Iterable<string>,
): Map<string, string[]> {
  const aliases = new Map<string, string[]>();

  for (const changedPath of changedPaths) {
    const normalizedPath = pathPosix.normalize(changedPath);
    const aliasCandidates = new Set<string>(
      getProjectPathAliases(normalizedPath),
    );
    for (const projectAlias of [...aliasCandidates]) {
      for (const virtualAlias of getVirtualPathAliases(projectAlias)) {
        aliasCandidates.add(virtualAlias);
      }
    }

    for (const aliasPath of aliasCandidates) {
      addChangedPathAlias(aliases, aliasPath, changedPath);

      const stemPath = stripPathExtension(aliasPath);
      if (stemPath !== aliasPath) {
        addChangedPathAlias(aliases, stemPath, changedPath);
      }
    }
  }

  return aliases;
}

export function collectFileSignalLines(file: FileDiff): string[] {
  const sourceLines: string[] = [];

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const sourceLine = normalizeSignalSourceLine(line);
      if (sourceLine !== null) {
        sourceLines.push(sourceLine);
      }
    }
  }

  sourceLines.push(...readCurrentFileSignalLines(file.path));
  return sourceLines;
}

export function extractIntentWords(
  path: string,
  hunks: FileDiff["hunks"],
): Set<string> {
  const intentWords = extractPathWords(path);

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const sourceLine = normalizeSignalSourceLine(line);
      if (sourceLine === null) {
        continue;
      }
      for (const word of filterSignificantWords(
        sanitizeSubjectWords(sourceLine),
        4,
      )) {
        intentWords.add(word);
      }
    }
  }

  return intentWords;
}

export function extractModuleSpecifiers(line: string): Set<string> {
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

export function extractPathWords(path: string): Set<string> {
  const baseName = pathPosix.basename(path).replace(/\.[^.]+$/u, "");
  return new Set(filterSignificantWords(sanitizeSubjectWords(baseName)));
}

export function extractProvidedSymbols(line: string): Set<string> {
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

export function extractReferencedSymbols(line: string): Set<string> {
  const referenced = new Set<string>();
  const tokens = line.split(/[^A-Za-z0-9_$]+/u);

  for (const symbol of tokens) {
    if (symbol && isSignalIdentifier(symbol)) {
      referenced.add(symbol);
    }
  }

  return referenced;
}

export function isCoordinatorLikeFile(
  importedPaths: Set<string>,
  pathWords: Set<string>,
  providedSymbols: Set<string>,
): boolean {
  return (
    importedPaths.size >= 2 && pathWords.size <= 1 && providedSymbols.size <= 1
  );
}

export function resolveChangedModulePath(
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

function isSignalIdentifier(symbol: string): boolean {
  return symbol.length >= 5 && /[A-Z]/u.test(symbol);
}

function normalizeSignalSourceLine(line: string): null | string {
  if (line.startsWith("---") || line.startsWith("-")) {
    return null;
  }

  return line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : line;
}

function readCurrentFileSignalLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/u);
  } catch {
    return [];
  }
}

function stripPathExtension(path: string): string {
  const extension = pathPosix.extname(path);
  if (extension === "") {
    return path;
  }

  return path.slice(0, -extension.length);
}
