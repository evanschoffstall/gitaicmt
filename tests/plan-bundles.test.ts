import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  filterValidPlanCommitsForResume,
  getBundleFileDiffs,
  loadPlanBundle,
  type PlannedCommit,
  preparePlanBundleForResume,
  savePlanBundle,
} from "../src/commit-planning/index.js";
import { getStagedPatch, hasStagedChanges } from "../src/git/index.js";

const { afterEach, beforeEach, describe, expect, test } =
  await import("bun:test");

const tempDirectories: string[] = [];
const savedXdgCacheHome = process.env["XDG_CACHE_HOME"];

/**
 * Always route persisted plan-bundle JSON files into a throwaway cache root so
 * teardown can delete all artifacts after each test run.
 */
function useIsolatedPlanBundleCacheHome(): string {
  const cacheHome = createTempCacheHome();
  process.env["XDG_CACHE_HOME"] = cacheHome;
  return cacheHome;
}

beforeEach(() => {
  useIsolatedPlanBundleCacheHome();
});

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      rmSync(directory, { force: true, recursive: true });
    }
  }

  if (savedXdgCacheHome === undefined) {
    delete process.env["XDG_CACHE_HOME"];
  } else {
    process.env["XDG_CACHE_HOME"] = savedXdgCacheHome;
  }
});

/**
 * Initialize an isolated Git repository with deterministic local config.
 */
function createGitRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), "gitaicmt-plan-bundle-"));
  tempDirectories.push(directory);

  execSync(
    [
      "git init",
      'git config user.email "test@test.com"',
      'git config user.name "Test User"',
      "git config commit.gpgSign false",
      "git config tag.gpgSign false",
      "git commit --allow-empty -m 'init'",
    ].join(" && "),
    {
      cwd: directory,
      stdio: "pipe",
    },
  );

  return directory;
}

function createGitRepoWithoutInitialCommit(): string {
  const directory = mkdtempSync(join(tmpdir(), "gitaicmt-plan-bundle-empty-"));
  tempDirectories.push(directory);

  execSync(
    [
      "git init",
      'git config user.email "test@test.com"',
      'git config user.name "Test User"',
      "git config commit.gpgSign false",
      "git config tag.gpgSign false",
    ].join(" && "),
    {
      cwd: directory,
      stdio: "pipe",
    },
  );

  return directory;
}

function createPlan(fileName = "note.txt"): PlannedCommit[] {
  return [
    {
      files: [{ path: fileName }],
      message:
        "feat(test): save a resumable bundle\n\n- Preserve the staged patch for later execution.",
    },
  ];
}

function createSplitPlan(): PlannedCommit[] {
  return [
    {
      files: [{ path: "first.txt" }],
      message: "feat(test): keep first staged file",
    },
    {
      files: [{ path: "second.txt" }],
      message: "feat(test): keep second staged file",
    },
  ];
}

function createTempCacheHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "gitaicmt-plan-cache-"));
  tempDirectories.push(directory);
  return directory;
}

function listSavedBundlePaths(cacheHome: string): string[] {
  const bundleDirectory = join(cacheHome, "gitaicmt", "plan-bundles");
  if (!existsSync(bundleDirectory)) {
    return [];
  }

  return readdirSync(bundleDirectory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(bundleDirectory, entry));
}

function stageBinaryFixtureFile(
  directory: string,
  fileName = "image.bin",
): void {
  const bytes = Buffer.from([0, 255, 127, 64, 9, 13, 10, 2]);
  writeFileSync(join(directory, fileName), bytes);
  execSync(`git add ${fileName}`, {
    cwd: directory,
    stdio: "pipe",
  });
}

function stageFixtureFile(directory: string, fileName = "note.txt"): void {
  writeFileSync(join(directory, fileName), "hello\nworld\n", "utf-8");
  execSync(`git add ${fileName}`, {
    cwd: directory,
    stdio: "pipe",
  });
}

