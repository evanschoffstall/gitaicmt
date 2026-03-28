/**
 * File-alias helpers for AI output prompts and verbose rendering.
 * Extracts `F1 = path/to/file` legends from prompts and resolves leaked
 * alias placeholders back to canonical repository paths for display.
 */

export type AiOutputFileAliasMap = ReadonlyMap<string, string>;

/**
 * Reads the prompt's `File legend:` block and returns any `F<number> = path`
 * aliases defined there.
 */
export function extractAiOutputFileAliasMap(prompt: string): Map<string, string> {
  const promptLines = prompt.split(/\r?\n/u);
  const legendStartIndex = promptLines.findIndex(
    (line) => line.trim() === "File legend:",
  );

  if (legendStartIndex < 0) {
    return new Map<string, string>();
  }

  const fileAliasMap = new Map<string, string>();
  for (let index = legendStartIndex + 1; index < promptLines.length; index++) {
    const promptLine = promptLines[index]?.trim() ?? "";

    if (promptLine.length === 0) {
      if (fileAliasMap.size > 0) {
        break;
      }
      continue;
    }

    const aliasMatch = /^(F\d+)\s*=\s*(.+)$/u.exec(promptLine);
    if (!aliasMatch) {
      if (fileAliasMap.size > 0) {
        break;
      }
      continue;
    }

    const [, alias, canonicalPath] = aliasMatch;
    fileAliasMap.set(alias, canonicalPath.trim());
  }

  return fileAliasMap;
}

/**
 * Recursively rewrites JSON-like values so `path` fields render canonical file
 * paths even when the raw model payload leaked file aliases.
 */
export function normalizeAiOutputPaths<TValue>(
  value: TValue,
  fileAliasMap?: AiOutputFileAliasMap,
): TValue {
  return normalizeAiOutputValue(value, fileAliasMap) as TValue;
}

/**
 * Resolves one raw path-like value that may contain a leaked alias label.
 */
export function resolveAiOutputFilePath(
  rawPath: string,
  fileAliasMap: AiOutputFileAliasMap,
): string {
  const trimmedPath = rawPath.trim();
  if (trimmedPath.length === 0) {
    return rawPath;
  }

  const directMatch = fileAliasMap.get(trimmedPath);
  if (directMatch) {
    return directMatch;
  }

  const aliasPrefixMatch = /^(F\d+):\s*(.+)$/u.exec(trimmedPath);
  if (!aliasPrefixMatch) {
    return rawPath;
  }

  const [, alias, trailingPath] = aliasPrefixMatch;
  return fileAliasMap.get(alias) ?? trailingPath.trim();
}

function normalizeAiOutputValue(
  value: unknown,
  fileAliasMap?: AiOutputFileAliasMap,
): unknown {
  if (!fileAliasMap || fileAliasMap.size === 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeAiOutputValue(item, fileAliasMap));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedObject: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (key === "path" && typeof entryValue === "string") {
      normalizedObject[key] = resolveAiOutputFilePath(entryValue, fileAliasMap);
      continue;
    }

    normalizedObject[key] = normalizeAiOutputValue(entryValue, fileAliasMap);
  }

  return normalizedObject;
}