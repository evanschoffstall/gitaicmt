import type { AiOutputEvent } from "./ai.js";

const ANSI_BOLD = "\x1b[1m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

export interface VerboseOutputOptions {
  maxWidth?: number;
  mode?: "summary" | "trace";
  sequence?: number;
}

interface VerboseCommitFile {
  hunks?: number[];
  path: string;
}

interface VerboseCommitPlanItem {
  files: VerboseCommitFile[];
  message: string;
}

/**
 * Format AI stage output into terminal-friendly lines instead of raw JSON.
 */
export function formatVerboseAiOutputLines(
  event: AiOutputEvent,
  options?: VerboseOutputOptions,
): string[] {
  const maxWidth = Math.max(60, options?.maxWidth ?? 100);
  const mode = options?.mode ?? "summary";
  const parsed = parseJson(event.content);
  const sequence = options?.sequence;

  if (mode === "trace") {
    return formatTraceBlock(event, parsed, maxWidth, sequence);
  }

  if (isCommitPlan(parsed)) {
    return formatCommitPlanBlock(event.stage, parsed, maxWidth, sequence);
  }

  return formatGenericBlock(
    buildStageTitle(event.stage, sequence),
    normalizeGenericContent(event.content, parsed),
    maxWidth,
  );
}

function buildStageTitle(
  stage: AiOutputEvent["stage"],
  sequence?: number,
): string {
  const baseTitle = describeStage(stage);
  return sequence === undefined
    ? baseTitle
    : `${baseTitle} #${String(sequence)}`;
}

function collectBodyBullets(message: string): string[] {
  const lines = message
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const bullets: string[] = [];

  for (const line of lines) {
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
      continue;
    }

    const previous = bullets.pop();
    if (previous) {
      bullets.push(`${previous} ${line}`);
      continue;
    }

    bullets.push(line);
  }

  return bullets;
}

function describeStage(stage: AiOutputEvent["stage"]): string {
  switch (stage) {
    case "cluster": {
      return "Merge review";
    }
    case "consolidate": {
      return "Final consolidation";
    }
    case "generate": {
      return "Message draft";
    }
    case "group": {
      return "Grouping batch";
    }
    case "merge": {
      return "Message merge";
    }
    default: {
      return "AI output";
    }
  }
}

function formatCommitFiles(files: VerboseCommitFile[]): string {
  return files
    .map((file) => {
      if (!file.hunks || file.hunks.length === 0) {
        return file.path;
      }

      if (file.hunks.length <= 3) {
        return `${file.path} [${file.hunks.join(", ")}]`;
      }

      return `${file.path} [${String(file.hunks.length)} hunks]`;
    })
    .join(", ");
}

function formatCommitPlanBlock(
  stage: AiOutputEvent["stage"],
  commits: VerboseCommitPlanItem[],
  maxWidth: number,
  sequence?: number,
): string[] {
  const commitLabel =
    commits.length === 1 ? "candidate commit" : "candidate commits";
  const lines = [
    styleTraceHeader(
      `╭── ${buildStageTitle(stage, sequence)} · ${String(commits.length)} ${commitLabel}`,
    ),
  ];

  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index];
    const subject =
      commit.message.split("\n")[0]?.trim() ?? "(missing subject)";
    lines.push(
      ...wrapLine(
        `${String(index + 1)}. ${subject}`,
        maxWidth - 2,
        "│ ",
        "│    ",
      ).map(styleTraceRail),
      ...wrapLine(
        `coverage: ${String(commit.files.length)} file(s) · ${formatCommitFiles(commit.files)}`,
        maxWidth - 4,
        "│   ",
        "│         ",
      ).map(styleTraceRail),
    );

    const bullets = collectBodyBullets(commit.message);
    const previewBullets = bullets.slice(0, 2);
    for (const bullet of previewBullets) {
      lines.push(
        ...wrapLine(bullet, maxWidth - 6, "│   - ", "│     ").map(
          styleTraceRail,
        ),
      );
    }
    if (bullets.length > previewBullets.length) {
      lines.push(
        styleTraceRail(
          `│   - ... ${String(bullets.length - previewBullets.length)} more detail line(s)`,
        ),
      );
    }

    if (index < commits.length - 1) {
      lines.push(styleTraceRail("│"));
    }
  }

  lines.push(styleTraceFooter("╰──"));
  return lines;
}

