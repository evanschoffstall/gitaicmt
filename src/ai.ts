import { createHash } from "node:crypto";
import OpenAI from "openai";
import { loadConfig } from "./config.js";
import {
  CACHE_MAX_SIZE,
  GROUPING_TIMEOUT_MS,
  MAX_COMMIT_GROUPS,
  MIN_COMMIT_MESSAGE_TOKENS,
} from "./constants.js";
import type { DiffChunk, DiffStats, FileDiff } from "./diff.js";
import { ConfigError, OpenAIError, ValidationError } from "./errors.js";

let _client: OpenAI | null = null;

/** Reset the OpenAI client (called when config is reset) */
export function resetClient(): void {
  _client = null;
}

function client(): OpenAI {
  if (_client) return _client;
  const cfg = loadConfig();
  if (!cfg.openai.apiKey) {
    throw new ConfigError(
      "No OpenAI API key. Set OPENAI_API_KEY env var or add openai.apiKey in gitaicmt.config.json",
    );
  }
  // Validate API key format (basic check)
  if (!cfg.openai.apiKey.startsWith("sk-") || cfg.openai.apiKey.length < 20) {
    throw new ConfigError(
      "Invalid OpenAI API key format. Key should start with 'sk-' and be at least 20 characters.",
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
    "CRITICAL RULES:",
    "1. Your PRIMARY goal is to SPLIT changes into MULTIPLE commits. A single commit is almost NEVER correct.",
    "2. You MUST produce at least 2 commits whenever there are 2+ files changed, unless every single file is part of the exact same atomic change.",
    "3. Err heavily on the side of MORE commits. Each commit should be independently understandable.",
    "4. Different CATEGORIES of files belong in separate commits:",
    "   - Documentation changes (README, docs, comments) → separate commit",
    "   - Config/build/dependency changes (package.json, tsconfig, etc.) → separate commit",
    "   - Each distinct source code change (new feature, refactor, bugfix) → separate commit",
    "   - Test file changes go with the source code they test, NOT lumped with unrelated source changes",
    "",
    "5. Within a single source file, if hunks touch DIFFERENT functions, modules, or concerns → split by hunk into separate commits.",
    "6. Even if changes share a theme (e.g., 'hardening', 'cleanup'), split by the specific thing each change does.",
    "",
    "EXAMPLE: Given changes to package.json (license fix), src/cache.ts (new cache eviction), src/auth.ts (API key validation), README.md (doc update), test/auth.test.ts (test update):",
    "→ Commit 1: package.json → chore: fix license field",
    "→ Commit 2: src/cache.ts → refactor(cache): add bounded eviction",
    "→ Commit 3: src/auth.ts + test/auth.test.ts → feat(auth): add API key validation",
    "→ Commit 4: README.md → docs: update configuration section",
    "NOT one big commit like 'refactor: improve project quality'",
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

/** Categorize a file path for the grouping prompt */
function categorizeFile(path: string): string {
  if (/^(README|CHANGELOG|LICENSE|AGENTS|docs\/)/i.test(path)) return "docs";
  if (/^(package\.json|tsconfig|\.[a-z]*rc|\.config|bun\.lock)/i.test(path))
    return "config/build";
  if (/\.(test|spec)\.[a-z]+$/i.test(path) || /^tests?\//i.test(path))
    return "test";
  return "source";
}

function buildGroupingUserPrompt(
  fileDiffs: { path: string; diff: string }[],
): string {
  // Pre-categorize files so the AI sees the natural split boundaries
  const byCategory = new Map<string, string[]>();
  for (const f of fileDiffs) {
    const cat = categorizeFile(f.path);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(f.path);
  }

  const parts: string[] = [
    `Analyzing ${fileDiffs.length} changed file(s). Split into MULTIPLE logical commits.`,
    "",
    "File categories (hint for splitting):",
  ];
  for (const [cat, paths] of byCategory) {
    parts.push(`  [${cat}] ${paths.join(", ")}`);
  }
  parts.push("");
  parts.push(
    "Each hunk is labeled with its 0-based index [Hunk N] for reference:",
  );
  parts.push("");

  for (const f of fileDiffs) {
    parts.push(`=== ${f.path} [${categorizeFile(f.path)}] ===`);
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

  try {
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

    const content = res.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new OpenAIError("API returned empty or invalid response");
    }

    return content.trim();
  } catch (err: unknown) {
    if (err instanceof Error) {
      // Handle timeout specifically
      if (err.name === "AbortError" || err.message.includes("timeout")) {
        throw new OpenAIError(
          `OpenAI API request timed out after ${cfg.performance.timeoutMs}ms. Try increasing performance.timeoutMs in config.`,
        );
      }
      // Re-throw with original message
      throw err;
    }
    throw new OpenAIError(`OpenAI API call failed: ${String(err)}`);
  }
}

// --------------- Simple cache ---------------

const cache = new Map<string, { msg: string; ts: number }>();

function cacheKey(content: string): string {
  // Use SHA-256 for collision resistance (32-bit FNV-1a had collision risk)
  return createHash("sha256").update(content).digest("hex");
}

/** Evict expired and oldest entries when cache exceeds max size */
function evictOldestCacheEntries(): void {
  const cfg = loadConfig();
  const now = Date.now();
  const ttlMs = cfg.performance.cacheTTLSeconds * 1000;

  // First pass: remove all expired entries
  for (const [key, entry] of cache.entries()) {
    if (now - entry.ts > ttlMs) {
      cache.delete(key);
    }
  }

  // Second pass: if still over limit, remove oldest entries
  if (cache.size > CACHE_MAX_SIZE) {
    const entries = Array.from(cache.entries()).sort(
      (a, b) => a[1].ts - b[1].ts,
    );
    const toDelete = entries.slice(0, cache.size - CACHE_MAX_SIZE);
    for (const [key] of toDelete) {
      cache.delete(key);
    }
  }
}

function getFromCache(key: string): string | null {
  const cfg = loadConfig();
  if (!cfg.performance.cacheEnabled) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  // Check TTL
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
  // Evict on every write to keep cache bounded
  evictOldestCacheEntries();
}

// --------------- Public API ---------------

/**
 * Generate a commit message for a single diff chunk
 * Uses OpenAI API with caching for performance
 * @param chunk - The diff chunk to analyze
 * @param stats - Optional summary statistics for context
 * @returns A commit message generated by AI
 * @throws {OpenAIError} If API call fails
 * @throws {ConfigError} If API key is missing or invalid
 */
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

/**
 * Generate a commit message for multiple diff chunks
 * Merges chunks or uses the single-chunk generator as appropriate
 * @param chunks - Array of diff chunks to analyze
 * @param stats - Summary statistics for all chunks
 * @returns A combined commit message covering all chunks
 * @throws {OpenAIError} If API call fails
 * @throws {ConfigError} If API key is missing or invalid
 */
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

/** Type guard for valid PlannedCommit file entry */
function isValidFileEntry(
  f: unknown,
  fileByPath: Map<string, FileDiff>,
): f is PlannedCommitFile {
  // Must be string or object with path
  if (typeof f === "string") {
    return fileByPath.has(f);
  }
  if (!f || typeof f !== "object") {
    return false;
  }
  const obj = f as { path?: unknown; hunks?: unknown };
  if (typeof obj.path !== "string" || !fileByPath.has(obj.path)) {
    return false;
  }
  // If hunks provided, must be an array of numbers
  if (obj.hunks !== undefined) {
    if (!Array.isArray(obj.hunks)) return false;
    const file = fileByPath.get(obj.path)!;
    return obj.hunks.every(
      (h) => typeof h === "number" && h >= 0 && h < file.hunks.length,
    );
  }
  return true;
}

/** Validate and normalize AI grouping response */
function validateAndNormalizeGrouping(
  raw: unknown,
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  // Must be array
  if (!Array.isArray(raw)) {
    throw new ValidationError(
      `AI grouping response is not an array. Got: ${typeof raw}`,
    );
  }
  if (raw.length === 0) {
    throw new ValidationError("AI returned empty commit group array");
  }
  if (raw.length > MAX_COMMIT_GROUPS) {
    throw new ValidationError(
      `AI returned suspiciously large number of groups (${raw.length}), likely malformed`,
    );
  }

  const groups: PlannedCommit[] = [];
  let skippedEntries = 0;

  for (let i = 0; i < raw.length; i++) {
    const g = raw[i];
    if (!g || typeof g !== "object" || Array.isArray(g)) {
      throw new ValidationError(
        `Commit group ${i} is not a valid object. Got: ${typeof g}`,
      );
    }
    const group = g as { files?: unknown; message?: unknown };

    // Validate files array
    if (!Array.isArray(group.files)) {
      throw new ValidationError(
        `Commit group ${i} has invalid 'files' field. Expected array, got: ${typeof group.files}`,
      );
    }
    if (group.files.length === 0) {
      throw new ValidationError(`Commit group ${i} has empty 'files' array`);
    }

    // Validate message
    if (typeof group.message !== "string") {
      throw new ValidationError(
        `Commit group ${i} has invalid 'message' field. Expected string, got: ${typeof group.message}`,
      );
    }
    if (group.message.trim().length === 0) {
      throw new ValidationError(`Commit group ${i} has empty 'message' field`);
    }
    if (group.message.length > 10000) {
      throw new ValidationError(
        `Commit group ${i} message exceeds maximum length (${group.message.length} chars)`,
      );
    }

    // Normalize file entries
    const normalizedFiles: PlannedCommitFile[] = [];
    for (const f of group.files) {
      if (!isValidFileEntry(f, fileByPath)) {
        skippedEntries++;
        continue; // Skip invalid entries
      }
      if (typeof f === "string") {
        normalizedFiles.push({ path: f });
      } else {
        const obj = f as { path: string; hunks?: number[] };
        const file = fileByPath.get(obj.path)!;
        if (obj.hunks && obj.hunks.length > 0) {
          const validHunks = obj.hunks.filter(
            (h) => h >= 0 && h < file.hunks.length,
          );
          if (validHunks.length !== obj.hunks.length) {
            skippedEntries++; // Some hunks were invalid
          }
          normalizedFiles.push(
            validHunks.length > 0
              ? { path: obj.path, hunks: validHunks }
              : { path: obj.path },
          );
        } else {
          normalizedFiles.push({ path: obj.path });
        }
      }
    }

    if (normalizedFiles.length > 0) {
      groups.push({ files: normalizedFiles, message: group.message });
    } else {
      throw new ValidationError(
        `Commit group ${i} has no valid file entries after normalization`,
      );
    }
  }

  if (groups.length === 0) {
    throw new ValidationError("No valid commit groups after normalization");
  }

  return groups;
}

/**
 * Analyze all staged file diffs and split them into logical commit groups.
 * Uses the AI to determine which files/hunks belong together.
 * For single files with few hunks, skips grouping and generates message directly.
 * @param files - Array of parsed file diffs to analyze
 * @param formatFileDiff - Function to format a FileDiff into diff text
 * @returns Ordered array of planned commits with hunk-level granularity and messages
 * @throws {OpenAIError} If API call fails
 * @throws {ConfigError} If API key is missing or invalid
 * @throws {ValidationError} If AI response cannot be parsed or validated
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

  // For large changesets (> 6 files), split into smaller batches and process separately
  // This forces more granular commits and speeds up processing
  const MAX_FILES_PER_BATCH = 6;
  if (files.length > MAX_FILES_PER_BATCH) {
    const batches: FileDiff[][] = [];

    // Group files by category for better logical splitting
    const categorized = new Map<string, FileDiff[]>();
    for (const file of files) {
      const cat = categorizeFile(file.path);
      if (!categorized.has(cat)) categorized.set(cat, []);
      categorized.get(cat)!.push(file);
    }

    // Create batches from categorized files
    for (const [, categoryFiles] of categorized) {
      for (let i = 0; i < categoryFiles.length; i += MAX_FILES_PER_BATCH) {
        batches.push(categoryFiles.slice(i, i + MAX_FILES_PER_BATCH));
      }
    }

    // Process each batch in parallel
    const batchResults = await Promise.all(
      batches.map((batch) => planCommits(batch, formatFileDiff)),
    );

    // Flatten and return all commits
    return batchResults.flat();
  }

  // For a single file with multiple hunks, still run grouping to split hunks
  // For multiple files (≤6), always run grouping

  // Build per-file diffs with labeled hunks for the grouping prompt
  const fileDiffs = files.map((f) => ({
    path: f.path,
    diff: formatLabeledDiff(f, formatFileDiff),
  }));

  // Ask AI to group files/hunks into logical commits
  const sys = buildGroupingSystemPrompt();
  const usr = buildGroupingUserPrompt(fileDiffs);

  // Grouping returns structured JSON with multiple commits — needs much more
  // tokens than a single commit message.  Scale with file count.
  const groupingTokens = Math.max(
    cfg.openai.maxTokens,
    MIN_COMMIT_MESSAGE_TOKENS + files.length * 256,
    2048,
  );
  // Also give more time for the larger response
  const groupingTimeout = Math.max(
    cfg.performance.timeoutMs,
    GROUPING_TIMEOUT_MS,
  );
  const signal =
    groupingTimeout > 0 ? AbortSignal.timeout(groupingTimeout) : undefined;
  const res = await client().chat.completions.create(
    {
      model: cfg.openai.model,
      max_completion_tokens: groupingTokens,
      ...(supportsTemperature(cfg.openai.model)
        ? { temperature: Math.min(cfg.openai.temperature, 0.3) }
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

  // Parse and validate the JSON response
  let groups: PlannedCommit[];
  try {
    // Strip code fences if AI included them despite instructions
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      throw new ValidationError(
        `AI returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
    }

    // Validate and normalize the structure
    groups = validateAndNormalizeGrouping(parsed, fileByPath);

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
