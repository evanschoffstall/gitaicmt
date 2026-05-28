export type {
  BreakingChangeMode,
  CommitMessageRuleOptions,
} from "./rules/index.js";
export { resolveBreakingChangeMode } from "./rules/index.js";
/** Public entry point - re-exports all prompt builder functions. */
export {
  buildClusterSystemPrompt,
  buildClusterUserPrompt,
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
  buildGroupingSystemPrompt,
  buildGroupingUserPrompt,
  buildMergePrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "./stages/index.js";
export type { GroupingPromptContext } from "./stages/index.js";
