import OpenAI from "openai";
import { loadConfig } from "./config.js";
import type { DiffChunk, DiffStats, FileDiff } from "./diff.js";

let _client: OpenAI | null = null;

function client(): OpenAI {
  if (_client) return _client;
  const cfg = loadConfig();
  if (!cfg.openai.apiKey) {
    throw new Error(
      "No OpenAI API key. Set OPENAI_API_KEY env var or add openai.apiKey in gitaicmt.config.json",
    );
  }
  _client = new OpenAI({ apiKey: cfg.openai.apiKey });
  return _client;
}

// --------------- Types ---------------

/** A file reference within a planned commit — optionally specifying which hunks */
export interface PlannedCommitFile {
  path: string;
  /** 0-based hunk indices to include. undefined = all hunks in the file. */
  hunks?: number[];
}

/** A planned commit group from AI analysis */
export interface PlannedCommit {
  /** Which files (and optionally which hunks) belong in this commit */
  files: PlannedCommitFile[];
  /** The commit message */
  message: string;
}

// --------------- Prompt building ---------------

function commitFormatInstructions(): string[] {
  const cfg = loadConfig();
  const parts: string[] = [];
  if (cfg.commit.conventional) {
    parts.push(
      "Use the Conventional Commits format: <type>(<scope>): <description>",
      "Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert.",
      "Choose the most specific type that applies.",
    );
  }
  if (cfg.commit.includeScope) {
    parts.push(
      "Include a scope in parentheses reflecting the affected module/area.",
    );
  }
  parts.push(
    `Subject line MUST be <= ${cfg.commit.maxSubjectLength} characters.`,
    `Language: ${cfg.commit.language}.`,
  );
  if (cfg.commit.includeBody) {
    parts.push(
      "After the subject, add a blank line then a concise body (2-4 bullet points) summarizing key changes.",
      `Wrap body lines at ${cfg.commit.maxBodyLineLength} characters.`,
    );
  } else {
    parts.push("Produce only the subject line, no body.");
  }
  parts.push(
    "Do NOT include markdown formatting, code fences, or quotation marks around the message.",
  );
  return parts;
}

function buildSystemPrompt(): string {
  const parts = [
    "You are a concise git commit message generator.",
    "Analyze the provided diff and produce a commit message.",
    ...commitFormatInstructions(),
    "Respond with ONLY the commit message, nothing else.",
  ];
  return parts.join("\n");
}

function buildGroupingSystemPrompt(): string {
  const parts = [
    "You are an expert at analyzing git diffs and splitting them into logical, atomic commits.",
    "Given a set of file diffs with labeled hunks, group them into separate commits where each commit represents ONE coherent change.",
    "",
    "Guidelines for grouping:",
    "- Related changes across multiple files that serve the same purpose go together (e.g., adding a feature + its test).",
    "- Unrelated changes WITHIN the same file should be split into separate commits using hunk indices.",
    "- Config/build changes should be separate from feature/fix code.",
    "- Pure formatting/style changes should be separate from logic changes.",
    "- If ALL changes are tightly related, a single commit group is fine.",
    "",
    "For each group, provide the commit message following these rules:",
    ...commitFormatInstructions(),
    "",
    "Respond with ONLY valid JSON — an array of objects, each with:",
    '  { "files": [{"path": "file.ts", "hunks": [0, 1]}, {"path": "other.ts"}], "message": "the commit message" }',
    "",
    "Each file entry has:",
    '  - "path" (required): the file path',
    '  - "hunks" (optional): array of 0-based hunk indices to include. Omit to include ALL hunks for that file.',
    "",
    "Use hunk indices when a single file has changes that belong in different commits.",
    "Order the array so foundational/dependency changes come first.",
    "Do NOT wrap the JSON in code fences. Output raw JSON only.",
  ];
  return parts.join("\n");
}

function buildUserPrompt(chunk: DiffChunk, stats?: DiffStats): string {
  const parts: string[] = [];
  if (stats) {
    parts.push(
      `[Stats: ${stats.filesChanged} files, +${stats.additions}/-${stats.deletions}, ${stats.chunks} chunk(s)]`,
    );
  }
  parts.push(`Files: ${chunk.files.join(", ")}`, "", chunk.content);
  return parts.join("\n");
}

function buildGroupingUserPrompt(
  fileDiffs: { path: string; diff: string }[],
): string {
  const parts: string[] = [
    `Analyzing ${fileDiffs.length} changed file(s). Group into logical commits.\n`,
    "Each hunk is labeled with its 0-based index [Hunk N] for reference:\n",
  ];
  for (const f of fileDiffs) {
    parts.push(`=== ${f.path} ===`);
    parts.push(f.diff);
    parts.push("");
  }
  return parts.join("\n");
}

