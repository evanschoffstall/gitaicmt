import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

interface RepositoryStructureProfile {
  containerRootNames: Set<string>;
  supportRootNames: Set<string>;
}

const cachedRepositoryStructureProfiles = new Map<
  string,
  RepositoryStructureProfile
>();

export function getAllContainerRootNames(
  moduleRepositoryRootPath: string,
): Set<string> {
  const names = new Set<string>();
  for (const repositoryRootPath of getRepositoryRootCandidates(
    moduleRepositoryRootPath,
  )) {
    for (const containerRootName of getRepositoryStructureProfile(
      repositoryRootPath,
    ).containerRootNames) {
      names.add(containerRootName);
    }
  }

  return names;
}

export function getAllSupportRootNames(
  moduleRepositoryRootPath: string,
): Set<string> {
  const names = new Set<string>();
  for (const repositoryRootPath of getRepositoryRootCandidates(
    moduleRepositoryRootPath,
  )) {
    for (const supportRootName of getRepositoryStructureProfile(
      repositoryRootPath,
    ).supportRootNames) {
      names.add(supportRootName);
    }
  }

  return names;
}

export function resolveRepositoryRootPath(
  filePath: string,
  moduleRepositoryRootPath: string,
): string {
  const normalizedPath = filePath.replace(/\\/gu, "/");
  const repositoryRootCandidates = getRepositoryRootCandidates(
    moduleRepositoryRootPath,
  );

  if (normalizedPath.startsWith("/")) {
    for (const repositoryRootPath of repositoryRootCandidates) {
      if (
        normalizedPath === repositoryRootPath ||
        normalizedPath.startsWith(`${repositoryRootPath}/`)
      ) {
        return repositoryRootPath;
      }
    }

    return repositoryRootCandidates[0] ?? moduleRepositoryRootPath;
  }

  for (const repositoryRootPath of repositoryRootCandidates) {
    if (existsSync(resolve(repositoryRootPath, normalizedPath))) {
      return repositoryRootPath;
    }
  }

  return repositoryRootCandidates[0] ?? moduleRepositoryRootPath;
}

function getRepositoryRootCandidates(
  moduleRepositoryRootPath: string,
): string[] {
  const workingTreeRootPath = resolve(process.cwd()).replace(/\\/gu, "/");
  return [...new Set([moduleRepositoryRootPath, workingTreeRootPath])];
}

function getRepositoryStructureProfile(
  repositoryRootPath: string,
): RepositoryStructureProfile {
  const cachedProfile =
    cachedRepositoryStructureProfiles.get(repositoryRootPath);
  if (cachedProfile) {
    return cachedProfile;
  }

  const containerRootNames = new Set<string>();
  const supportRootNames = new Set<string>();
  for (const directoryEntry of readdirSync(repositoryRootPath, {
    withFileTypes: true,
  })) {
    if (!directoryEntry.isDirectory()) {
      continue;
    }

    const childEntries = readdirSync(
      resolve(repositoryRootPath, directoryEntry.name),
      { withFileTypes: true },
    );
    const directDirectoryCount = childEntries.filter((entry) =>
      entry.isDirectory(),
    ).length;
    const directFileCount = childEntries.filter((entry) =>
      entry.isFile(),
    ).length;
    const supportLikeDirectFileCount = childEntries.filter(
      (entry) => entry.isFile() && isSupportLikeFileName(entry.name),
    ).length;

    if (directDirectoryCount >= 2 && directDirectoryCount > directFileCount) {
      containerRootNames.add(directoryEntry.name.toLowerCase());
    }
    if (
      supportLikeDirectFileCount > 0 &&
      supportLikeDirectFileCount * 2 >= directFileCount
    ) {
      supportRootNames.add(directoryEntry.name.toLowerCase());
    }
  }

  const profile = {
    containerRootNames,
    supportRootNames,
  };
  cachedRepositoryStructureProfiles.set(repositoryRootPath, profile);
  return profile;
}

function isSupportLikeFileName(fileName: string): boolean {
  return /(?:^|\.)(?:spec|test)\.[^.]+$/u.test(fileName);
}
