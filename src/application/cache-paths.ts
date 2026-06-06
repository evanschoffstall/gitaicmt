import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the user cache root while honoring an explicit XDG cache override.
 */
export function resolveCacheRootDirectory(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME;

  return xdgCacheHome && xdgCacheHome.length > 0
    ? xdgCacheHome
    : join(homedir(), ".cache");
}

/**
 * Resolve a gitaicmt-owned cache directory under the current user cache root.
 *
 * @param segments - Optional child path segments within the tool cache.
 * @returns Absolute path to the requested cache directory.
 */
export function resolveGitAICmtCacheDirectory(...segments: string[]): string {
  return join(resolveCacheRootDirectory(), "gitaicmt", ...segments);
}