// Merge prompt for combining per-chunk messages into one
function buildMergePrompt(messages: string[], stats: DiffStats): string {
  return [
    `Below are ${messages.length} partial commit descriptions from different parts of a changeset.`,
    `Overall: ${stats.filesChanged} files changed, +${stats.additions}/-${stats.deletions}.`,
    "",
    "Partial messages:",
    ...messages.map((m, i) => `--- Part ${i + 1} ---\n${m}`),
    "",
    "Combine these into a single cohesive commit message.",
  ].join("\n");
}

// --------------- API call ---------------

/** Models that do not support a custom temperature (must use default 1). */
function supportsTemperature(model: string): boolean {
  return !/^(o1|o2|o3|o4|gpt-5)/i.test(model);
}

async function complete(system: string, user: string): Promise<string> {
  const cfg = loadConfig();
  const signal =
    cfg.performance.timeoutMs > 0
      ? AbortSignal.timeout(cfg.performance.timeoutMs)
      : undefined;
  const res = await client().chat.completions.create(
    {
      model: cfg.openai.model,
      max_completion_tokens: cfg.openai.maxTokens,
      ...(supportsTemperature(cfg.openai.model)
        ? { temperature: cfg.openai.temperature }
        : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    { signal },
  );
  return (res.choices[0]?.message?.content ?? "").trim();
}

// --------------- Simple cache ---------------

const cache = new Map<string, { msg: string; ts: number }>();

function cacheKey(content: string): string {
  // Fast hash — FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function getFromCache(key: string): string | null {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > cfg.performance.cacheTTLSeconds * 1000) {
    cache.delete(key);
    return null;
  }
  return entry.msg;
}

function setCache(key: string, msg: string): void {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) return;
  cache.set(key, { msg, ts: Date.now() });
}

// --------------- Public API ---------------

export async function generateForChunk(
  chunk: DiffChunk,
  stats?: DiffStats,
): Promise<string> {
  const key = cacheKey(chunk.content);
  const cached = getFromCache(key);
  if (cached) return cached;

  const sys = buildSystemPrompt();
  const usr = buildUserPrompt(chunk, stats);
  const msg = await complete(sys, usr);
  setCache(key, msg);
  return msg;
}

export async function generateForChunks(
  chunks: DiffChunk[],
  stats: DiffStats,
): Promise<string> {
  const cfg = loadConfig();

  if (chunks.length === 0) return "chore: empty commit";
  if (chunks.length === 1) return generateForChunk(chunks[0], stats);

  // Process chunks — parallel or sequential
  let partials: string[];
  if (cfg.performance.parallel) {
    partials = await Promise.all(chunks.map((c) => generateForChunk(c, stats)));
  } else {
    partials = [];
    for (const c of chunks) {
      partials.push(await generateForChunk(c, stats));
    }
  }

  // Merge partial messages into one
  const sys = buildSystemPrompt();
  const usr = buildMergePrompt(partials, stats);
  return complete(sys, usr);
}

/**
 * Format a file diff with labeled hunks for the grouping prompt.
 * Each hunk gets a [Hunk N] label so the AI can reference specific hunks.
 */
function formatLabeledDiff(
  file: FileDiff,
  formatFileDiff: (f: FileDiff) => string,
): string {
  if (file.hunks.length <= 1) {
    // Single hunk — no need to label
    return formatFileDiff(file);
  }
  const parts: string[] = [
    `--- ${file.oldPath ?? file.path}`,
    `+++ ${file.path}`,
  ];
  for (let i = 0; i < file.hunks.length; i++) {
    const h = file.hunks[i];
    parts.push(`[Hunk ${i}] ${h.header}`);
    parts.push(...h.lines);
  }
  return parts.join("\n");
}

/**
 * Analyze all staged file diffs and split them into logical commit groups.
 * Uses the AI to determine which files/hunks belong together.
 * Returns an ordered array of planned commits with hunk-level granularity.
 */
