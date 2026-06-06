type PlannedCommit = import("./types.js").PlannedCommit;

/**
 * Deep-clone planned commits so caches and persisted bundles do not share
 * mutable planner state across read and write boundaries.
 *
 * @param plan - Planned commits to clone.
 * @returns Fully cloned planned commits.
 */
export function clonePlannedCommits(plan: PlannedCommit[]): PlannedCommit[] {
  return plan.map((group) => ({
    files: group.files.map((file) => ({
      ...(file.hunks ? { hunks: [...file.hunks] } : {}),
      path: file.path,
    })),
    message: group.message,
  }));
}
