import type OpenAI from "openai";

import { loadConfig } from "../application/config/index.js";
import { ConfigError, OpenAIError } from "../application/errors.js";
import {
  type AiOutputFileAliasMap,
  extractAiOutputFileAliasMap,
} from "./ai-file-paths.js";
import {
  buildCompletionRequest,
  isNonChatModelError,
  readChatContent,
  rethrowTimeoutError,
  supportsTemperature,
  toOpenAiCallError,
  validateModelName,
} from "./client-contracts.js";
import { extractResponseText } from "./output-text.js";
import {
  createEmptyTokenUsageByStage,
  createEmptyTokenUsageSummary,
  extractTokenUsage,
  mergeTokenUsageSummary,
} from "./usage-tracking.js";

let cachedClient: null | OpenAI = null;
let lastApiKey: null | string = null;

export interface AiOutputEvent {
  content: string;
  durationMs?: number;
  fileAliasMap?: AiOutputFileAliasMap;
  inputTokens?: number;
  kind?: AiOutputEventKind;
  outputTokens?: number;
  requestCountDelta?: number;
  stage: "unknown" | TokenUsageStage;
  totalTokens?: number;
  transport?: AiOutputTransport;
}

export type AiOutputEventKind = "cache" | "model-output" | "planner-decision";

export type AiOutputTransport = "chat" | "internal" | "responses";

export type TokenUsageStage =
  | "cluster"
  | "consolidate"
  | "generate"
  | "group"
  | "merge";

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  totalTokens: number;
}

let currentTokenUsage: TokenUsageSummary = createEmptyTokenUsageSummary();
let currentTokenUsageByStage: Record<TokenUsageStage, TokenUsageSummary> =
  createEmptyTokenUsageByStage();
let aiOutputObserver: ((event: AiOutputEvent) => void) | null = null;

export interface CompleteOptions {
  maxTokens?: number;
  stage?: TokenUsageStage;
  temperature?: number;
  timeoutMs?: number;
}

export async function complete(
  system: string,
  user: string,
  options?: CompleteOptions,
): Promise<string> {
  const cfg = loadConfig();
  const request = buildCompletionRequest(cfg, options);
  const startedAtMs = performance.now();
  const fileAliasMap = extractAiOutputFileAliasMap(user);

  try {
    return await completeViaChat(
      system,
      user,
      request,
      startedAtMs,
      fileAliasMap,
    );
  } catch (err: unknown) {
    rethrowTimeoutError(err, request.timeoutMs);

    if (!isNonChatModelError(err)) {
      throw toOpenAiCallError(err);
    }

    try {
      return await completeViaResponses(system, user, request, fileAliasMap);
    } catch (fallbackErr: unknown) {
      rethrowTimeoutError(fallbackErr, request.timeoutMs);
      throw toOpenAiCallError(fallbackErr);
    }
  }
}

export function emitAiOutputEvent(event: AiOutputEvent): void {
  notifyAiOutputObserver(event);
}

export function getTokenUsageByStage(): Record<
  TokenUsageStage,
  TokenUsageSummary
> {
  return {
    cluster: { ...currentTokenUsageByStage.cluster },
    consolidate: { ...currentTokenUsageByStage.consolidate },
    generate: { ...currentTokenUsageByStage.generate },
    group: { ...currentTokenUsageByStage.group },
    merge: { ...currentTokenUsageByStage.merge },
  };
}

export function getTokenUsageSummary(): TokenUsageSummary {
  return { ...currentTokenUsage };
}

export function resetTokenUsageSummary(): void {
  currentTokenUsage = createEmptyTokenUsageSummary();
  currentTokenUsageByStage = createEmptyTokenUsageByStage();
}

/**
 * Register a process-local observer for successful AI stage outputs.
 */
export function setAiOutputObserver(
  observer: ((event: AiOutputEvent) => void) | null,
): void {
  aiOutputObserver = observer;
}

export function validateOpenAIConfiguration(): void {
  const cfg = loadConfig();

  if (!cfg.openai.apiKey) {
    throw new ConfigError(
      "No OpenAI API key. Set OPENAI_API_KEY env var or add openai.apiKey in gitaicmt.config.json",
    );
  }

  const validPrefixes = ["sk-", "sk-proj-", "org-"];
  const hasValidPrefix = validPrefixes.some((prefix) =>
    cfg.openai.apiKey.startsWith(prefix),
  );
  if (!hasValidPrefix || cfg.openai.apiKey.length < 20) {
    const keyPrefix = cfg.openai.apiKey.slice(0, 3);
    throw new ConfigError(
      `Invalid OpenAI API key format (prefix: ${keyPrefix}...). Expected format: sk-... or sk-proj-... or org-... with at least 20 characters.`,
    );
  }

  validateModelName(cfg.openai.model);
}