function formatGenericBlock(
  title: string,
  content: string,
  maxWidth: number,
): string[] {
  const trimmedContent = content.trim();
  const lines = [styleTraceHeader(`╭── ${title}`)];

  if (trimmedContent.length === 0) {
    lines.push(styleTraceRail("│ (empty)"), styleTraceFooter("╰──"));
    return lines;
  }

  for (const rawLine of trimmedContent.split("\n")) {
    lines.push(...wrapLine(rawLine, maxWidth - 2, "│ ", "│ ").map(styleTraceRail));
  }

  lines.push(styleTraceFooter("╰──"));
  return lines;
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
  const compactFileReference = formatTraceFileReference(value);
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

function formatJsonTraceValue(value: unknown, maxWidth: number): string {
  return formatJsonTraceNode(value, 0, maxWidth);
}

function formatTraceBlock(
  event: AiOutputEvent,
  parsed: unknown,
  maxWidth: number,
  sequence?: number,
): string[] {
  const title = `${buildStageTitle(event.stage, sequence)} trace`;
  const rawContent = event.content.trimEnd();
  const lines = [styleTraceHeader(`╭── ${title}`)];

  if (rawContent.length === 0) {
    lines.push(styleTraceRail("│ (empty)"), styleTraceFooter("╰──"));
    return lines;
  }

  const traceContent =
    parsed === undefined
      ? rawContent
      : formatJsonTraceValue(parsed, maxWidth - 2);

  for (const rawLine of traceContent.split("\n")) {
    lines.push(...wrapTraceLine(rawLine, maxWidth));
  }

  lines.push(styleTraceFooter("╰──"));
  return lines;
}

function formatTraceFileReference(value: Record<string, unknown>): null | string {
  const keys = Object.keys(value).sort();
  if (keys.length === 1 && typeof value.path === "string") {
    return `{ "path": ${JSON.stringify(value.path)} }`;
  }

  if (
    keys.length === 2 &&
    typeof value.path === "string" &&
    Array.isArray(value.hunks) &&
    value.hunks.every((hunk) => typeof hunk === "number")
  ) {
    return `{ "path": ${JSON.stringify(value.path)}, "hunks": [${value.hunks.join(", ")}] }`;
  }

  return null;
}

function indentTraceBlock(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function isCommitPlan(value: unknown): value is VerboseCommitPlanItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "message" in item &&
        typeof item.message === "string" &&
        "files" in item &&
        Array.isArray(item.files) &&
        item.files.every(
          (file: unknown) =>
            typeof file === "object" &&
            file !== null &&
            "path" in file &&
            typeof file.path === "string" &&
            (!("hunks" in file) ||
              file.hunks === undefined ||
              (Array.isArray(file.hunks) &&
                file.hunks.every((hunk: unknown) => typeof hunk === "number"))),
        ),
    )
  );
}

function normalizeGenericContent(
  parsedText: string,
  parsedJson: unknown,
): string {
  if (parsedJson === undefined) {
    return parsedText.trim();
  }

  return JSON.stringify(parsedJson, null, 2);
}

function parseJson(content: string): unknown {
  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(trimmedContent) as unknown;
  } catch {
    return undefined;
  }
}

function remainingTraceWidth(depth: number, maxWidth: number): number {
  return Math.max(24, maxWidth - depth * 2);
}

function styleTraceFooter(line: string): string {
  return `${ANSI_DIM}${ANSI_CYAN}${line}${ANSI_RESET}`;
}

function styleTraceHeader(line: string): string {
  return `${ANSI_BOLD}${ANSI_CYAN}${line}${ANSI_RESET}`;
}

function styleTraceRail(line: string): string {
  if (!line.startsWith("│")) {
    return line;
  }

  return `${ANSI_CYAN}│${ANSI_RESET}${line.slice(1)}`;
}

function traceIndent(depth: number): string {
  return "  ".repeat(depth);
}

function wrapLine(
  text: string,
  maxWidth: number,
  firstPrefix: string,
  continuationPrefix: string,
): string[] {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return [firstPrefix.trimEnd()];
  }

  const words = trimmedText.split(/\s+/u);
  const lines: string[] = [];
  let currentLine = "";
  let prefix = firstPrefix;

  for (const word of words) {
    const candidate =
      currentLine.length === 0 ? word : `${currentLine} ${word}`;
    if (candidate.length <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine.length > 0) {
      lines.push(`${prefix}${currentLine}`);
      prefix = continuationPrefix;
      currentLine = word;
      continue;
    }

    lines.push(`${prefix}${word}`);
    prefix = continuationPrefix;
  }

  if (currentLine.length > 0) {
    lines.push(`${prefix}${currentLine}`);
  }

  return lines;
}

function wrapTraceLine(text: string, maxWidth: number): string[] {
  const valuePrefixMatch = /^(\s*"[^"]+":\s+)(.*)$/u.exec(text);
  if (valuePrefixMatch) {
    const [, firstContentPrefix, valueText] = valuePrefixMatch;
    const continuationContentPrefix = " ".repeat(firstContentPrefix.length);
    return wrapLine(
      valueText,
      Math.max(12, maxWidth - firstContentPrefix.length - 2),
      `│ ${firstContentPrefix}`,
      `│ ${continuationContentPrefix}`,
    ).map(styleTraceRail);
  }

  const indentMatch = /^(\s*)(.*)$/u.exec(text);
  const firstContentPrefix = indentMatch?.[1] ?? "";
  const content = indentMatch?.[2] ?? text;

  return wrapLine(
    content,
    Math.max(12, maxWidth - firstContentPrefix.length - 2),
    `│ ${firstContentPrefix}`,
    `│ ${firstContentPrefix}`,
  ).map(styleTraceRail);
}
