import { type FileDiff, type PlannedCommit } from "../grouping-types.js";
import { getNormalizedSubjectDescriptionKey } from "../subject/analysis.js";
import { mergeCommitClusters } from "./merge.js";

/**
 * Minimum word count for a description key to participate in prefix-based
 * merge matching. Prevents accidental merging of short generic descriptions
 * that happen to share a common prefix (e.g. "fix tests").
 */
const MIN_PREFIX_MERGE_WORD_COUNT = 4;

/**
 * Minimum word count required for the secondary (post-consolidation) exact-key
 * merge pass in {@link finalizeStabilizedGroups}. The secondary pass runs after
 * repartition and message harmonization; requiring one more word than the prefix
 * threshold prevents short descriptions that coincidentally converge through
 * harmonization (e.g. "tighten merge planning rules", 4 words) from triggering
 * a spurious merge across genuinely distinct change families that repartition
 * already separated. Descriptions specific enough to be unambiguous
 * (≥5 tokens) are trusted as true duplicates.
 */
export const MIN_SECONDARY_EXACT_MERGE_WORD_COUNT =
  MIN_PREFIX_MERGE_WORD_COUNT + 1;

/**
 * Returns true when the shorter of the two descriptions is a word-level prefix
 * of the longer. Both descriptions must have at least MIN_PREFIX_MERGE_WORD_COUNT
 * words so that short generic descriptions do not merge spuriously.
 */
export function areDescriptionsRelatedByPrefix(a: string, b: string): boolean {
  const aWords = a.split(" ");
  const bWords = b.split(" ");
  const [shorter, longer] =
    aWords.length <= bWords.length ? [aWords, bWords] : [bWords, aWords];
  if (shorter.length < MIN_PREFIX_MERGE_WORD_COUNT) return false;
  return shorter.every((word, i) => longer[i] === word);
}

/**
 * Applies a two-pass subject merge to a set of post-absorption commit groups:
 *
 * 1. Primary pass — uses original batch subjects as authority so that
 *    harmonization rewrites do not create false merges.
 * 2. Secondary pass — catches remaining groups whose FINAL normalized
 *    descriptions are identical (e.g. impl + test files assigned the same
 *    description across separate AI batches). Uses
 *    {@link MIN_SECONDARY_EXACT_MERGE_WORD_COUNT} to avoid collapsing short
 *    descriptions that coincidentally converged through harmonization.
 */
export function buildStabilizedSubjectMerge(
  absorbed: PlannedCommit[],
  originalGroups: PlannedCommit[] | undefined,
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const primary = originalGroups
    ? mergeGroupsByOriginalSubject(absorbed, originalGroups, fileByPath)
    : mergeGroupsByNormalizedSubject(absorbed, fileByPath);
  if (primary.length <= 1 || !originalGroups) {
    return primary;
  }
  const secondary = mergeGroupsByNormalizedSubject(
    primary,
    fileByPath,
    MIN_SECONDARY_EXACT_MERGE_WORD_COUNT,
  );
  return secondary.length < primary.length ? secondary : primary;
}

export function mergeGroupsByNormalizedSubject(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
  minExactMatchWordCount = 0,
): PlannedCommit[] {
  if (groups.length < 2) {
    return groups;
  }

  // Use description-only keys (strip type and scope) so commits like
  // `fix(grouping): anchor support files` and `test(ai): anchor support files`
  // merge correctly even when their conventional-commit type differs.
  const subjectKeys = groups.map((group) =>
    getNormalizedSubjectDescriptionKey(group.message.split("\n")[0] ?? ""),
  );
  const clusters = buildSameSubjectClusters(
    subjectKeys,
    minExactMatchWordCount,
  );
  if (!clusters.some((cluster) => cluster.length > 1)) {
    return groups;
  }

  return mergeCommitClusters(groups, clusters, fileByPath);
}

/**
 * Merges same-subject groups using ORIGINAL input messages as the authority
 * for which groups are eligible to merge. A pair of final groups can merge only
 * when their files all come from original groups whose normalized subjects match.
 * This prevents false merges caused by post-consolidation message harmonization.
 */
