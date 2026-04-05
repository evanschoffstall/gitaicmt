import { ConfigError, OpenAIError, OpenAITimeoutError } from "../application/errors.js";

interface CompleteOptions {
  maxTokens?: number;
  stage?: TokenUsageStage;
  temperature?: number;
  timeoutMs?: number;
}

type Config = import("../application/config/index.js").Config;

type TokenUsageStage =
  | "cluster"
  | "consolidate"
  | "generate"
  | "group"
  | "merge";

export function buildCompletionRequest(
  cfg: Config,
  options?: CompleteOptions,
): {
  maxTokens: number;
  signal: AbortSignal | undefined;
  stage?: TokenUsageStage;
  temperature: number;
  timeoutMs: number;
} {
  const timeoutMs = options?.timeoutMs ?? cfg.performance.timeoutMs;
  return {
    maxTokens: options?.maxTokens ?? cfg.openai.maxTokens,
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    stage: options?.stage,
    temperature: options?.temperature ?? cfg.openai.temperature,
    timeoutMs,
  };
}

export function isNonChatModelError(err: unknown): boolean {
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? err.message
      : err;
  const normalizedMessage = String(message).toLowerCase();
  return (
    normalizedMessage.includes("not a chat model") ||
    normalizedMessage.includes("not supported in the v1/chat/completions")
  );
}

export function readChatContent(res: {
  choices?: { message?: { content?: null | string } }[];
}): string {
  const content = res.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  throw new OpenAIError("API returned empty or invalid response");
}

export function rethrowTimeoutError(error: unknown, timeoutMs: number): void {
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("timeout"))
  ) {
    throw new OpenAITimeoutError(timeoutMs);
  }
}

export function supportsTemperature(model: string): boolean {
  return !/^(o1|o2|o3|o4|gpt-5)/i.test(model);
}

export function toOpenAiCallError(error: unknown): OpenAIError {
  if (error instanceof Error) {
    return new OpenAIError(`OpenAI API call failed: ${error.message}`, error);
  }
  return new OpenAIError(`OpenAI API call failed: ${String(error)}`);
}

export function validateModelName(modelName: string): void {
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