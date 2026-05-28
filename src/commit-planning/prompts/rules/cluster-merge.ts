import {
  sameFileMergeCueRules,
  semanticMergeBoundaryRules,
  styleSweepMergeRules,
} from "./semantic-planning.js";

/** Returns the required output contract for the cluster-merge response. */
export function clusterMergeOutputRules(): string[] {
  return ["Return clusters as JSON array of index arrays: [[...],[...],...]"];
}

/** Returns the complete system-rule block for semantic cluster merging. */
export function clusterMergeSystemRules(): string[] {
  return [
    "You are grouping git commit messages into semantic clusters.",
    "Each cluster contains commits that belong to the same overarching change.",
    ...semanticMergeBoundaryRules("cluster"),
    ...sameFileMergeCueRules("cluster"),
    ...styleSweepMergeRules("cluster"),
    "Keep unrelated features, bug fixes, and major refactors separate.",
    "Return ONLY valid JSON: an array of arrays of 0-based commit indices.",
    "Every index from 0 to N-1 must appear exactly once.",
    "Minimal example: [[0,2],[1],[3,4]]",
  ];
}

/** Returns the reusable user-prompt rules for semantic cluster merging. */
export function clusterMergeUserRules(): string[] {
  return [
    "Merge commits that are part of the same overarching change.",
    "Do not create umbrella implementation clusters that only share a subsystem, rollout label, or planner stage.",
    "Prefer support-into-owner clusters over merging multiple independent implementation commits together.",
    ...semanticMergeBoundaryRules("cluster"),
  ];
}
