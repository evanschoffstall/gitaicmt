import { complete } from "./ai-client.js";
import { categorizeFile, getPlanningAffinityKey } from "./ai-paths.js";
import { buildMergePrompt, buildSystemPrompt } from "./ai-prompt-builders.js";
import { type PlannedCommit, type PlannedCommitFile } from "./ai-types.js";
import { ValidationError } from "./errors.js";

type FileDiff = import("./diff.js").FileDiff;

export async function finalizePlannedGroups(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
): Promise<PlannedCommit[]> {
  const affinityMergedGroups = await mergeAdjacentAffinitySupportGroups(groups);
  return await collapseFragmentedSupportGroups(allFiles, affinityMergedGroups);
}

function clonePlannedFile(file: PlannedCommitFile): PlannedCommitFile {
  return file.hunks
    ? { hunks: [...file.hunks], path: file.path }
    : { path: file.path };
}

async function collapseFragmentedSupportGroups(
  allFiles: FileDiff[],
  groups: PlannedCommit[],
): Promise<PlannedCommit[]> {
  const distinctAllPaths = new Set(allFiles.map((file) => file.path));
  const supportOnlyGroups = groups.filter((group) => isSupportOnlyGroup(group));

  if (supportOnlyGroups.length < 4) {
    return groups;
  }

  const supportPathCount = new Set(
    supportOnlyGroups.flatMap((group) => group.files.map((file) => file.path)),
  ).size;
  const supportCoverageRatio = supportPathCount / distinctAllPaths.size;
  const nonSupportFileCount = allFiles.filter((file) => {
    const category = categorizeFile(file.path);
    return (
      category !== "config/build" &&
      category !== "script" &&
      category !== "test"
    );
  }).length;

  if (
    supportPathCount < 6 ||
    supportCoverageRatio < 0.5 ||
    nonSupportFileCount > 4
  ) {
    return groups;
  }

  const mergedSupportFiles = mergePlannedFiles(
    supportOnlyGroups.flatMap((group) => group.files),
  );
  const mergedMessage = await mergePlannedCommitMessages(
    supportOnlyGroups.map((group) => group.message),
  );
  const supportGroupSet = new Set(supportOnlyGroups);
  const collapsed: PlannedCommit[] = [];
  let insertedSupportRollup = false;

  for (const group of groups) {
    if (!supportGroupSet.has(group)) {
      collapsed.push(group);
      continue;
    }

    if (!insertedSupportRollup) {
      collapsed.push({
        files: mergedSupportFiles,
        message: mergedMessage,
      });
      insertedSupportRollup = true;
    }
  }

  return insertedSupportRollup ? collapsed : groups;
}

function isSupportOnlyGroup(group: PlannedCommit): boolean {
  return (
    group.files.length > 0 &&
    group.files.every((file) => {
      const category = categorizeFile(file.path);
      return (
        category === "config/build" ||
        category === "script" ||
        category === "test"
      );
    })
  );
}

async function mergeAdjacentAffinitySupportGroups(
  groups: PlannedCommit[],
): Promise<PlannedCommit[]> {
  const merged: PlannedCommit[] = [];
  let pendingCluster: PlannedCommit[] = [];

  const flushPendingCluster = async (): Promise<void> => {
    if (pendingCluster.length === 0) {
      return;
    }
    if (pendingCluster.length === 1) {
      merged.push(pendingCluster[0]);
      pendingCluster = [];
      return;
    }

    merged.push({
      files: mergePlannedFiles(pendingCluster.flatMap((group) => group.files)),
      message: await mergePlannedCommitMessages(
        pendingCluster.map((group) => group.message),
      ),
    });
    pendingCluster = [];
  };

  for (const group of groups) {
    if (pendingCluster.length === 0) {
      pendingCluster = [group];
      continue;
    }

    if (shouldMergeAdjacentSupportGroups(pendingCluster, group)) {
      pendingCluster.push(group);
      continue;
    }

    await flushPendingCluster();
    pendingCluster = [group];
  }

  await flushPendingCluster();
  return merged;
}

async function mergePlannedCommitMessages(messages: string[]): Promise<string> {
  if (messages.length === 1) {
    return messages[0];
  }

  const sys = buildSystemPrompt();
  const usr = buildMergePrompt(messages, {
    additions: 0,
    chunks: messages.length,
    deletions: 0,
    filesChanged: messages.length,
  });
  return complete(sys, usr);
}

function mergePlannedFiles(files: PlannedCommitFile[]): PlannedCommitFile[] {
  const mergedByPath = new Map<string, PlannedCommitFile>();
  const order: string[] = [];

  for (const file of files) {
    const existing = mergedByPath.get(file.path);
    if (!existing) {
      mergedByPath.set(file.path, clonePlannedFile(file));
      order.push(file.path);
      continue;
    }

    if (!existing.hunks || existing.hunks.length === 0) {
      continue;
    }
    if (!file.hunks || file.hunks.length === 0) {
      mergedByPath.set(file.path, { path: file.path });
      continue;
    }

    const mergedHunks = Array.from(
      new Set([...existing.hunks, ...file.hunks]),
    ).sort((left, right) => left - right);
    mergedByPath.set(file.path, { hunks: mergedHunks, path: file.path });
  }

  return order.map((path) => {
    const file = mergedByPath.get(path);
    if (!file) {
      throw new ValidationError(`Missing merged planned file entry: ${path}`);
    }
    return file;
  });
}

function shouldMergeAdjacentSupportGroups(
  cluster: PlannedCommit[],
  right: PlannedCommit,
): boolean {
  if (
    cluster.length === 0 ||
    cluster.some((group) => !isSupportOnlyGroup(group)) ||
    !isSupportOnlyGroup(right)
  ) {
    return false;
  }

  const clusterAffinityKeys = new Set(
    cluster.flatMap((group) =>
      group.files.map((file) => getPlanningAffinityKey(file.path)),
    ),
  );
  return right.files.some((file) =>
    clusterAffinityKeys.has(getPlanningAffinityKey(file.path)),
  );
}
