import type { AiOutputEvent } from "../commit-planning/orchestration.js";

import { normalizeAiOutputPaths } from "../commit-planning/ai-file-paths.js";
import {
  buildEventTitle,
  formatEventStatLines,
  formatTraceBlock,
  getEventFrameSeverity,
  getEventSequenceKey,
  styleTraceFooter,
  styleTraceHeader,
  styleTraceRail,
  wrapLine,
} from "./verbose-rendering/block-render.js";

export interface VerboseOutputOptions {
  maxWidth?: number;
  mode?: "summary" | "trace";
  sequence?: number;
}

interface TraceWrapContext {
  continuationPrefix: string;
  firstPrefix: string;
  severity: ReturnType<typeof getEventFrameSeverity>;
  wrapOffset: number;
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
 * Formats AI stage output into terminal-friendly lines instead of raw JSON.
 * Dispatches to trace, commit-plan, or generic block renderers based on mode
 * and content shape.
 */
export function formatVerboseAiOutputLines(
  event: AiOutputEvent,
  options?: VerboseOutputOptions,
): string[] {
  const maxWidth = Math.max(24, options?.maxWidth ?? 100);
  const mode = options?.mode ?? "summary";
  const parsed = normalizeAiOutputPaths(
    parseJson(event.content),
    event.fileAliasMap,
  );
  const sequence = options?.sequence;

  if (mode === "trace") {
    if (event.stage === "consolidate" && isCommitPlan(parsed)) {
      return formatConsolidationTraceSummary(event, parsed, maxWidth, sequence);
    }

    return formatTraceBlock(event, parsed, maxWidth, sequence);
  }

  if (isCommitPlan(parsed)) {
    return formatCommitPlanBlock(event, parsed, maxWidth, sequence);
  }

  return formatGenericBlock(
    event,
    buildEventTitle(event, parsed, sequence),
    normalizeGenericContent(event.content, parsed),
    maxWidth,
  );
}

/**
 * Returns the counter bucket for one verbose event based on the rendered event
 * family instead of the coarse pipeline stage.
 */
export function getVerboseAiOutputSequenceKey(event: AiOutputEvent): string {
  return getEventSequenceKey(event, parseJson(event.content));
}

function buildCommitSubjectPreviewLines(
  commit: VerboseCommitPlanItem,
  index: number,
  maxWidth: number,
  context: TraceWrapContext,
): string[] {
  const subject = commit.message.split("\n")[0]?.trim() ?? "(missing subject)";
  return buildTraceWrappedLines(
    `${String(index + 1)}. ${subject}`,
    maxWidth,
    context.severity,
    context.firstPrefix,
    context.continuationPrefix,
    context.wrapOffset,
  );
}

function buildTraceWrappedLines(
  text: string,
  maxWidth: number,
  severity: ReturnType<typeof getEventFrameSeverity>,
  firstPrefix: string,
  continuationPrefix: string,
  wrapOffset: number,
): string[] {
  return wrapLine(
    text,
    maxWidth - wrapOffset,
    firstPrefix,
    continuationPrefix,
  ).map((line) => styleTraceRail(line, severity));
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

function createCommitPlanRenderContext(
  event: AiOutputEvent,
  commits: VerboseCommitPlanItem[],
  maxWidth: number,
  titleBase: string,
  includeCommitCountInTitle: boolean,
): {
  commitLabel: string;
  lines: string[];
  severity: ReturnType<typeof getEventFrameSeverity>;
} {
  const commitLabel =
    commits.length === 1 ? "candidate commit" : "candidate commits";
  const title = includeCommitCountInTitle
    ? `${titleBase} · ${String(commits.length)} ${commitLabel}`
    : titleBase;
  const { lines, severity } = createCommitPlanTraceBlock(
    event,
    commits,
    maxWidth,
    title,
  );
  return { commitLabel, lines, severity };
}

function createCommitPlanTraceBlock(
  event: AiOutputEvent,
  commits: VerboseCommitPlanItem[],
  maxWidth: number,
  title: string,
): {
  lines: string[];
  severity: ReturnType<typeof getEventFrameSeverity>;
} {
  const severity = getEventFrameSeverity(event, commits);
  const lines = [styleTraceHeader(`╭── ${title}`, severity)];
  lines.push(...formatEventStatLines(event, maxWidth, severity));
  return { lines, severity };
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
  event: AiOutputEvent,
  commits: VerboseCommitPlanItem[],
  maxWidth: number,
  sequence?: number,
): string[] {
  const { lines, severity } = createCommitPlanRenderContext(
    event,
    commits,
    maxWidth,
    buildEventTitle(event, commits, sequence),
    true,
  );

  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index];
    const bullets = collectBodyBullets(commit.message);
    const impactSummary = `${String(commit.files.length)} file(s) · ${String(bullets.length)} ${bullets.length === 1 ? "detail" : "details"}`;

    lines.push(
      ...buildCommitSubjectPreviewLines(commit, index, maxWidth, {
        continuationPrefix: "│    ",
        firstPrefix: "│ ",
        severity,
        wrapOffset: 2,
      }),
      ...buildTraceWrappedLines(
        `impact: ${impactSummary}`,
        maxWidth,
        severity,
        "│   ",
        "│         ",
        4,
      ),
      ...buildTraceWrappedLines(
        `files: ${formatCommitFiles(commit.files)}`,
        maxWidth,
        severity,
        "│   ",
        "│         ",
        4,
      ),
    );

    const previewBullets = bullets.slice(0, 2);
    for (const bullet of previewBullets) {
      lines.push(
        ...wrapLine(bullet, maxWidth - 6, "│   - ", "│     ").map((line) =>
          styleTraceRail(line, severity),
        ),
      );
    }
    if (bullets.length > previewBullets.length) {
      lines.push(
        styleTraceRail(
          `│   - ... ${String(bullets.length - previewBullets.length)} more detail line(s)`,
          severity,
        ),
      );
    }

    if (index < commits.length - 1) {
      lines.push(styleTraceRail("│", severity));
    }
  }

