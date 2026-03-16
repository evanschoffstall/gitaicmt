import { complete } from "./ai-client.js";
import {
  buildClusterSystemPrompt,
  buildClusterUserPrompt,
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
} from "./ai-prompt-builders.js";
import { type PlannedCommit, type PlannedCommitFile } from "./ai-types.js";
import { validateAndNormalizeGrouping } from "./ai-validation.js";
import {
  CLUSTERING_THRESHOLD,
  MAX_CLUSTER_PASSES,
  MAX_CONSOLIDATION_PASSES,
} from "./constants.js";
import { ValidationError } from "./errors.js";

type FileDiff = import("./diff.js").FileDiff;

export async function finalizePlannedGroups(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
): Promise<PlannedCommit[]> {
  if (groups.length < 2) {
    return groups;
  }

  const fileByPath = new Map(allFiles.map((file) => [file.path, file]));

  // Phase 0: deterministic pre-merge — collapse commits with the same
  // conventional-commit type whose descriptions share ≥50% of their
  // significant words. This catches the "8 identical style-sweep commits"
  // pattern without any AI call.
  let current = premergeBySubject(groups, fileByPath);

  // Phase 1: iterative AI semantic clustering (messages-only → index arrays).
  // Each pass further reduces the plan; stops when no progress or cap reached.
  current = await clusterAndMerge(current, fileByPath);

  // Phase 2: traditional AI consolidation on the (now-reduced) plan
  for (
    let pass = 0;
    pass < MAX_CONSOLIDATION_PASSES && current.length > 1;
    pass++
  ) {
    const previousLength = current.length;
    const consolidated = await consolidateOnce(allFiles, current, fileByPath);

    if (!consolidated) {
      break; // consolidation failed this pass; keep what we have
    }

    current = consolidated;
    if (consolidated.length >= previousLength) {
      break;
    }
    if (consolidated.length <= 2) {
      break;
    }
  }

  return current;
}

// ─── Clustering ──────────────────────────────────────────────────────────────

function applyCommitClusters(
  groups: PlannedCommit[],
  clusters: number[][],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const result: PlannedCommit[] = [];

  for (const cluster of clusters) {
    if (cluster.length === 0) continue;
    if (cluster.length === 1) {
      result.push(groups[cluster[0]]);
      continue;
    }

    // Merge files+hunks from every commit in the cluster
    const commitsToMerge = cluster.map((i) => groups[i]);
    if (commitsToMerge.length === 0) continue;

    // null sentinel = "all hunks for this file"
    const fileHunkMap = new Map<string, null | Set<number>>();

    for (const commit of commitsToMerge) {
      for (const fileRef of commit.files) {
        if (!fileRef.hunks || fileRef.hunks.length === 0) {
          fileHunkMap.set(fileRef.path, null);
        } else if (!fileHunkMap.has(fileRef.path)) {
          fileHunkMap.set(fileRef.path, new Set(fileRef.hunks));
        } else {
          const existing = fileHunkMap.get(fileRef.path);
          if (existing !== null && existing !== undefined) {
            for (const h of fileRef.hunks) existing.add(h);
          }
        }
      }
    }

    // Emit merged file refs in stable insertion order (first seen wins for path order)
    const mergedFiles: PlannedCommitFile[] = [];
    for (const [path, hunks] of fileHunkMap) {
      const file = fileByPath.get(path);
      // If the file has no real hunks (e.g. rename-only), emit without hunks array
      if (!file || file.hunks.length === 0 || hunks === null) {
        mergedFiles.push({ path });
      } else {
        mergedFiles.push({
          hunks: [...hunks].sort((a, b) => a - b),
          path,
        });
      }
    }

    result.push({
      files: mergedFiles,
      message: mergeCommitMessages(commitsToMerge),
    });
  }

  return result;
}

async function callCluster(
  groups: PlannedCommit[],
): Promise<null | number[][]> {
  try {
    const sys = buildClusterSystemPrompt();
    const usr = buildClusterUserPrompt(groups);
    const raw = await complete(sys, usr);
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");
    const parsed = JSON.parse(cleaned) as unknown;

    if (!Array.isArray(parsed)) return null;

    const seen = new Set<number>();
    for (const cluster of parsed) {
      if (!Array.isArray(cluster)) return null;
      for (const idx of cluster) {
        if (typeof idx !== "number" || idx < 0 || idx >= groups.length)
          return null;
        if (seen.has(idx)) return null;
        seen.add(idx);
      }
    }

    // Relaxed validation: add missing indices as singletons instead of
    // rejecting the entire response.  The model often drops a few indices
    // when the plan is large; recovering them here makes clustering far
    // more reliable.
    const clusters = parsed as number[][];
    for (let i = 0; i < groups.length; i++) {
      if (!seen.has(i)) {
        clusters.push([i]);
      }
    }

    // Only proceed if clustering actually reduces the plan
    const nonSingletons = clusters.filter((cluster) => cluster.length > 1);
    if (nonSingletons.length === 0) return null;

    return clusters;
  } catch {
    return null;
  }
}

async function clusterAndMerge(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): Promise<PlannedCommit[]> {
  let current = groups;

  for (
    let pass = 0;
    pass < MAX_CLUSTER_PASSES && current.length >= CLUSTERING_THRESHOLD;
    pass++
  ) {
    const clusters = await callCluster(current);
    if (!clusters) break;

    const merged = applyCommitClusters(current, clusters, fileByPath);
    if (!hasMatchingCoverage(current, merged, fileByPath)) break;
    if (merged.length >= current.length) break;

    current = merged;
  }

  return current;
}

