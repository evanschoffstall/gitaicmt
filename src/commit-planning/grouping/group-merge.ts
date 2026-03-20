import {
  type FileDiff,
  type PlannedCommit,
  type PlannedCommitFile,
} from "./grouping-types.js";
import { isSupportLikeType, parseSubjectWords } from "./subject-analysis.js";

/** Merge AI-produced commit clusters into commit groups. */
export function mergeCommitClusters(
  groups: PlannedCommit[],
  clusters: number[][],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit[] {
  const mergedGroups: PlannedCommit[] = [];

  for (const cluster of clusters) {
    if (cluster.length === 0) {
      continue;
    }
    if (cluster.length === 1) {
      mergedGroups.push(groups[cluster[0]]);
      continue;
    }

    mergedGroups.push(
      mergeCommitsIntoGroup(cluster.map((index) => groups[index]), fileByPath),
    );
  }

  return mergedGroups;
}

/** Merge file references while preserving hunk precision where possible. */
export function mergeCommitFiles(
  commits: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommitFile[] {
  const fileHunkMap = new Map<string, null | Set<number>>();

  for (const commit of commits) {
    for (const fileRef of commit.files) {
      if (!fileRef.hunks || fileRef.hunks.length === 0) {
        fileHunkMap.set(fileRef.path, null);
        continue;
      }

      if (!fileHunkMap.has(fileRef.path)) {
        fileHunkMap.set(fileRef.path, new Set(fileRef.hunks));
        continue;
      }

      const existingHunkIndexes = fileHunkMap.get(fileRef.path);
      if (existingHunkIndexes === null || existingHunkIndexes === undefined) {
        continue;
      }

      for (const hunkIndex of fileRef.hunks) {
        existingHunkIndexes.add(hunkIndex);
      }
    }
  }

  const mergedFiles: PlannedCommitFile[] = [];
  for (const [path, hunkIndexes] of fileHunkMap) {
    const file = fileByPath.get(path);
    if (!file || file.hunks.length === 0 || hunkIndexes === null) {
      mergedFiles.push({ path });
      continue;
    }

    mergedFiles.push({
      hunks: [...hunkIndexes].sort((left, right) => left - right),
      path,
    });
  }

  return mergedFiles;
}

/** Combine subjects and bullet blocks from multiple commit messages. */
export function mergeCommitMessages(commits: PlannedCommit[]): string {
  if (commits.length === 1) {
    return commits[0].message;
  }

  const orderedCommits = prioritizeMergedCommits(commits);
  const firstSubject = orderedCommits[0].message.split("\n")[0].trim();
  const bulletBlocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const commit of orderedCommits) {
    const lines = commit.message.split("\n");
    for (let index = 2; index < lines.length; index++) {
      const line = lines[index];
      if (/^\s*-\s+\S/.test(line)) {
        if (currentBlock.length > 0) {
          bulletBlocks.push(currentBlock);
        }
        currentBlock = [line];
        continue;
      }

      if (/^\s{2,}\S/.test(line) && currentBlock.length > 0) {
        currentBlock.push(line);
      }
    }
  }

  if (currentBlock.length > 0) {
    bulletBlocks.push(currentBlock);
  }

  const dedupedBlocks = bulletBlocks.filter(
    (block, index, blocks) =>
      blocks.findIndex(
        (candidate) => candidate.join("\n") === block.join("\n"),
      ) === index,
  );

  if (dedupedBlocks.length === 0) {
    return firstSubject;
  }

  return `${firstSubject}\n\n${dedupedBlocks
    .map((block) => block.join("\n"))
    .join("\n")}`;
}

/** Create a single planned commit from multiple groups. */
export function mergeCommitsIntoGroup(
  commits: PlannedCommit[],
  fileByPath: Map<string, FileDiff>,
): PlannedCommit {
  return {
    files: mergeCommitFiles(commits, fileByPath),
    message: mergeCommitMessages(commits),
  };
}

/** Prefer stronger implementation commits when synthesizing merged subjects. */
export function prioritizeMergedCommits(
  commits: PlannedCommit[],
): PlannedCommit[] {
  return [...commits].sort((left, right) => {
    const leftSubject = parseSubjectWords(left.message.split("\n")[0] ?? "");
    const rightSubject = parseSubjectWords(
      right.message.split("\n")[0] ?? "",
    );
    const leftScore =
      (isSupportLikeType(leftSubject.type) ? 0 : 10) +
      leftSubject.words.size +
      left.files.length;
    const rightScore =
      (isSupportLikeType(rightSubject.type) ? 0 : 10) +
      rightSubject.words.size +
      right.files.length;

    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }

    return left.message.localeCompare(right.message);
  });
}