  lines.push(styleTraceFooter("╰──", severity));
  return lines;
}

function formatConsolidationTraceSummary(
  event: AiOutputEvent,
  commits: VerboseCommitPlanItem[],
  maxWidth: number,
  sequence?: number,
): string[] {
  const { commitLabel, lines, severity } = createCommitPlanRenderContext(
    event,
    commits,
    maxWidth,
    `${buildEventTitle(event, commits, sequence)} trace`,
    false,
  );
  lines.push(
    ...buildTraceWrappedLines(
      `summary: ${String(commits.length)} ${commitLabel} finalized; full plan cards render below`,
      maxWidth,
      severity,
      "│   ",
      "│            ",
      4,
    ),
  );

  for (const [index, commit] of commits.slice(0, 3).entries()) {
    lines.push(
      ...buildCommitSubjectPreviewLines(commit, index, maxWidth, {
        continuationPrefix: "│      ",
        firstPrefix: "│   ",
        severity,
        wrapOffset: 4,
      }),
    );
  }

  if (commits.length > 3) {
    lines.push(
      styleTraceRail(
        `│   ... ${String(commits.length - 3)} more commit summaries shown in the plan view`,
        severity,
      ),
    );
  }

  lines.push(styleTraceFooter("╰──", severity));
  return lines;
}

function formatGenericBlock(
  event: AiOutputEvent,
  title: string,
  content: string,
  maxWidth: number,
): string[] {
  const severity = getEventFrameSeverity(event, parseJson(event.content));
  const trimmedContent = content.trim();
  const lines = [styleTraceHeader(`╭── ${title}`, severity)];
  lines.push(...formatEventStatLines(event, maxWidth, severity));

  if (trimmedContent.length === 0) {
    lines.push(
      styleTraceRail("│ (empty)", severity),
      styleTraceFooter("╰──", severity),
    );
    return lines;
  }

  for (const rawLine of trimmedContent.split("\n")) {
    lines.push(
      ...wrapLine(rawLine, maxWidth - 2, "│ ", "│ ").map((line) =>
        styleTraceRail(line, severity),
      ),
    );
  }

  lines.push(styleTraceFooter("╰──", severity));
  return lines;
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