export function mergeGroupsByOriginalSubject(
  groups: PlannedCommit[],
  originalGroups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  if (groups.length < 2 || originalGroups.length < 2) {
    return groups;
  }

  // Build a map from each file path → normalized subject key from the ORIGINAL groups.
  // When the same file appears in multiple original groups (e.g. different hunks),
  // mark the path as ambiguous (null) so it never drives an eligible merge.
  const fileToOriginalKey = new Map<string, null | string>();
  for (const og of originalGroups) {
    const key = getNormalizedSubjectDescriptionKey(
      og.message.split("\n")[0] ?? "",
    );
    for (const file of og.files) {
      const existing = fileToOriginalKey.get(file.path);
      if (existing === undefined) {
        fileToOriginalKey.set(file.path, key);
      } else if (existing !== null && existing !== key) {
        // Same path appears under multiple distinct original subjects → ambiguous.
        fileToOriginalKey.set(file.path, null);
      }
    }
  }

  // Derive a representative original-subject key for each final group.
  // A group is eligible for same-subject merge only when ALL of its files
  // agree on the same original-subject key (no cross-topic merging).
  const groupOriginalKeys: (null | string)[] = groups.map((group) => {
    const keys = new Set<string>();
    for (const file of group.files) {
      const k = fileToOriginalKey.get(file.path);
      // Ambiguous (null) or unknown (undefined) → ineligible
      if (k === null || k === undefined) return null;
      keys.add(k);
    }
    return keys.size === 1 ? ([...keys][0] ?? null) : null;
  });

  const clusters = buildSameSubjectClusters(
    groupOriginalKeys.map((k, i) => k ?? `\x00ineligible-${i}`),
  );

  // Discard cluster entries for groups with ineligible (mixed-origin) keys.
  // Only keep multi-element clusters where all members have a non-null key.
  const multiElementValidClusters = clusters
    .map((cluster) => cluster.filter((i) => groupOriginalKeys[i] !== null))
    .filter((cluster) => cluster.length > 1);

  if (multiElementValidClusters.length === 0) {
    return groups;
  }

  // Build the final cluster list: valid multi-element clusters plus
  // all remaining groups as singletons (preserving original order).
  const mergedIndexes = new Set(multiElementValidClusters.flat());
  const allClusters = [
    ...multiElementValidClusters,
    ...groups
      .map((_, i) => i)
      .filter((i) => !mergedIndexes.has(i))
      .map((i) => [i]),
  ];
  // Sort clusters so groups come out in original order.
  allClusters.sort((a, b) => Math.min(...a) - Math.min(...b));

  return mergeCommitClusters(groups, allClusters, fileByPath);
}

function buildSameSubjectClusters(
  subjectKeys: string[],
  minExactMatchWordCount = 0,
): number[][] {
  const { find, union } = buildUnionFind(subjectKeys.length);

  const keyToFirstIndex = new Map<string, number>();
  for (let i = 0; i < subjectKeys.length; i++) {
    const key = subjectKeys[i] ?? "";
    if (!key) continue;
    if (
      minExactMatchWordCount > 0 &&
      key.split(" ").length < minExactMatchWordCount
    ) {
      continue;
    }
    const existing = keyToFirstIndex.get(key);
    if (existing !== undefined) union(existing, i);
    else keyToFirstIndex.set(key, i);
  }

  const distinctEntries = [...keyToFirstIndex.entries()];
  for (let a = 0; a < distinctEntries.length; a++) {
    for (let b = a + 1; b < distinctEntries.length; b++) {
      const [keyA, idxA] = distinctEntries[a];
      const [keyB, idxB] = distinctEntries[b];
      if (areDescriptionsRelatedByPrefix(keyA, keyB)) union(idxA, idxB);
    }
  }

  return collectClusters(subjectKeys.length, find);
}

/**
 * Groups commit indices into clusters where every pair shares the same
 * normalized subject description, using two merge signals:
 *
 * 1. Exact key equality — `fix: anchor support files` and
 *    `test: anchor support files` share the same description.
 * 2. Word-prefix relationship — `add resume parsing` is a prefix of
 *    `add resume parsing and strict hash checks`, so they merge when the
 *    shorter description has at least MIN_PREFIX_MERGE_WORD_COUNT words.
 */
function buildUnionFind(size: number): {
  find: (i: number) => number;
  union: (i: number, j: number) => void;
} {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      const mid = parent[i];
      parent[i] = parent[mid];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };
  return { find, union };
}

function collectClusters(
  count: number,
  find: (i: number) => number,
): number[][] {
  const clusterByRoot = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const cluster = clusterByRoot.get(root);
    if (cluster) cluster.push(i);
    else clusterByRoot.set(root, [i]);
  }
  return [...clusterByRoot.values()];
}
