/** Cluster system and user prompt builders. */
import { formatScalar } from "../../../commit-messages/formatting.js";
import {
  clusterMergeOutputRules,
  clusterMergeSystemRules,
  clusterMergeUserRules,
} from "../rules/index.js";

type PlannedCommit = import("../../types.js").PlannedCommit;

/** Returns the system prompt for the AI cluster-merge step. */
export function buildClusterSystemPrompt(): string {
  return clusterMergeSystemRules().join("\n");
}

/** Returns the user prompt for the AI cluster-merge step. */
export function buildClusterUserPrompt(groups: PlannedCommit[]): string {
  const lines = groups.map(
    (g, i) => `${formatScalar(i)}: ${g.message.split("\n")[0]}`,
  );
  return [
    `Cluster these ${formatScalar(groups.length)} commits into semantic groups.`,
    ...clusterMergeUserRules(),
    "",
    ...lines,
    "",
    ...clusterMergeOutputRules(),
  ].join("\n");
}