export async function planCommits(
  files: FileDiff[],
  formatFileDiff: (f: FileDiff) => string,
): Promise<PlannedCommit[]> {
  const cfg = loadConfig();

  // For a single file with a single hunk, skip grouping — just generate a message
  if (files.length === 1 && files[0].hunks.length <= 1) {
    const chunk: DiffChunk = {
      id: 0,
      files: [files[0].path],
      content: formatFileDiff(files[0]),
      lineCount: formatFileDiff(files[0]).split("\n").length,
    };
    const msg = await generateForChunk(chunk);
    return [{ files: [{ path: files[0].path }], message: msg }];
  }

  // For a single file with multiple hunks, still run grouping to split hunks
  // For multiple files, always run grouping

  // Build per-file diffs with labeled hunks for the grouping prompt
  const fileDiffs = files.map((f) => ({
    path: f.path,
    diff: formatLabeledDiff(f, formatFileDiff),
  }));

  // Ask AI to group files/hunks into logical commits
  const sys = buildGroupingSystemPrompt();
  const usr = buildGroupingUserPrompt(fileDiffs);

  // Use higher token limit for grouping since it returns structured JSON
  const signal =
    cfg.performance.timeoutMs > 0
      ? AbortSignal.timeout(cfg.performance.timeoutMs)
      : undefined;
  const res = await client().chat.completions.create(
    {
      model: cfg.openai.model,
      max_completion_tokens: Math.max(cfg.openai.maxTokens, 1024),
      ...(supportsTemperature(cfg.openai.model)
        ? { temperature: cfg.openai.temperature }
        : {}),
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr },
      ],
    },
    { signal },
  );

  const raw = (res.choices[0]?.message?.content ?? "").trim();

  // Build lookup for validation
  const fileByPath = new Map(files.map((f) => [f.path, f]));

  // Parse the JSON response
  let groups: PlannedCommit[];
  try {
    // Strip code fences if AI included them despite instructions
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");
    const parsed = JSON.parse(cleaned) as Array<{
      files: Array<string | { path: string; hunks?: number[] }>;
      message: string;
    }>;

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Empty or invalid grouping response");
    }

    // Normalize file entries — AI might return strings or objects
    groups = parsed
      .map((g) => ({
        files: g.files
          .map((f): PlannedCommitFile | null => {
            if (typeof f === "string") {
              return fileByPath.has(f) ? { path: f } : null;
            }
            if (
              f &&
              typeof f === "object" &&
              typeof f.path === "string" &&
              fileByPath.has(f.path)
            ) {
              const file = fileByPath.get(f.path)!;
              // Validate hunk indices
              if (Array.isArray(f.hunks) && f.hunks.length > 0) {
                const validHunks = f.hunks.filter(
                  (h) =>
                    typeof h === "number" && h >= 0 && h < file.hunks.length,
                );
                return validHunks.length > 0
                  ? { path: f.path, hunks: validHunks }
                  : { path: f.path };
              }
              return { path: f.path };
            }
            return null;
          })
          .filter((f): f is PlannedCommitFile => f !== null),
        message: g.message,
      }))
      .filter((g) => g.files.length > 0);

    // Track which files (and which hunks within files) have been assigned
    // For hunk-level tracking: map path → set of assigned hunk indices
    const assignedHunks = new Map<string, Set<number>>();
    for (const g of groups) {
      for (const f of g.files) {
        if (!assignedHunks.has(f.path)) {
          assignedHunks.set(f.path, new Set());
        }
        const file = fileByPath.get(f.path)!;
        if (f.hunks) {
          for (const h of f.hunks) assignedHunks.get(f.path)!.add(h);
        } else {
          // All hunks assigned
          for (let i = 0; i < file.hunks.length; i++)
            assignedHunks.get(f.path)!.add(i);
        }
      }
    }

    // Find any missed files or hunks
    const missedFiles: PlannedCommitFile[] = [];
    for (const file of files) {
      const assigned = assignedHunks.get(file.path);
      if (!assigned || assigned.size === 0) {
        // Entire file missed
        missedFiles.push({ path: file.path });
      } else if (assigned.size < file.hunks.length) {
        // Some hunks missed
        const missedHunks: number[] = [];
        for (let i = 0; i < file.hunks.length; i++) {
          if (!assigned.has(i)) missedHunks.push(i);
        }
        if (missedHunks.length > 0) {
          missedFiles.push({ path: file.path, hunks: missedHunks });
        }
      }
    }

    if (missedFiles.length > 0) {
      // Generate a message for missed content
      const missedContent = missedFiles
        .map((mf) => {
          const file = fileByPath.get(mf.path)!;
          if (mf.hunks) {
            // Only specific hunks
            const selectedHunks = mf.hunks.map((i) => file.hunks[i]);
            const parts = [
              `--- ${file.oldPath ?? file.path}`,
              `+++ ${file.path}`,
            ];
            for (const h of selectedHunks) {
              parts.push(h.header, ...h.lines);
            }
            return parts.join("\n");
          }
          return formatFileDiff(file);
        })
        .join("\n");

      const missedChunk: DiffChunk = {
        id: 999,
        files: missedFiles.map((f) => f.path),
        content: missedContent,
        lineCount: missedContent.split("\n").length,
      };
      const missedMsg = await generateForChunk(missedChunk);
      groups.push({ files: missedFiles, message: missedMsg });
    }
  } catch {
    // Fallback: one commit for everything
    const allContent = fileDiffs.map((f) => f.diff).join("\n");
    const allChunk: DiffChunk = {
      id: 0,
      files: files.map((f) => f.path),
      content: allContent,
      lineCount: allContent.split("\n").length,
    };
    const msg = await generateForChunk(allChunk);
    groups = [{ files: files.map((f) => ({ path: f.path })), message: msg }];
  }

  return groups;
}
