import type { PlannedCommit, PlannedCommitFile } from "./ai.js";

/**
 * Detect whether two PlannedCommitFile references for the SAME path overlap.
 * Overlap means they would try to stage conflicting content:
 *   - either is whole-file (no hunks array) → they overlap
 *   - both specify hunks  → overlap only if any hunk index appears in both
 */
export function fileRefsOverlap(
  a: PlannedCommitFile,
  b: PlannedCommitFile,
): boolean {
  // Either side is whole-file → always overlaps
  if (!a.hunks || a.hunks.length === 0) return true;
  if (!b.hunks || b.hunks.length === 0) return true;
  // Both have explicit hunks — overlap only if they share a hunk index
  const setA = new Set(a.hunks);
  return b.hunks.some((h) => setA.has(h));
}

/**
 * Deduplicate commits that would produce staging conflicts.
 *
 * For each incoming commit, each file is checked against all already-processed
 * commits.  Only the CONFLICTING FILE is resolved — non-conflicting files in
 * the same incoming commit survive as their own new commit.  This means the
 * common case of the AI accidentally assigning the same file to two commits
 * results in the duplicate being silently dropped rather than merging the
 * entire second commit (with its unrelated files) into the first.
 *
 * Resolution rules per file:
 *  - existing covers it fully (whole-file or same/superset hunks): drop it
 *  - incoming is whole-file but existing is hunked: promote existing to
 *    whole-file, drop incoming
 *  - both hunked with partial overlap: incoming keeps only uncovered hunks
 *
 * Commits that touch the same file at completely DIFFERENT hunks are left
 * separate — hunk-level patch staging handles them correctly.
 */
export function mergeCommitsByFile(groups: PlannedCommit[]): PlannedCommit[] {
  // fileRefs[i] maps path → PlannedCommitFile for merged group i
  const fileRefs: Map<string, PlannedCommitFile>[] = [];
  const merged: PlannedCommit[] = [];

  for (const group of groups) {
    const survivingFiles: PlannedCommitFile[] = [];

    for (const f of group.files) {
      // Walk through the file resolution, potentially shrinking it
      let resolved: null | PlannedCommitFile = { ...f };

      for (let i = 0; i < merged.length && resolved !== null; i++) {
        const existing = fileRefs[i].get(f.path);
        if (!existing) continue;
        if (!fileRefsOverlap(existing, resolved)) continue;

        const { existingPromotion, incomingRemainder } = resolveFileConflict(
          existing,
          resolved,
        );

        // Apply promotion to the existing group if needed
        if (existingPromotion !== null) {
          const idx = merged[i].files.findIndex((tf) => tf.path === f.path);
          if (idx >= 0) merged[i].files[idx] = existingPromotion;
          fileRefs[i].set(f.path, existingPromotion);
        }

        resolved = incomingRemainder;
      }

      if (resolved !== null) {
        survivingFiles.push(resolved);
      }
    }

    if (survivingFiles.length > 0) {
      // At least one file survived — create a new group with the original message
      const newGroup: PlannedCommit = {
        files: survivingFiles,
        message: group.message,
      };
      merged.push(newGroup);
      const refs = new Map<string, PlannedCommitFile>();
      for (const f of survivingFiles) refs.set(f.path, { ...f });
      fileRefs.push(refs);
    }
    // All files covered elsewhere → drop this group entirely
  }

  return merged;
}

/**
 * Given an already-committed file reference `existing` and an incoming one for
 * the same path, return how to resolve the conflict surgically.
 *
 * Returns:
 *  - `existingPromotion`: if non-null, replace the existing entry with this
 *    (used to promote a hunked entry to whole-file when incoming is whole-file)
 *  - `incomingRemainder`: the file entry the incoming commit should keep after
 *    removing covered content. Null = fully absorbed, drop the file entirely.
 */
function resolveFileConflict(
  existing: PlannedCommitFile,
  incoming: PlannedCommitFile,
): {
  existingPromotion: null | PlannedCommitFile;
  incomingRemainder: null | PlannedCommitFile;
} {
  const existingWhole = !existing.hunks || existing.hunks.length === 0;
  const incomingWhole = !incoming.hunks || incoming.hunks.length === 0;

  if (existingWhole) {
    // Existing whole-file already covers everything → drop incoming entirely
    return { existingPromotion: null, incomingRemainder: null };
  }

  if (incomingWhole) {
    // Incoming wants the whole file but existing only has specific hunks.
    // Promote existing to whole-file (it now owns all changes), drop incoming.
    return {
      existingPromotion: { path: existing.path },
      incomingRemainder: null,
    };
  }

  // Both have explicit hunks — remove the ones already covered by `existing`
  const coveredSet = new Set(existing.hunks);
  const incomingHunks = incoming.hunks ?? [];
  const remaining = incomingHunks.filter((h) => !coveredSet.has(h));

  if (remaining.length === 0) {
    // All incoming hunks are already covered → drop incoming entirely
    return { existingPromotion: null, incomingRemainder: null };
  }

  // Some hunks remain → incoming keeps only the uncovered ones
  return {
    existingPromotion: null,
    incomingRemainder: { ...incoming, hunks: remaining },
  };
}