async function client(): Promise<OpenAI> {
  const cfg = loadConfig();

  if (cachedClient && lastApiKey !== cfg.openai.apiKey) {
    cachedClient = null;
    lastApiKey = null;
  }

  if (cachedClient) {
    return cachedClient;
  }

  validateOpenAIConfiguration();

  lastApiKey = cfg.openai.apiKey;
  const OpenAIClient = (await import("openai")).default;
  cachedClient = new OpenAIClient({ apiKey: cfg.openai.apiKey });
  return cachedClient;
}

async function completeViaChat(
  system: string,
  user: string,
  request: {
    maxTokens: number;
    signal: AbortSignal | undefined;
    stage?: TokenUsageStage;
    temperature: number;
  },
  startedAtMs: number,
  fileAliasMap: AiOutputFileAliasMap,
): Promise<string> {
  const cfg = loadConfig();
  const res = await (
    await client()
  ).chat.completions.create(
    {
      max_completion_tokens: request.maxTokens,
      model: cfg.openai.model,
      ...(supportsTemperature(cfg.openai.model)
        ? { temperature: request.temperature }
        : {}),
      messages: [
        { content: system, role: "system" as const },
        { content: user, role: "user" as const },
      ],
    },
    { signal: request.signal },
  );
  const content = readChatContent(res);
  notifyModelOutputEvent(content, {
    durationMs: performance.now() - startedAtMs,
    fileAliasMap,
    stage: request.stage,
    transport: "chat",
    usage: recordTokenUsage(res, request.stage),
  });
  return content;
}

async function completeViaResponses(
  system: string,
  user: string,
  request: {
    maxTokens: number;
    signal: AbortSignal | undefined;
    stage?: TokenUsageStage;
    temperature: number;
  },
  fileAliasMap: AiOutputFileAliasMap,
): Promise<string> {
  const cfg = loadConfig();
  const startedAtMs = performance.now();
  const res = await (
    await client()
  ).responses.create(
    {
      input: user,
      instructions: system,
      max_output_tokens: request.maxTokens,
      model: cfg.openai.model,
      ...(supportsTemperature(cfg.openai.model)
        ? { temperature: request.temperature }
        : {}),
    },
    { signal: request.signal },
  );

  const content = extractResponseText(res);
  if (!content) {
    throw new OpenAIError("Responses API returned empty or invalid response");
  }
  notifyModelOutputEvent(content, {
    durationMs: performance.now() - startedAtMs,
    fileAliasMap,
    stage: request.stage,
    transport: "responses",
    usage: recordTokenUsage(res, request.stage),
  });
  return content;
}

function notifyAiOutputObserver(event: AiOutputEvent): void {
  if (!aiOutputObserver) {
    return;
  }

  try {
    aiOutputObserver(event);
  } catch {
    // Verbose logging must never interfere with commit generation.
  }
}

function notifyModelOutputEvent(
  content: string,
  options: {
    durationMs: number;
    fileAliasMap: AiOutputFileAliasMap;
    stage?: TokenUsageStage;
    transport: AiOutputTransport;
    usage: null | Omit<TokenUsageSummary, "requestCount">;
  },
): void {
  notifyAiOutputObserver({
    content,
    durationMs: options.durationMs,
    ...(options.fileAliasMap.size > 0
      ? { fileAliasMap: options.fileAliasMap }
      : {}),
    inputTokens: options.usage?.inputTokens,
    kind: "model-output",
    outputTokens: options.usage?.outputTokens,
    requestCountDelta: 1,
    stage: options.stage ?? "unknown",
    totalTokens: options.usage?.totalTokens,
    transport: options.transport,
  });
}

function recordTokenUsage(
  raw: unknown,
  stage?: TokenUsageStage,
): null | Omit<TokenUsageSummary, "requestCount"> {
  const usage = extractTokenUsage(raw);
  if (!usage) {
    return null;
  }

  currentTokenUsage = mergeTokenUsageSummary(currentTokenUsage, usage);

  if (!stage) {
    return usage;
  }

  currentTokenUsageByStage[stage] = mergeTokenUsageSummary(
    currentTokenUsageByStage[stage],
    usage,
  );

  return usage;
}
