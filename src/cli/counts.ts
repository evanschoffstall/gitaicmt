export function formatCount(value: number): string {
  return String(value);
}

export function formatRequestCount(value: number): string {
  return `${formatCount(value)} request(s)`;
}

export function formatStageUsageLabel(stage: string): string {
  switch (stage) {
    case "cluster": {
      return "merge-review";
    }
    case "consolidate": {
      return "final-consolidation";
    }
    case "generate": {
      return "message-draft";
    }
    case "group": {
      return "grouping";
    }
    case "merge": {
      return "message-merge";
    }
    default: {
      return stage;
    }
  }
}

export function formatTokenWarning(tokenWarningThreshold: number): string {
  return `Estimated token usage may exceed threshold (${formatCount(tokenWarningThreshold)}).`;
}

export function isHighTokenEstimate(
  estimate: { peakRequestTokens: number; totalTokens: number },
  tokenWarningThreshold: number,
): boolean {
  return (
    tokenWarningThreshold > 0 &&
    (estimate.totalTokens >= tokenWarningThreshold ||
      estimate.peakRequestTokens >= tokenWarningThreshold)
  );
}
