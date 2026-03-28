/** Pure JSON value renderer for verbose trace mode. */

/**
 * Renders an unknown JSON value as a compact or expanded string, respecting
 * the available column width at the current nesting depth.
 */
export function formatJsonTraceValue(value: unknown, maxWidth: number): string {
  return formatJsonTraceNode(value, 0, maxWidth);
}

/** Prepends every line of a multi-line string with the given indent. */
export function indentTraceBlock(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/** Returns the remaining column budget at the given nesting depth. */
export function remainingTraceWidth(depth: number, maxWidth: number): number {
  return Math.max(24, maxWidth - depth * 2);
}

/** Returns the indentation string for the given nesting depth. */
export function traceIndent(depth: number): string {
  return "  ".repeat(depth);
}

function formatJsonTraceArray(
  value: unknown[],
  depth: number,
  maxWidth: number,
): string {
  const compactItems = value.map((item) =>
    formatJsonTraceNode(item, depth + 1, maxWidth),
  );
  const compact = `[${compactItems.join(", ")}]`;
  if (
    compact.length <= remainingTraceWidth(depth, maxWidth) &&
    compactItems.every((item) => !item.includes("\n"))
  ) {
    return compact;
  }

  const indent = traceIndent(depth);
  const childIndent = traceIndent(depth + 1);
  const expandedItems = value.map((item) =>
    indentTraceBlock(
      formatJsonTraceNode(item, depth + 1, maxWidth),
      childIndent,
    ),
  );

  return ["[", expandedItems.join(",\n"), `${indent}]`].join("\n");
}

function formatJsonTraceNode(
  value: unknown,
  depth: number,
  maxWidth: number,
): string {
  if (Array.isArray(value)) {
    return formatJsonTraceArray(value, depth, maxWidth);
  }

  if (value !== null && typeof value === "object") {
    return formatJsonTraceObject(
      value as Record<string, unknown>,
      depth,
      maxWidth,
    );
  }

  return JSON.stringify(value);
}

function formatJsonTraceObject(
  value: Record<string, unknown>,
  depth: number,
  maxWidth: number,
): string {
  const compactFileReference = formatTraceFileReference(value, depth, maxWidth);
  if (compactFileReference) {
    return compactFileReference;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}";
  }

  const compactEntries = entries.map(
    ([key, entryValue]) =>
      `${JSON.stringify(key)}: ${formatJsonTraceNode(entryValue, depth + 1, maxWidth)}`,
  );
  const compact = `{ ${compactEntries.join(", ")} }`;
  if (
    compact.length <= remainingTraceWidth(depth, maxWidth) &&
    compactEntries.every((entry) => !entry.includes("\n"))
  ) {
    return compact;
  }

  const indent = traceIndent(depth);
  const childIndent = traceIndent(depth + 1);
  const expandedEntries = entries.map(([key, entryValue]) => {
    const formattedValue = formatJsonTraceNode(entryValue, depth + 1, maxWidth);
    if (!formattedValue.includes("\n")) {
      return `${childIndent}${JSON.stringify(key)}: ${formattedValue}`;
    }

    const [firstLine, ...remainingLines] = formattedValue.split("\n");
    return [
      `${childIndent}${JSON.stringify(key)}: ${firstLine}`,
      ...remainingLines.map((line) => `${childIndent}${line}`),
    ].join("\n");
  });

  return ["{", expandedEntries.join(",\n"), `${indent}}`].join("\n");
}

/**
 * Returns a compact one-line representation when the object is a plain file
 * reference (`{ path }` or `{ path, hunks }`), otherwise returns null.
 */
function formatTraceFileReference(
  value: Record<string, unknown>,
  depth: number,
  maxWidth: number,
): null | string {
  const keys = Object.keys(value).sort();
  if (keys.length === 1 && typeof value.path === "string") {
    const compactPathReference = `{ "path": ${JSON.stringify(value.path)} }`;
    if (compactPathReference.length <= remainingTraceWidth(depth, maxWidth)) {
      return compactPathReference;
    }

    return [
      "{",
      `  "path": ${JSON.stringify(value.path)}`,
      "}",
    ].join("\n");
  }

  if (
    keys.length === 2 &&
    typeof value.path === "string" &&
    Array.isArray(value.hunks) &&
    value.hunks.every((hunk) => typeof hunk === "number")
  ) {
    const compactFileReference = `{ "path": ${JSON.stringify(value.path)}, "hunks": [${value.hunks.join(", ")}] }`;
    if (compactFileReference.length <= remainingTraceWidth(depth, maxWidth)) {
      return compactFileReference;
    }

    const hunksValue = `[${value.hunks.join(", ")}]`;
    return [
      "{",
      `  "path": ${JSON.stringify(value.path)},`,
      `  "hunks": ${hunksValue}`,
      "}",
    ].join("\n");
  }

  return null;
}
