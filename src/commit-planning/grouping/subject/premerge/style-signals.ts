import { isSupportLikePath } from "../../../path/index.js";
import { type PlannedCommit } from "../../grouping-types.js";
import { getPathOwnerDescriptor } from "../../ownership.js";
import { hasHighWordOverlap } from "../analysis.js";
import {
  getSingleTopLevelArea,
  hasSmallFollowUpFootprint,
} from "./structural-signals.js";

/**
 * Style-only support sweeps can merge together, and a tiny same-path style
 * shard can also attach back to the owning rollout before later planning.
 */
export function shouldPremergeStyleGroups(
  leftGroup: PlannedCommit,
  rightGroup: PlannedCommit,
  leftSubject: { type: string; words: Set<string> },
  rightSubject: { type: string; words: Set<string> },
): boolean {
  if (leftSubject.type === "style" && rightSubject.type === "style") {
    const leftArea = getSingleTopLevelArea(leftGroup);
    const sharedArea =
      leftArea !== null && leftArea === getSingleTopLevelArea(rightGroup);
    const sharedSupportArea =
      sharedArea &&
      leftGroup.files.every((file) => isSupportLikePath(file.path)) &&
      rightGroup.files.every((file) => isSupportLikePath(file.path));

    return (
      sharedSupportArea ||
      hasHighWordOverlap(leftSubject.words, rightSubject.words)
    );
  }

  return (
    (leftSubject.type === "style" &&
      isSharedSupportStyleFollowUp(leftGroup, rightGroup)) ||
    (rightSubject.type === "style" &&
      isSharedSupportStyleFollowUp(rightGroup, leftGroup))
  );
}

function getParentDir(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(0, lastSlash) : "";
}

/**
 * Tiny style shards — whether support or implementation — that touch the
 * same owner path or the same directory as the owner rollout are almost
 * always formatting follow-ups rather than standalone work.
 */
function isSharedSupportStyleFollowUp(
  styleGroup: PlannedCommit,
  ownerGroup: PlannedCommit,
): boolean {
  if (!hasSmallFollowUpFootprint(styleGroup)) {
    return false;
  }

  const ownerPaths = new Set(ownerGroup.files.map((file) => file.path));

  // Support-path style shard that shares an exact file with the owner.
  if (
    styleGroup.files.every((file) => isSupportLikePath(file.path)) &&
    styleGroup.files.some((file) => ownerPaths.has(file.path))
  ) {
    return true;
  }

  // A single-file implementation-path style shard (e.g. a trailing-newline
  // fix) can also follow up an implementation rollout when the shard's file
  // lives in a named sub-package below its feature boundary AND at least one
  // of the owner's non-support files is in the exact same directory.
  // Requiring the style shard to sit below its feature boundary (parentDir ≠
  // featureRoot) prevents broad top-level containers such as src/cli/ from
  // being treated as the matching unit and incorrectly pulling in unrelated
  // commits that merely share the same flat module root.
  if (
    styleGroup.files.length === 1 &&
    styleGroup.files.every((file) => !isSupportLikePath(file.path)) &&
    styleGroup.files.every((file) => {
      const styleDir = getParentDir(file.path);
      const { featureRoot } = getPathOwnerDescriptor(file.path);
      // The style shard must live in a proper named sub-package of the feature
      // root (parentDir is a sub-directory of featureRoot, not equal to it or
      // shallower).  This rejects: files at the repository root (styleDir is
      // empty), files directly at the module level (e.g. src/cli/foo.ts where
      // styleDir="src/cli"===featureRoot), and files whose broad container
      // makes featureRoot include the filename itself (e.g. src/b.ts where
      // featureRoot="src/b.ts" but styleDir="src", shallower than featureRoot).
      if (!styleDir.startsWith(`${featureRoot}/`)) {
        return false;
      }
      return ownerGroup.files.some(
        (ownerFile) =>
          !isSupportLikePath(ownerFile.path) &&
          getParentDir(ownerFile.path) === styleDir,
      );
    })
  ) {
    return true;
  }

  return false;
}
