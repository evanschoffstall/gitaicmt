type TokenUsageStage =
  | "cluster"
  | "consolidate"
  | "generate"
  | "group"
  | "merge";

interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  totalTokens: number;
}

export function createEmptyTokenUsageByStage(): Record<
  TokenUsageStage,
  TokenUsageSummary
> {
  return {
    cluster: createEmptyTokenUsageSummary(),
    consolidate: createEmptyTokenUsageSummary(),
    generate: createEmptyTokenUsageSummary(),
    group: createEmptyTokenUsageSummary(),
    merge: createEmptyTokenUsageSummary(),
  };
}

export function createEmptyTokenUsageSummary(): TokenUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    totalTokens: 0,
  };
}

export function extractTokenUsage(
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

  const inputTokens = readTokenUsageValue(
    usage.input_tokens,
    usage.prompt_tokens,
  );
  const outputTokens = readTokenUsageValue(
    usage.output_tokens,
    usage.completion_tokens,
  );
  const totalTokens =
    readUsageNumber(usage.total_tokens) ?? inputTokens + outputTokens;

  return inputTokens === 0 && outputTokens === 0 && totalTokens === 0
    ? null
    : { inputTokens, outputTokens, totalTokens };
}

export function mergeTokenUsageSummary(
  current: TokenUsageSummary,
  usage: Omit<TokenUsageSummary, "requestCount">,
): TokenUsageSummary {
  return {
    inputTokens: current.inputTokens + usage.inputTokens,
    outputTokens: current.outputTokens + usage.outputTokens,
    requestCount: current.requestCount + 1,
    totalTokens: current.totalTokens + usage.totalTokens,
  };
}

function readTokenUsageValue(primary: unknown, fallback: unknown): number {
  return readUsageNumber(primary ?? fallback) ?? 0;
}

function readUsageNumber(value: unknown): null | number {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
