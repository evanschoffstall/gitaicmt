import { z } from "zod";

/**
 * Runtime validation schema for gitaicmt configuration
 * Ensures type safety and validates bounds for all config fields
 */

const OpenAISettingsSchema = z.object({
  apiKey: z.string().describe("OpenAI API key (use env var OPENAI_API_KEY)"),
  maxTokens: z
    .number()
    .int()
    .min(1, "maxTokens must be at least 1")
    .max(100000, "maxTokens cannot exceed 100000")
    .describe("Maximum tokens for AI responses"),
  model: z
    .string()
    .min(1, "Model name cannot be empty")
    .describe("OpenAI model to use (e.g., gpt-4o-mini)"),
  temperature: z
    .number()
    .min(0, "temperature must be at least 0")
    .max(2, "temperature cannot exceed 2")
    .describe("AI creativity (0 = deterministic, 2 = very creative)"),
});

const AnalysisSettingsSchema = z.object({
  chunkSize: z
    .number()
    .int()
    .min(50, "chunkSize must be at least 50")
    .max(100000, "chunkSize cannot exceed 100000")
    .describe("Lines per chunk for processing"),
  groupByFile: z.boolean().describe("Group changes by file when chunking"),
  groupByHunk: z.boolean().describe("Split large files by hunk when needed"),
  maxDiffLines: z
    .number()
    .int()
    .min(100, "maxDiffLines must be at least 100")
    .max(1000000, "maxDiffLines cannot exceed 1000000")
    .describe("Maximum diff lines to process"),
  promptOnTokenWarning: z
    .boolean()
    .describe(
      "Prompt for confirmation before AI calls when estimated token usage reaches the warning threshold",
    ),
  tokenWarningThreshold: z
    .number()
    .int()
    .min(0, "tokenWarningThreshold must be non-negative")
    .max(1000000, "tokenWarningThreshold cannot exceed 1000000")
    .describe(
      "Warn when estimated token usage reaches this threshold; set to 0 to disable warnings",
    ),
});

const CommitSettingsSchema = z.object({
  conventional: z.boolean().describe("Use Conventional Commits format"),
  includeBody: z.boolean().describe("Generate commit message body"),
  includeScope: z.boolean().describe("Include scope in conventional commits"),
  language: z
    .string()
    .length(2, "language must be 2-letter ISO code")
    .regex(/^[a-z]{2}$/, "language must be lowercase 2-letter code")
    .describe("Language for commit messages (e.g., en, es, fr)"),
  maxBodyLineLength: z
    .number()
    .int()
    .min(40, "maxBodyLineLength must be at least 40")
    .max(200, "maxBodyLineLength cannot exceed 200")
    .describe("Maximum characters per line in commit body"),
  maxSubjectLength: z
    .number()
    .int()
    .min(20, "maxSubjectLength must be at least 20")
    .max(200, "maxSubjectLength cannot exceed 200")
    .describe("Maximum characters for commit subject line"),
});

const PerformanceSettingsSchema = z.object({
  cacheEnabled: z.boolean().describe("Cache AI responses to reduce API calls"),
  cacheTTLSeconds: z
    .number()
    .int()
    .min(0, "cacheTTLSeconds must be non-negative")
    .max(86400, "cacheTTLSeconds cannot exceed 24 hours")
    .describe("Cache time-to-live in seconds"),
  parallel: z.boolean().describe("Process chunks in parallel"),
  timeoutMs: z
    .number()
    .int()
    .min(0, "timeoutMs must be non-negative")
    .max(300000, "timeoutMs cannot exceed 5 minutes")
    .describe("API request timeout in milliseconds"),
});

export const ConfigSchema = z.object({
  analysis: AnalysisSettingsSchema,
  commit: CommitSettingsSchema,
  openai: OpenAISettingsSchema,
  performance: PerformanceSettingsSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
