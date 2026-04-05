import type { loadConfig } from "../../application/config/index.js";
import type { TokenEstimateSummary } from "../../commit-planning/orchestration.js";

import {
  getTokenUsageByStage,
  getTokenUsageSummary,
  validateOpenAIConfiguration,
} from "../../commit-planning/orchestration.js";
import { formatTokenWarning, isHighTokenEstimate } from "../counts.js";
import { promptYesNo } from "../interactive-prompt.js";
import { buildReadyPromptLines } from "../output-presentation.js";
import {
  log,
  logActualTokenUsage,
  logGenerationContext,
} from "../session-display.js";
import { resolveLogWidth } from "../viewport.js";

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";

export interface TokenCheckOptions {
  skipPrompt: boolean;
}

export async function confirmCommitPlan(
  autoConfirm: boolean,
  plannedCommitCount: number,
): Promise<boolean> {
  if (autoConfirm) {
    return true;
  }

  logActualTokenUsage(getTokenUsageSummary(), getTokenUsageByStage());
  const confirmed = await promptYesNo(
    buildReadyPromptLines(plannedCommitCount, resolveLogWidth()).join("\n"),
  );
  if (!confirmed) {
    log(`${YELLOW}Aborted.${RESET}`);
    return false;
  }
  log("");
  return true;
}

export async function confirmTokenCheckedGeneration(
  cfg: ReturnType<typeof loadConfig>,
  stats: {
    additions: number;
    chunks: number;
    deletions: number;
    filesChanged: number;
  },
  tokenEstimate: TokenEstimateSummary,
  skipTokenCheck: boolean,
): Promise<boolean> {
  const shouldPrompt = shouldPromptForHighTokenUsage(tokenEstimate, cfg, {
    skipPrompt: skipTokenCheck,
  });
  logGenerationContext(
    cfg.openai.model,
    stats,
    tokenEstimate,
    cfg.analysis.tokenWarningThreshold,
    shouldPrompt,
  );

  return confirmTokenCheckedOperation(tokenEstimate, cfg, {
    skipPrompt: skipTokenCheck,
  });
}

export async function confirmTokenUsage(
  estimate: TokenEstimateSummary,
  cfg: ReturnType<typeof loadConfig>,
  options: TokenCheckOptions,
): Promise<boolean> {
  if (!shouldPromptForHighTokenUsage(estimate, cfg, options)) {
    return true;
  }

  return promptYesNo(
    `${YELLOW}${formatTokenWarning(cfg.analysis.tokenWarningThreshold)} ${BOLD}Continue?${RESET}`,
  );
}

export function shouldPromptForHighTokenUsage(
  estimate: TokenEstimateSummary,
  cfg: ReturnType<typeof loadConfig>,
  options: TokenCheckOptions,
): boolean {
  return (
    !options.skipPrompt &&
    cfg.analysis.promptOnTokenWarning &&
    isHighTokenEstimate(estimate, cfg.analysis.tokenWarningThreshold)
  );
}

async function confirmTokenCheckedOperation(
  estimate: TokenEstimateSummary,
  cfg: ReturnType<typeof loadConfig>,
  options: TokenCheckOptions,
): Promise<boolean> {
  if (!(await confirmTokenUsage(estimate, cfg, options))) {
    log(`${YELLOW}Aborted.${RESET}`);
    return false;
  }

  validateOpenAIConfiguration();
  return true;
}