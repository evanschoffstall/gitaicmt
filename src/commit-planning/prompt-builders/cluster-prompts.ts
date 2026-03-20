/** Cluster system and user prompt builders. */
import { formatScalar } from "../../commit-messages/formatting.js";

type PlannedCommit = import("../types.js").PlannedCommit;

/** Returns the system prompt for the AI cluster-merge step. */
export function buildClusterSystemPrompt(): string {
  return [
    "You are grouping git commit messages into semantic clusters.",
    "Each cluster contains commits that belong to the same overarching change.",
    "Reduce fragmentation, but preserve distinct implementation whys even when that costs one extra cluster.",
    "Merge same-feature source/test/docs/config work, same-file fragments, rename sweeps, and tooling rollouts.",
    "Do NOT merge multiple implementation commits into one umbrella cluster just because they touch the same subsystem, rollout, or planner stage.",
    "Prefer support-into-owner clusters over owner-to-owner umbrella clusters when several changes only share a broad theme.",
    "If a cluster would likely need to be split back into mostly the same implementation commits to explain ownership clearly, keep those commits separate now.",
    "ALL style, import-order, formatting, and whitespace-only commits should collapse into ONE cluster when possible.",
    "Keep unrelated features, bug fixes, and major refactors separate.",
    "Return ONLY valid JSON: an array of arrays of 0-based commit indices.",
    "Every index from 0 to N-1 must appear exactly once.",
    "Minimal example: [[0,2],[1],[3,4]]",
  ].join("\n");
}

/** Returns the user prompt for the AI cluster-merge step. */
export function buildClusterUserPrompt(groups: PlannedCommit[]): string {
  const lines = groups.map(
    (g, i) => `${formatScalar(i)}: ${g.message.split("\n")[0]}`,
  );
  return [
    `Cluster these ${formatScalar(groups.length)} commits into semantic groups.`,
    "Merge commits that are part of the same overarching change.",
    "Do not create umbrella implementation clusters that only share a subsystem, rollout label, or planner stage.",
    "Prefer support-into-owner clusters over merging multiple independent implementation commits together.",
    "If the clustered result would likely need to be split back into mostly the same commits for ownership clarity, keep it split now.",
    "",
    ...lines,
    "",
    "Return clusters as JSON array of index arrays: [[...],[...],...]",
  ].join("\n");
}
