export function categorizeFile(path: string): string {
  if (/^(README|CHANGELOG|LICENSE|AGENTS|docs\/)/i.test(path)) return "docs";
  if (/^scripts\//i.test(path)) return "script";
  if (
    /^(package\.json|tsconfig|bun\.lock)/i.test(path) ||
    path.startsWith(".") ||
    (!path.includes("/") && /\.(json|toml|yaml|yml|js|cjs|mjs)$/.test(path))
  ) {
    return "config/build";
  }
  if (/\.(test|spec)\.[a-z]+$/i.test(path) || /^tests?\//i.test(path)) {
    return "test";
  }
  return "source";
}

export function getPlanningAffinityKey(path: string): string {
  const isRootDotfile = path.startsWith(".") && !path.includes("/");
  const isRootConfigFile =
    !path.includes("/") && path.includes(".config.") && !path.startsWith(".");
  if (
    path === "package.json" ||
    path === "bun.lock" ||
    path === ".gitignore" ||
    isRootDotfile ||
    isRootConfigFile
  ) {
    return "00-tooling";
  }
  if (/\.(test|spec)\.[a-z]+$/i.test(path) || /^tests?\//i.test(path)) {
    return `20-${normalizePlanningStem(path)}`;
  }
  if (/^src\//i.test(path)) {
    return `20-${normalizePlanningStem(path)}`;
  }
  if (/^scripts\//i.test(path)) {
    return `10-${stripLastExtension(path.slice("scripts/".length))}`;
  }
  if (/^(README|CHANGELOG|LICENSE|AGENTS|docs\/)/i.test(path)) {
    return "90-docs";
  }
  return `50-${path.replace(/\.[^.]+$/, "")}`;
}

function normalizePlanningStem(path: string): string {
  let stem = path;

  if (stem.startsWith("tests/")) {
    stem = stem.slice("tests/".length);
  } else if (stem.startsWith("test/")) {
    stem = stem.slice("test/".length);
  }

  if (stem.startsWith("src/")) {
    stem = stem.slice("src/".length);
  }

  stem = stripLastExtension(stem);
  if (stem.endsWith(".test")) {
    return stem.slice(0, -".test".length);
  }
  if (stem.endsWith(".spec")) {
    return stem.slice(0, -".spec".length);
  }
  return stem;
}

function stripLastExtension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot <= 0) {
    return path;
  }
  return path.slice(0, lastDot);
}