function stageRenameWithContentChange(
  directory: string,
  fromPath: string,
  toPath: string,
): void {
  writeFileSync(join(directory, fromPath), "before\n", "utf-8");
  execSync(`git add ${fromPath}`, {
    cwd: directory,
    stdio: "pipe",
  });
  execSync("git commit -m 'seed rename fixture'", {
    cwd: directory,
    stdio: "pipe",
  });

  execSync(`git mv ${fromPath} ${toPath}`, {
    cwd: directory,
    stdio: "pipe",
  });
  writeFileSync(join(directory, toPath), "before\nafter\n", "utf-8");
  execSync(`git add ${toPath}`, {
    cwd: directory,
    stdio: "pipe",
  });
}

/**
 * Persist a repo-local config file so retention settings are exercised through
 * the same load path as the CLI.
 */
function writeRepoConfig(
  directory: string,
  config: Record<string, unknown>,
): void {
  writeFileSync(
    join(directory, "gitaicmt.config.json"),
    JSON.stringify(config),
    "utf-8",
  );
}

describe("plan bundles", () => {
  test("saves and reloads a persisted plan bundle with the original staged patch", () => {
    const directory = createGitRepo();
    stageFixtureFile(directory);

    const stagedPatch = getStagedPatch(directory);
    const savedBundle = savePlanBundle(createPlan(), stagedPatch, directory);
    const reloadedBundle = loadPlanBundle(savedBundle.hash);

    expect(reloadedBundle.hash).toBe(savedBundle.hash);
    expect(reloadedBundle.planCommitHashes).toHaveLength(1);
    expect(reloadedBundle.planCommitPatches).toHaveLength(1);
    expect(reloadedBundle.stagedPatch).toBe(stagedPatch);
    expect(
      getBundleFileDiffs(reloadedBundle).map(
        (file: { path: string }) => file.path,
      ),
    ).toEqual(["note.txt"]);
  });

  test("stores bundles under XDG_CACHE_HOME when that cache root is configured", () => {
    const directory = createGitRepo();
    const cacheHome = useIsolatedPlanBundleCacheHome();
    stageFixtureFile(directory);

    const savedBundle = savePlanBundle(
      createPlan(),
      getStagedPatch(directory),
      directory,
    );
    const stagedPatch = getStagedPatch(directory);

    expect(savedBundle.path).toBe(
      join(cacheHome, "gitaicmt", "plan-bundles", `${savedBundle.hash}.json`),
    );
    expect(existsSync(savedBundle.path)).toBe(true);
  });

  test("saves and reloads bundles for repositories that do not have an initial commit yet", () => {
    const directory = createGitRepoWithoutInitialCommit();
    stageFixtureFile(directory);

    const savedBundle = savePlanBundle(
      createPlan(),
      getStagedPatch(directory),
      directory,
    );
    const reloadedBundle = loadPlanBundle(savedBundle.hash);

    expect(reloadedBundle.headCommit).toBeNull();
    expect(reloadedBundle.repoRoot).toBe(directory);
  });

  test("creates a unique hash and file path for each saved run", () => {
    const directory = createGitRepo();
    useIsolatedPlanBundleCacheHome();
    stageFixtureFile(directory);

    const stagedPatch = getStagedPatch(directory);
    const firstBundle = savePlanBundle(createPlan(), stagedPatch, directory);
    const secondBundle = savePlanBundle(createPlan(), stagedPatch, directory);

    expect(secondBundle.hash).not.toBe(firstBundle.hash);
    expect(secondBundle.path).not.toBe(firstBundle.path);
  });

  test("prunes only the oldest saved bundles beyond the configured retention limit", () => {
    const directory = createGitRepo();
    useIsolatedPlanBundleCacheHome();
    writeRepoConfig(directory, {
      performance: {
        maxSavedPlanBundles: 2,
      },
    });
    stageFixtureFile(directory);

    const stagedPatch = getStagedPatch(directory);
    const firstBundle = savePlanBundle(createPlan(), stagedPatch, directory);
    const secondBundle = savePlanBundle(createPlan(), stagedPatch, directory);
    const thirdBundle = savePlanBundle(createPlan(), stagedPatch, directory);

    expect(existsSync(firstBundle.path)).toBe(false);
    expect(existsSync(secondBundle.path)).toBe(true);
    expect(existsSync(thirdBundle.path)).toBe(true);
  });

  test("prunes saved bundles only within the current repository cache set", () => {
    const cacheHome = useIsolatedPlanBundleCacheHome();
    const firstRepo = createGitRepo();
    const secondRepo = createGitRepo();

    writeRepoConfig(firstRepo, {
      performance: {
        maxSavedPlanBundles: 1,
      },
    });

    stageFixtureFile(firstRepo, "first-repo.txt");
    const firstRepoPatch = getStagedPatch(firstRepo);
    const firstRepoBundleOne = savePlanBundle(
      createPlan("first-repo.txt"),
      firstRepoPatch,
      firstRepo,
    );

    stageFixtureFile(secondRepo, "second-repo.txt");
    const secondRepoBundle = savePlanBundle(
      createPlan("second-repo.txt"),
      getStagedPatch(secondRepo),
      secondRepo,
    );

    const firstRepoBundleTwo = savePlanBundle(
      createPlan("first-repo.txt"),
      firstRepoPatch,
      firstRepo,
    );

    expect(existsSync(firstRepoBundleOne.path)).toBe(false);
    expect(existsSync(firstRepoBundleTwo.path)).toBe(true);
    expect(existsSync(secondRepoBundle.path)).toBe(true);
    expect(listSavedBundlePaths(cacheHome)).toHaveLength(2);
  });

  test("applies repo-root retention config even when saving from a nested subdirectory", () => {
    const directory = createGitRepo();
    const nestedDirectory = join(directory, "packages", "cli");
    useIsolatedPlanBundleCacheHome();
    mkdirSync(nestedDirectory, { recursive: true });
    writeRepoConfig(directory, {
      performance: {
        maxSavedPlanBundles: 1,
      },
    });
    stageFixtureFile(directory);

    const stagedPatch = getStagedPatch(directory);
    const firstBundle = savePlanBundle(
      createPlan(),
      stagedPatch,
      nestedDirectory,
    );
    const secondBundle = savePlanBundle(
      createPlan(),
      stagedPatch,
      nestedDirectory,
    );

    expect(existsSync(firstBundle.path)).toBe(false);
    expect(existsSync(secondBundle.path)).toBe(true);
  });

  test("reloads a fresh clone so caller mutations do not leak back into saved bundles", () => {
    const directory = createGitRepo();
    stageFixtureFile(directory);

    const savedBundle = savePlanBundle(
      createPlan(),
      getStagedPatch(directory),
      directory,
    );
    const firstLoad = loadPlanBundle(savedBundle.hash);
    firstLoad.plan[0]!.message = "mutated message";
    firstLoad.plan[0]!.files[0]!.path = "mutated.txt";

    const secondLoad = loadPlanBundle(savedBundle.hash);

    expect(secondLoad.plan[0]!.message).toBe(createPlan()[0]!.message);
    expect(secondLoad.plan[0]!.files[0]!.path).toBe("note.txt");
  });

  test("restores the saved staged patch when the current index is empty", () => {
    const directory = createGitRepo();
    stageFixtureFile(directory);

    const stagedPatch = getStagedPatch(directory);
    const savedBundle = savePlanBundle(createPlan(), stagedPatch, directory);

    execSync("git reset HEAD -- .", {
      cwd: directory,
      stdio: "pipe",
    });
    expect(hasStagedChanges(directory)).toBe(false);

    const reloadedBundle = loadPlanBundle(savedBundle.hash);
    preparePlanBundleForResume(reloadedBundle, [1], directory);

    expect(getStagedPatch(directory)).toBe(stagedPatch);
  });

  test("rejects cross-repository resume even when the saved hash exists", () => {
    const sourceDirectory = createGitRepo();
    const differentDirectory = createGitRepo();
    stageFixtureFile(sourceDirectory);

    const savedBundle = savePlanBundle(
      createPlan(),
      getStagedPatch(sourceDirectory),
      sourceDirectory,
    );
    const reloadedBundle = loadPlanBundle(savedBundle.hash);

    expect(() =>
      preparePlanBundleForResume(reloadedBundle, [1], differentDirectory),
    ).toThrow(/different repository checkout/u);
  });

  test("allows resume when HEAD changes but the saved patch still restores cleanly", () => {
    const directory = createGitRepo();
    stageFixtureFile(directory);
    const stagedPatch = getStagedPatch(directory);

    const savedBundle = savePlanBundle(createPlan(), stagedPatch, directory);

    execSync("git reset HEAD -- .", {
      cwd: directory,
      stdio: "pipe",
    });
    rmSync(join(directory, "note.txt"), { force: true });
    execSync("git commit --allow-empty -m 'advance head'", {
      cwd: directory,
      stdio: "pipe",
    });

    const reloadedBundle = loadPlanBundle(savedBundle.hash);

    expect(() =>
      preparePlanBundleForResume(reloadedBundle, [1], directory),
    ).not.toThrow();
    expect(getStagedPatch(directory)).toBe(stagedPatch);
  });

  test("keeps a partially consumed staged patch instead of restoring the whole saved bundle", () => {
    const directory = createGitRepo();
    writeFileSync(join(directory, "first.txt"), "first\n", "utf-8");
    writeFileSync(join(directory, "second.txt"), "second\n", "utf-8");
    execSync("git add first.txt second.txt", {
      cwd: directory,
      stdio: "pipe",
    });

    const savedBundle = savePlanBundle(
      createSplitPlan(),
      getStagedPatch(directory),
      directory,
    );

    execSync("git reset HEAD -- .", {
      cwd: directory,
      stdio: "pipe",
    });
    execSync("git add second.txt", {
      cwd: directory,
      stdio: "pipe",
    });
    const remainingPatch = getStagedPatch(directory);

    const reloadedBundle = loadPlanBundle(savedBundle.hash);

    expect(() =>
      preparePlanBundleForResume(reloadedBundle, [1, 2], directory),
    ).not.toThrow();
    expect(getStagedPatch(directory)).toBe(remainingPatch);
  });

  test("restores only the selected saved commit patches when the index is empty", () => {
    const directory = createGitRepo();
    writeFileSync(join(directory, "first.txt"), "first\n", "utf-8");
    writeFileSync(join(directory, "second.txt"), "second\n", "utf-8");
    execSync("git add first.txt second.txt", {
      cwd: directory,
      stdio: "pipe",
    });

    const savedBundle = savePlanBundle(
      createSplitPlan(),
      getStagedPatch(directory),
      directory,
    );

    execSync("git reset HEAD -- .", {
      cwd: directory,
      stdio: "pipe",
    });
    expect(hasStagedChanges(directory)).toBe(false);

    execSync("git add second.txt", {
      cwd: directory,
      stdio: "pipe",
    });
    const secondCommitPatch = getStagedPatch(directory);
    execSync("git reset HEAD -- .", {
      cwd: directory,
      stdio: "pipe",
    });

    const reloadedBundle = loadPlanBundle(savedBundle.hash);

    expect(() =>
      preparePlanBundleForResume(reloadedBundle, [2], directory),
    ).not.toThrow();
    expect(getStagedPatch(directory)).toBe(secondCommitPatch);
  });

  test("valid-only resume keeps only commits whose saved file hashes still match", () => {
    const directory = createGitRepo();
    writeFileSync(join(directory, "first.txt"), "first\n", "utf-8");
    writeFileSync(join(directory, "second.txt"), "second\n", "utf-8");
    execSync("git add first.txt second.txt", {
      cwd: directory,
      stdio: "pipe",
    });

    const savedBundle = savePlanBundle(
      createSplitPlan(),
      getStagedPatch(directory),
      directory,
    );

    execSync("git reset HEAD -- .", {
      cwd: directory,
      stdio: "pipe",
    });
    execSync("git add first.txt", {
      cwd: directory,
      stdio: "pipe",
    });

    const reloadedBundle = loadPlanBundle(savedBundle.hash);

    expect(() =>
      preparePlanBundleForResume(reloadedBundle, [1, 2], directory),
    ).not.toThrow();

    expect(
      filterValidPlanCommitsForResume(reloadedBundle, [1, 2], directory),
    ).toEqual({
      invalidCommits: [
        {
          index: 2,
          message: "feat(test): keep second staged file",
          mismatch:
            "file mismatch (second.txt): file missing from current staged patch; expected=second.txt, actual=<missing>",
        },
      ],
      validPlan: [createSplitPlan()[0]],
    });
  });

  test("rejects invalid saved bundle hashes before any file load", () => {
    expect(() => loadPlanBundle("not-a-real-hash")).toThrow(
      /64-character lowercase hex string/u,
    );
  });

  test("rejects empty staged patch saves before writing any bundle file", () => {
    const directory = createGitRepo();

    expect(() => savePlanBundle(createPlan(), "", directory)).toThrow(
      /Cannot save an empty staged patch plan bundle/u,
    );
  });

  test("rejects saving bundles when persisted planner caching is disabled", () => {
    const directory = createGitRepo();
    writeFileSync(
      join(directory, "gitaicmt.config.json"),
      JSON.stringify({
        performance: {
          cacheEnabled: false,
        },
      }),
      "utf-8",
    );
    stageFixtureFile(directory);

    expect(() =>
      savePlanBundle(createPlan(), getStagedPatch(directory), directory),
    ).toThrow(/Plan bundles are disabled/u);
  });

  test("rejects corrupted persisted bundle payloads on load", () => {
    const directory = createGitRepo();
    useIsolatedPlanBundleCacheHome();
    stageFixtureFile(directory);

    const savedBundle = savePlanBundle(
      createPlan(),
      getStagedPatch(directory),
      directory,
    );
    writeFileSync(savedBundle.path, "{}\n", "utf-8");

    expect(() => loadPlanBundle(savedBundle.hash)).toThrow(
      /missing an integer schemaVersion field/u,
    );
  });

  test("rejects tampered bundle payloads when the internal hash does not match the file hash", () => {
    const directory = createGitRepo();
    useIsolatedPlanBundleCacheHome();
    stageFixtureFile(directory);

    const savedBundle = savePlanBundle(
      createPlan(),
      getStagedPatch(directory),
      directory,
    );
    const tamperedBundle = JSON.parse(
      readFileSync(savedBundle.path, "utf-8"),
    ) as {
      hash: string;
    };
    tamperedBundle.hash = "f".repeat(64);
    writeFileSync(
      savedBundle.path,
      JSON.stringify(tamperedBundle, null, 2) + "\n",
      "utf-8",
    );

    expect(() => loadPlanBundle(savedBundle.hash)).toThrow(/hash mismatch/u);
  });

  test("rejects legacy schema version 1 bundles when only latest schema is supported", () => {
    const directory = createGitRepo();
    useIsolatedPlanBundleCacheHome();
    stageFixtureFile(directory);

    const savedBundle = savePlanBundle(
      createPlan(),
      getStagedPatch(directory),
      directory,
    );
    const legacyBundle = JSON.parse(
      readFileSync(savedBundle.path, "utf-8"),
    ) as {
      schemaVersion: number;
    };
    legacyBundle.schemaVersion = 1;
    writeFileSync(
      savedBundle.path,
      JSON.stringify(legacyBundle, null, 2) + "\n",
      "utf-8",
    );

    expect(() => loadPlanBundle(savedBundle.hash)).toThrow(
      /unsupported schema version 1/u,
    );
  });

  test("rejects unsupported future schema versions with an explicit error", () => {
    const directory = createGitRepo();
    useIsolatedPlanBundleCacheHome();
    stageFixtureFile(directory);

    const savedBundle = savePlanBundle(
      createPlan(),
      getStagedPatch(directory),
      directory,
    );
    const futureBundle = JSON.parse(
      readFileSync(savedBundle.path, "utf-8"),
    ) as {
      schemaVersion: number;
    };
    futureBundle.schemaVersion = 999;
    writeFileSync(
      savedBundle.path,
      JSON.stringify(futureBundle, null, 2) + "\n",
      "utf-8",
    );

    expect(() => loadPlanBundle(savedBundle.hash)).toThrow(
      /unsupported schema version 999/u,
    );
  });

  test("hash metadata covers renamed-file state used by replay", () => {
    const directory = createGitRepo();
    useIsolatedPlanBundleCacheHome();
    stageRenameWithContentChange(directory, "before.txt", "after.txt");

    const savedBundle = savePlanBundle(
      createPlan("after.txt"),
      getStagedPatch(directory),
      directory,
    );
    const persistedBundle = JSON.parse(
      readFileSync(savedBundle.path, "utf-8"),
    ) as {
      contentHashes: {
        files: {
          path: string;
        }[];
      };
    };

    expect(persistedBundle.contentHashes.files[0]?.path).toBe("after.txt");
  });

  test("hash metadata covers binary-only staged files", () => {
    const directory = createGitRepo();
    useIsolatedPlanBundleCacheHome();
    stageBinaryFixtureFile(directory, "image.bin");

    const savedBundle = savePlanBundle(
      createPlan("image.bin"),
      getStagedPatch(directory),
      directory,
    );
    const persistedBundle = JSON.parse(
      readFileSync(savedBundle.path, "utf-8"),
    ) as {
      contentHashes: {
        files: {
          fileHash: string;
          hunkHashes: string[];
          path: string;
        }[];
      };
    };

    const binaryFileHashes = persistedBundle.contentHashes.files.find(
      (file) => file.path === "image.bin",
    );

    expect(binaryFileHashes?.fileHash).toMatch(/^[a-f0-9]{64}$/u);
    expect((binaryFileHashes?.hunkHashes.length ?? 0) > 0).toBe(true);
  });

  test("retains older saved bundles when newer bundles are saved later", () => {
    const directory = createGitRepo();
    useIsolatedPlanBundleCacheHome();
    stageFixtureFile(directory);

    const stagedPatch = getStagedPatch(directory);
    const savedBundle = savePlanBundle(createPlan(), stagedPatch, directory);
    const expiredTimestamp = new Date(Date.now() - 5_000);
    utimesSync(savedBundle.path, expiredTimestamp, expiredTimestamp);

    const newerBundle = savePlanBundle(createPlan(), stagedPatch, directory);
    const reloadedBundle = loadPlanBundle(savedBundle.hash);

    expect(existsSync(newerBundle.path)).toBe(true);
    expect(reloadedBundle.hash).toBe(savedBundle.hash);
    expect(reloadedBundle.stagedPatch).toBe(stagedPatch);
  });

  test("writes the persisted bundle payload with repo and patch metadata needed for resume", () => {
    const directory = createGitRepo();
    useIsolatedPlanBundleCacheHome();
    stageFixtureFile(directory);

    const stagedPatch = getStagedPatch(directory);
    const savedBundle = savePlanBundle(createPlan(), stagedPatch, directory);
    const persistedBundle = JSON.parse(
      readFileSync(savedBundle.path, "utf-8"),
    ) as {
      contentHashes: {
        bundleHash: string;
        files: {
          fileHash: string;
          hunkHashes: string[];
          path: string;
        }[];
      };
      createdAt: string;
      hash: string;
      headCommit: null | string;
      repoRoot: string;
      schemaVersion: number;
      stagedPatch: string;
      stagedPatchHash: string;
    };

    expect(persistedBundle.hash).toBe(savedBundle.hash);
    expect(persistedBundle.repoRoot).toBe(directory);
    expect(persistedBundle.schemaVersion).toBe(4);
    expect(persistedBundle.stagedPatch).toBe(stagedPatch);
    expect(persistedBundle.stagedPatchHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(persistedBundle.contentHashes.bundleHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(persistedBundle.contentHashes.files).toHaveLength(1);
    const persistedFile = persistedBundle.contentHashes.files[0]!;
    expect(persistedFile.path).toBe("note.txt");
    expect(persistedFile.fileHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      persistedFile.hunkHashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)),
    ).toBe(true);
    expect(persistedBundle.createdAt).toMatch(/T/u);
    expect(persistedBundle.headCommit).toMatch(/^[a-f0-9]{40}$/u);
  });
});
