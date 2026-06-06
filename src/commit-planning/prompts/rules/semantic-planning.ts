/** Shared semantic planning rules for grouping, clustering, and consolidation prompts. */

export type SemanticPlanningUnit = "cluster" | "commit";

/** Returns the unit-aware noun used when a rule talks about existing plan items. */
export function describePlanItems(unit: SemanticPlanningUnit): string {
  return unit === "cluster" ? "clusters" : "commits";
}

/** Returns universal same-file merge cue rules for planning prompts. */
export function sameFileMergeCueRules(unit: SemanticPlanningUnit): string[] {
  return unit === "cluster"
    ? [
        "Merge same-feature source/test/docs/config work, same-file fragments, rename sweeps, and tooling rollouts.",
      ]
    : [
        "If two commits modify different hunks of the SAME file, treat that as a merge cue only when the result still reads as one clear reason for change; keep them separate when the hunks support independent features or workflows.",
      ];
}

/** Returns universal merge boundaries shared by cluster and consolidation prompts. */
export function semanticMergeBoundaryRules(
  unit: SemanticPlanningUnit,
): string[] {
  const items = describePlanItems(unit);
  return [
    `Reduce fragmentation, but preserve distinct implementation whys even when that costs one extra ${unit}.`,
    `Do NOT merge multiple implementation commits into one umbrella ${unit} just because they touch the same subsystem, rollout, or planner stage.`,
    `Prefer support-into-owner ${items} over owner-to-owner umbrella ${items} when several changes only share a broad theme.`,
    `If a ${unit} would likely need to be split back into mostly the same implementation commits to explain ownership clearly, keep those commits separate now.`,
  ];
}

/** Returns universal style-sweep collapse rules for planning prompts. */
export function styleSweepMergeRules(unit: SemanticPlanningUnit): string[] {
  return unit === "cluster"
    ? [
        "ALL style, import-order, formatting, and whitespace-only commits should collapse into ONE cluster when possible.",
      ]
    : [
        "Standalone style/import-order/formatting commits should be rare and kept only when they are broad independent sweeps across otherwise unrelated files.",
        "Collapse ALL style, import-order, formatting, and whitespace-only sweep commits into as few commits as possible regardless of their position in the plan. Multiple style-sweep commits should reduce to 1-2 commits maximum.",
      ];
}

/** Returns universal support-work merge rules for planning prompts. */
export function supportWorkMergeRules(unit: SemanticPlanningUnit): string[] {
  const items = unit === "cluster" ? describePlanItems(unit) : "merges";
  return [
    `Prefer support-into-owner ${items} over owner-to-owner umbrella ${items}; tests, docs, config, and cleanup should collapse into the implementation they support, not into broad multi-reason rollups.`,
    "When merging a support commit into an implementation commit, keep the implementation or workflow subject and move support details into body bullets.",
  ];
}
