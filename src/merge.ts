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
 * Merge commits that would produce staging conflicts.
 * Two commits conflict when they reference the same file AND their hunk ranges
 * overlap (or either uses whole-file staging).
 * Commits that touch the same file at DIFFERENT hunks are left separate —
 * hunk-level patch staging handles them correctly.
 */
export function mergeCommitsByFile(groups: PlannedCommit[]): PlannedCommit[] {
  // fileRefs[i] maps path → PlannedCommitFile for merged group i
  const fileRefs: Map<string, PlannedCommitFile>[] = [];
  const merged: PlannedCommit[] = [];

  for (const group of groups) {
    // Find the first existing merged group that conflicts with this one
    let mergeIntoIndex: number | null = null;
    outer: for (let i = 0; i < merged.length; i++) {
      const refs = fileRefs[i];
      for (const f of group.files) {
        const existing = refs.get(f.path);
        if (existing && fileRefsOverlap(existing, f)) {
          mergeIntoIndex = i;
          break outer;
        }
      }
    }

    if (mergeIntoIndex !== null) {
      // Merge into conflicting group — preserve hunks where possible
      const target = merged[mergeIntoIndex];
      const refs = fileRefs[mergeIntoIndex];
      for (const f of group.files) {
        const existing = refs.get(f.path);
        if (!existing) {
          // New file for this group — add as-is, preserving hunks
          target.files.push({ ...f });
          refs.set(f.path, { ...f });
        } else {
          // Conflicting file: promote to whole-file (safe superset)
          const idx = target.files.findIndex((tf) => tf.path === f.path);
          if (idx >= 0) {
            target.files[idx] = { path: f.path }; // whole-file
          }
          refs.set(f.path, { path: f.path });
        }
      }
      target.message = target.message + "\n\n" + group.message;
    } else {
      // No conflict — add as a new group, preserving all hunk info
      const newGroup: PlannedCommit = {
        files: group.files.map((f) => ({ ...f })),
        message: group.message,
      };
      merged.push(newGroup);
      const refs = new Map<string, PlannedCommitFile>();
      for (const f of newGroup.files) refs.set(f.path, { ...f });
      fileRefs.push(refs);
    }
  }

  return merged;
}