async function consolidateOnce(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): Promise<null | PlannedCommit[]> {
  try {
    const sys = buildConsolidationSystemPrompt();
    const usr = buildConsolidationUserPrompt(allFiles, groups);
    const raw = await complete(sys, usr);
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");
    const parsed = JSON.parse(cleaned) as unknown;
    const consolidated = validateAndNormalizeGrouping(parsed, fileByPath);

    return hasMatchingCoverage(groups, consolidated, fileByPath)
      ? consolidated
      : null;
  } catch {
    return null;
  }
}

// ─── Consolidation ───────────────────────────────────────────────────────────

function getCoverageKeys(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): string[] {
  const keys: string[] = [];

  for (const group of groups) {
    for (const fileRef of group.files) {
      const file = fileByPath.get(fileRef.path);
      if (!file) {
        throw new ValidationError(
          `Missing file for coverage check: ${fileRef.path}`,
        );
      }

      if (fileRef.hunks && fileRef.hunks.length > 0) {
        keys.push(
          ...fileRef.hunks.map((hunk) => `${fileRef.path}#${String(hunk)}`),
        );
        continue;
      }

      if (file.hunks.length === 0) {
        keys.push(`${fileRef.path}#file`);
        continue;
      }

      for (let index = 0; index < file.hunks.length; index++) {
        keys.push(`${fileRef.path}#${String(index)}`);
      }
    }
  }

  keys.sort();
  return keys;
}

function hasMatchingCoverage(
  before: PlannedCommit[],
  after: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): boolean {
  const beforeKeys = getCoverageKeys(before, fileByPath);
  const afterKeys = getCoverageKeys(after, fileByPath);

  // Compare unique key sets — the AI may assign the same hunk to multiple
  // commits, so the raw arrays can legitimately contain duplicates in
  // "before".  The invariant we enforce is: every hunk covered before is
  // still covered after (and vice-versa).
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);

  if (beforeSet.size !== afterSet.size) return false;

  for (const key of beforeSet) {
    if (!afterSet.has(key)) return false;
  }

  return true;
}

// ─── Deterministic pre-merge ─────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a",
  "across",
  "all",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "no",
  "not",
  "of",
  "on",
  "or",
  "the",
  "to",
  "up",
  "via",
  "with",
]);

interface SubjectWords {
  type: string;
  words: Set<string>;
}

/** True when ≥50% of the shorter word-set appears in the longer one. */
export function hasHighWordOverlap(a: Set<string>, b: Set<string>): boolean {
  if (a.size < 2 || b.size < 2) return false;
  let shared = 0;
  for (const wordA of a) {
    for (const wordB of b) {
      if (wordsRelated(wordA, wordB)) {
        shared++;
        break;
      }
    }
  }
  return shared / Math.min(a.size, b.size) >= 0.5;
}

/** Extract conventional-commit type and significant description words. */
export function parseSubjectWords(subject: string): SubjectWords {
  const colonIdx = subject.indexOf(":");
  let type = "";
  let desc = subject;
  if (colonIdx > 0 && colonIdx <= 50) {
    const prefix = subject
      .slice(0, colonIdx)
      .replace(/\(.*\)$/, "")
      .replace(/!$/, "");
    if (/^\w+$/.test(prefix)) {
      type = prefix.toLowerCase();
      desc = subject.slice(colonIdx + 1).trim();
    }
  }
  const words = new Set(
    desc
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
  return { type, words };
}

/**
 * Deterministically merge commits whose subjects share the same conventional-
 * commit type AND whose descriptions have ≥50% significant-word overlap.
 * Uses union-find for transitive closure (A~B, B~C → A+B+C merge).
 */
export function premergeBySubject(
  groups: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  if (groups.length < 2) return groups;

  const wordSets = groups.map((g) => {
    const subject = g.message.split("\n")[0];
    return parseSubjectWords(subject);
  });

  // Union-Find
  const parent = groups.map((_, i) => i);

  const find = (x: number): number => {
    let node = x;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  };

  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (
        wordSets[i].type !== "" &&
        wordSets[i].type === wordSets[j].type &&
        hasHighWordOverlap(wordSets[i].words, wordSets[j].words)
      ) {
        unite(i, j);
      }
    }
  }

  // Build clusters from union-find roots
  const clusterMap = new Map<number, number[]>();
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    const existing = clusterMap.get(root);
    if (existing) existing.push(i);
    else clusterMap.set(root, [i]);
  }

  const clusters = [...clusterMap.values()];

  // Only apply if at least one cluster has >1 item (actual merge happened)
  if (!clusters.some((c) => c.length > 1)) return groups;

  const merged = applyCommitClusters(groups, clusters, fileByPath);
  return hasMatchingCoverage(groups, merged, fileByPath) ? merged : groups;
}

/**
 * Two words are "related" if they are equal or one is a prefix of the other
 * (handles common English inflections like import/imports, order/ordering).
 */
export function wordsRelated(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter);
}

/** Combine subjects and body bullets from multiple commits into one message. */
function mergeCommitMessages(commits: PlannedCommit[]): string {
  if (commits.length === 1) return commits[0].message;

  const firstSubject = commits[0].message.split("\n")[0].trim();
  const bullets: string[] = [];

  for (const commit of commits) {
    const lines = commit.message.split("\n");
    // Body starts at line 2 (after subject + blank line)
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      // Bullet line or indented continuation
      if (/^\s*-\s+\S/.test(line) || /^\s{2,}\S/.test(line)) {
        bullets.push(line);
      }
    }
  }

  if (bullets.length === 0) {
    bullets.push("- Combined from multiple related commits.");
  }

  return `${firstSubject}\n\n${bullets.join("\n")}`;
}
