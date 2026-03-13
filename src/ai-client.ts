import OpenAI from "openai";

import { loadConfig } from "./config.js";
import { ConfigError, OpenAIError, OpenAITimeoutError } from "./errors.js";

let cachedClient: null | OpenAI = null;
let lastApiKey: null | string = null;

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  totalTokens: number;
}

let currentTokenUsage: TokenUsageSummary = emptyTokenUsageSummary();

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export async function complete(
  system: string,
  user: string,
  options?: CompleteOptions,
): Promise<string> {
  const cfg = loadConfig();
  const timeoutMs = options?.timeoutMs ?? cfg.performance.timeoutMs;
  const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const maxTokens = options?.maxTokens ?? cfg.openai.maxTokens;
  const temperature = options?.temperature ?? cfg.openai.temperature;

  const chatPayload = {
    max_completion_tokens: maxTokens,
    model: cfg.openai.model,
    ...(supportsTemperature(cfg.openai.model) ? { temperature } : {}),
    messages: [
      { content: system, role: "system" as const },
      { content: user, role: "user" as const },
    ],
  };

  try {
    const res = await client().chat.completions.create(chatPayload, { signal });
    recordTokenUsage(res);
    const content = res.choices[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
    throw new OpenAIError("API returned empty or invalid response");
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.name === "AbortError" || err.message.includes("timeout")) {
        throw new OpenAITimeoutError(timeoutMs);
      }
    }

    if (!isNonChatModelError(err)) {
      if (err instanceof Error) {
        throw new OpenAIError(`OpenAI API call failed: ${err.message}`, err);
      }
      throw new OpenAIError(`OpenAI API call failed: ${String(err)}`);
    }

    try {
      const res = await client().responses.create(
        {
          input: user,
          instructions: system,
          max_output_tokens: maxTokens,
          model: cfg.openai.model,
          ...(supportsTemperature(cfg.openai.model) ? { temperature } : {}),
        },
        { signal },
      );

      recordTokenUsage(res);

      const content = extractResponseText(res);
      if (!content) {
        throw new OpenAIError(
          "Responses API returned empty or invalid response",
        );
      }
      return content;
    } catch (fallbackErr: unknown) {
      if (fallbackErr instanceof Error) {
        if (
          fallbackErr.name === "AbortError" ||
          fallbackErr.message.includes("timeout")
        ) {
          throw new OpenAITimeoutError(timeoutMs);
        }
        throw new OpenAIError(
          `OpenAI API call failed: ${fallbackErr.message}`,
          fallbackErr,
        );
      }
      throw new OpenAIError(`OpenAI API call failed: ${String(fallbackErr)}`);
    }
  }
}

export function getTokenUsageSummary(): TokenUsageSummary {
  return { ...currentTokenUsage };
}

export function resetTokenUsageSummary(): void {
  currentTokenUsage = emptyTokenUsageSummary();
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

function client(): OpenAI {
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
  cachedClient = new OpenAI({ apiKey: cfg.openai.apiKey });
  return cachedClient;
}

function emptyTokenUsageSummary(): TokenUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    totalTokens: 0,
  };
}

function extractResponseText(raw: unknown): string {
  const asObj = raw as {
    output?: {
      content?: { text?: string; type?: string }[];
    }[];
    output_text?: string;
  };

  if (typeof asObj.output_text === "string" && asObj.output_text.trim()) {
    return asObj.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of asObj.output ?? []) {
    for (const content of item.content ?? []) {
      if (
        (content.type === "output_text" || content.type === "text") &&
        typeof content.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractTokenUsage(
  raw: unknown,
): null | Omit<TokenUsageSummary, "requestCount"> {
  const withUsage = raw as {
    usage?: {
      completion_tokens?: unknown;
      input_tokens?: unknown;
      output_tokens?: unknown;
      prompt_tokens?: unknown;
      total_tokens?: unknown;
    };
  };

  const usage = withUsage.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const inputTokens =
    readUsageNumber(usage.input_tokens ?? usage.prompt_tokens) ?? 0;
  const outputTokens =
    readUsageNumber(usage.output_tokens ?? usage.completion_tokens) ?? 0;
  const totalTokens =
    readUsageNumber(usage.total_tokens) ?? inputTokens + outputTokens;

  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function isNonChatModelError(err: unknown): boolean {
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? err.message
      : err;
  const msg = String(message).toLowerCase();
  return (
    msg.includes("not a chat model") ||
    msg.includes("not supported in the v1/chat/completions")
  );
}

function readUsageNumber(value: unknown): null | number {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordTokenUsage(raw: unknown): void {
  const usage = extractTokenUsage(raw);
  if (!usage) {
    return;
  }

  currentTokenUsage = {
    inputTokens: currentTokenUsage.inputTokens + usage.inputTokens,
    outputTokens: currentTokenUsage.outputTokens + usage.outputTokens,
    requestCount: currentTokenUsage.requestCount + 1,
    totalTokens: currentTokenUsage.totalTokens + usage.totalTokens,
  };
}

function supportsTemperature(model: string): boolean {
  return !/^(o1|o2|o3|o4|gpt-5)/i.test(model);
}

function validateModelName(modelName: string): void {
  const model = modelName.trim();
  if (!model || model.length === 0) {
    throw new ConfigError("OpenAI model name cannot be empty");
  }
  if (model.length > 100) {
    throw new ConfigError(
      `OpenAI model name too long (max 100 chars): ${model.slice(0, 50)}...`,
    );
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new ConfigError(`Invalid characters in OpenAI model name: ${model}`);
  }
}
