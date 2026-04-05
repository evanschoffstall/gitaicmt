import type { LizardConfig } from "check-suite/src/quality/index.ts";
import type { GitFileScanOptions } from "check-suite/src/step/index.ts";
import type {
  CheckConfig,
  Command,
  InlineTypeScriptContext,
  StepConfig,
} from "check-suite/src/types/index.ts";

import { defineCheckSuiteConfig } from "check-suite/src/config-schema/index.ts";
import { hasPackageScript } from "check-suite/src/config/index.ts";
import { buildTestCoveragePostProcess } from "check-suite/src/post-process/index.ts";
import {
  analyzeArchitecture,
  analyzePurgeCss,
  formatArchitectureViolations,
  formatUnusedSelectorOutput,
  parseBunConsoleCoverage,
  readPurgeCssConfig,
  runDependencyCruiserCheck,
  runLizardCheck,
} from "check-suite/src/quality/index.ts";
import {
  defineCommandStep,
  defineInlineStep,
  runGitFileScan,
} from "check-suite/src/step/index.ts";

/** User-facing output paths exposed as `{token}` placeholders to step args. */
const paths = {
  junitPath: "coverage/test-results.xml",
  lcovPath: "coverage/lcov.info",
  playwrightJunitPath: "coverage/playwright-junit.xml",
  playwrightLcovPath: "coverage/playwright/lcov.info",
} satisfies CheckConfig["paths"];

/** Suite-level timeout settings applied before any per-step timeout override. */
const suite = {
  timeoutEnvVar: "CHECK_SUITE_TIMEOUT_MS",
  timeoutMs: 180000,
} satisfies NonNullable<CheckConfig["suite"]>;

// -- summary patterns --

const S_DEP_CRUISE: StepConfig["summary"] = {
  default: "dependency cruise completed",
  patterns: [
    {
      format: "0 dependency violations · {1} modules · {2} dependencies",
      regex:
        "no dependency violations found \\((\\d+) modules, (\\d+) dependencies cruised\\)",
      type: "match",
    },
  ],
  type: "pattern",
};

const S_LINT: StepConfig["summary"] = {
  default: "",
  patterns: [
    {
      format: "{1} problems ({2} errors, {3} warnings)",
      regex:
        "[✖xX]\\s+(\\d+)\\s+problems?\\s*\\((\\d+)\\s+errors?,\\s*(\\d+)\\s+warnings?\\)",
      type: "match",
    },
  ],
  type: "pattern",
};

const S_MADGE: StepConfig["summary"] = {
  default: "circular dependency check completed",
  patterns: [
    {
      format: "0 circular dependencies",
      regex: "No circular dependency found",
      type: "literal",
    },
    {
      format: "{1} circular dependencies",
      regex: "Found\\s+(\\d+)\\s+circular\\s+dependenc",
      type: "match",
    },
  ],
  type: "pattern",
};

const S_LIZARD: StepConfig["summary"] = {
  default: "complexity check completed",
  patterns: [
    {
      format: "{1} function violations · {2} file violations",
      regex:
        "complexity:\\s+(\\d+)\\s+function violations\\s+·\\s+(\\d+)\\s+file violations",
      type: "match",
    },
  ],
  type: "pattern",
};

const S_JSCPD: StepConfig["summary"] = {
  default: "no duplicate stats detected",
  patterns: [
    {
      cellSep: "│",
      format: "{4} clones · {5} lines · {6} tokens · {1} files",
      regex: "│ Total:",
      type: "table-row",
    },
    {
      format: "{1} clones",
      regex: "Found\\s+(\\d+)\\s+clones?",
      type: "match",
    },
  ],
  type: "pattern",
};

const S_TYPE_COV: StepConfig["summary"] = {
  default: "type coverage completed",
  patterns: [
    {
      format: "{3}% ({1}/{2}) · threshold {typeCoverageThreshold}%",
      regex: "\\((\\d+)\\s*/\\s*(\\d+)\\)\\s*([\\d.]+)%",
      type: "match",
    },
  ],
  type: "pattern",
};

const S_TYPES: StepConfig["summary"] = {
  default: "",
  patterns: [
    {
      format: "{count} TypeScript errors",
      regex: ":\\s+error\\s+TS\\d+:",
      type: "count",
    },
  ],
  type: "pattern",
};

const COV_SRC = { excludedPaths: [] as string[], includedPaths: ["src"] };

// Short-name aliases for the flat rule declarations below.
const cmd = defineCommandStep;
const inline = defineInlineStep;

/** Ordered rule definitions that make up the suite entrypoint. */
const steps: CheckConfig["steps"] = [
  cmd({
    args: ["knip", "--config", "knip.json", "--cache"],
    cmd: "bunx",
    failMsg: "knip failed",
    key: "knip",
    label: "knip",
  }),
  cmd({
    args: ["madge@8", "--circular", "--extensions", "ts,tsx", "src"],
    cmd: "bunx",
    failMsg: "circular dependencies found",
    key: "madge",
    label: "madge",
    outputFilter: { pattern: "\\b\\d+\\s+warnings?\\b", type: "stripLines" },
    summary: S_MADGE,
  }),
  inline({
    failMsg: "dependency violations found",
    key: "dependency-cruiser",
    label: "dependency-cruiser",
    source: runConfiguredDependencyCruiserRule,
    summary: S_DEP_CRUISE,
  }),
  inline({
    data: {
      entrypointNames: ["index"],
      includeRootFiles: false,
      maxEntrypointReExports: 12,
      maxInternalImportsPerFile: 12,
      maxSiblingImports: 7,
      minRepeatedDeepImports: 3,
      rootDirectories: ["src"],
      sharedHomeNames: ["types", "contracts", "utils"],
      vendorManagedDirectoryNames: ["__generated__", "generated", "vendor"],
    },
    failMsg: "architecture violations found",
    key: "architecture",
    label: "architecture",
    source: runConfiguredArchitectureRule,
  }),
  inline({
    data: {
      contentGlobs: [
        "src/**/*.{tsx,ts,jsx,js}",
        "src/components/components.css",
      ],
      cssFiles: ["src/app/globals.css"],
      safelists: ["^dark$", "^motion-profile-"],
      selectorPrefix: ".",
    },
    failMsg: "unused CSS selectors found",
    key: "purgecss",
    label: "purgecss",
    source: runConfiguredPurgeCssRule,
  }),
  cmd({
    args: [
      "tsd",
      "--typings",
      "next-env.d.ts",
      "--files",
      "next-env.test-d.ts",
    ],
    cmd: "bunx",
    failMsg: "tsd failed",
    key: "tsd",
    label: "tsd",
  }),
  gitScan({
    command: "bunx",
    failMsg: "secretlint failed",
    fallbackArgs: [
      "secretlint",
      "**/*",
      "--secretlintignore",
      ".secretlintignore",
    ],
    fileArgs: [
      "secretlint",
      "--no-glob",
      "--secretlintignore",
      ".secretlintignore",
    ],
    key: "secretlint",
    label: "secretlint",
  }),
  cmd({
    args: ["audit"],
    cmd: "bun",
    failMsg: "bun audit failed",
    key: "audit",
    label: "audit",
  }),
  cmd({
    args: [
      "scan",
      "--config",
      "p/default",
      "--error",
      "--metrics",
      "off",
      "--exclude=tests",
      "--exclude=src/components/ui",
      "--exclude-rule=javascript.lang.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml",
      "--exclude-rule=typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml",
      "--exclude-rule=problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification",
      "--quiet",
      "src",
    ],
    cmd: "semgrep",
    failMsg: "semgrep failed",
    key: "semgrep",
    label: "semgrep",
  }),
  cmd({
    args: [
      "@0xts/gitleaks-cli",
      "detect",
      "-s",
      "src",
      "--no-git",
      "-c",
      ".gitleaks.toml",
    ],
    cmd: "bunx",
    failMsg: "gitleaks failed",
    key: "@0xts/gitleaks-cli",
    label: "@0xts/gitleaks-cli",
  }),
  cmd({
    args: [
      "type-coverage",
      "--at-least",
      "{typeCoverageThreshold}",
      "--cache",
      "--cache-directory",
      ".cache/type-coverage",
    ],
    cmd: "bunx",
    failMsg: "type coverage below threshold",
    key: "type-coverage",
    label: "type-coverage",
    summary: S_TYPE_COV,
    tokens: { typeCoverageThreshold: 98 },
  }),
  inline({
    data: {
      excludedPaths: ["src/components/ui/*"],
      targets: ["src"],
      thresholds: {
        fileCcn: 60,
        fileFunctionCount: 15,
        fileNloc: 450,
        fileTokenCount: 2200,
        functionCcn: 10,
        functionLength: 80,
        functionNestingDepth: 4,
        functionNloc: 60,
        functionParameterCount: 6,
        functionTokenCount: 240,
      },
    },
    failMsg: "complexity limits exceeded",
    key: "lizard",
    label: "lizard",
    source: runConfiguredLizardRule,
    summary: S_LIZARD,
  }),
  cmd({
    args: ["jscpd", "--config", ".jscpd.json"],
    cmd: "bunx",
    failMsg: "duplicates found",
    key: "jscpd",
    label: "jscpd",
    summary: S_JSCPD,
  }),
  testCoverage({
    allowSuiteFlagArgs: true,
    args: [
      "test",
      "--timeout={testTimeoutMs}",
      "--coverage",
      "--coverage-reporter=lcov",
      "--coverage-dir=coverage",
      "--reporter=junit",
      "--reporter-outfile={junitPath}",
    ],
    cmd: "bun",
    coverage: {
      ...COV_SRC,
      label: "lcov-coverage",
      path: "{lcovPath}",
      reportPath: "{junitPath}",
    },
    defaultThreshold: 85,
    ensureDirs: ["coverage"],
    failMsg: "",
    key: "junit",
    label: "junit",
    serialGroup: "coverage-tests",
    timeoutEnvVar: "CHECK_TEST_COMMAND_TIMEOUT_MS",
    timeoutMs: 120000,
    tokens: { lineCoverageThreshold: 85, testTimeoutMs: 5000 },
  }),
  testCoverage({
    args: ["run", "test:e2e:coverage"],
    cmd: "bun",
    coverage: {
      ...COV_SRC,
      label: "playwright-lcov-coverage",
      path: "{playwrightLcovPath}",
      reportPath: "{playwrightJunitPath}",
    },
    defaultThreshold: 55,
    enabled: "test:e2e:coverage",
    ensureDirs: ["coverage/playwright"],
    failMsg: "playwright e2e failed",
    key: "playwright",
    label: "playwright",
    parseConsoleCoverage: parseBunConsoleCoverage,
    serialGroup: "coverage-tests",
    timeoutDrainMs: 20000,
    timeoutEnvVar: "CHECK_PLAYWRIGHT_TIMEOUT_MS",
    timeoutMs: 180000,
    tokens: { lineCoverageThreshold: 55 },
  }),
  cmd({
    args: ["tsc", "--noEmit"],
    cmd: "bunx",
    failMsg: "typecheck failed",
    key: "types",
    label: "tsc",
    summary: S_TYPES,
  }),
  {
    config: {
      args: [
        "eslint",
        ".",
        "--cache",
        "--cache-strategy",
        "content",
        "--cache-location",
        ".cache/eslint",
        "--fix",
        "--concurrency",
      ],
      globExtensions: ["js", "mjs", "cjs", "ts", "jsx", "tsx"],
      maxFiles: 5000,
      skipDirs: [
        "node_modules",
        ".next",
        "dist",
        "build",
        "coverage",
        ".cache",
      ],
    },
    enabled: true,
    failMsg: "lint failed",
    handler: "lint",
    key: "lint",
    label: "eslint",
    passMsg: "",
    summary: S_LINT,
  },
];

// -- helpers --

/** Options for a git-file-scan-backed inline step such as `secretlint`. */
interface GitScanOptions extends GitFileScanOptions {
  failMsg?: string;
  key: string;
  label: string;
  passMsg?: string;
  summary?: StepConfig["summary"];
}

/** Options for a test-command step with post-process coverage enforcement. */
interface TestCoverageOptions {
  allowSuiteFlagArgs?: boolean;
  args: string[];
  cmd: string;
  coverage: {
    excludedFiles?: string[];
    excludedPaths?: string[];
    includedPaths?: string[];
    label?: string;
    path?: string;
    reportPath?: string;
    threshold?: number | string;
  };
  defaultThreshold: number;
  enabled?: boolean | string;
  ensureDirs?: string[];
  failMsg?: string;
  key: string;
  label: string;
  parseConsoleCoverage?: (
    displayOutput: string,
  ) => null | { covered: number; found: number; pct: number };
  passMsg?: string;
  serialGroup?: string;
  timeoutDrainMs?: number | string;
  timeoutEnvVar?: string;
  timeoutMs?: number | string;
  tokens?: Record<string, number | string>;
}

/** Converts coverage options into the post-process token payload. */
function buildCoverageData(
  coverage: TestCoverageOptions["coverage"],
  defaultThreshold: number,
): Record<string, number | string | string[]> {
  return {
    coverageExcludedFiles: coverage.excludedFiles ?? [],
    coverageExcludedPaths: coverage.excludedPaths ?? [],
    coverageIncludedPaths: coverage.includedPaths ?? ["src"],
    coverageLabel: coverage.label ?? "coverage",
    coveragePath: coverage.path ?? "",
    coverageThreshold: coverage.threshold ?? defaultThreshold,
    reportPath: coverage.reportPath ?? "",
  };
}

/** Builds a git-file-scan-backed inline step. */
function gitScan(options: GitScanOptions): StepConfig {
  return defineInlineStep({
    failMsg: options.failMsg,
    key: options.key,
    label: options.label,
    passMsg: options.passMsg,
    source: ({ cwd }: InlineTypeScriptContext) =>
      runGitFileScan(cwd, {
        command: options.command,
        fallbackArgs: options.fallbackArgs,
        fileArgs: options.fileArgs,
        maxArgLength: options.maxArgLength,
        noFilesMessage:
          options.noFilesMessage ??
          `No tracked or non-ignored files matched for ${options.label}\n`,
      }),
    summary: options.summary,
  });
}

/** Narrows an unknown value to a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrows an unknown value to a string array. */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/** Narrows an unknown value to a finite numeric threshold map. */
function isThresholdMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (v) => typeof v === "number" && Number.isFinite(v),
    )
  );
}

/** Validates the inline lizard payload before passing it to the runtime analyzer. */
function readLizardConfig(value: unknown): LizardConfig | null {
  if (!isRecord(value) || !isStringArray(value.targets)) return null;
  if (value.excludedPaths !== undefined && !isStringArray(value.excludedPaths))
    return null;
  if (value.thresholds !== undefined && !isThresholdMap(value.thresholds))
    return null;
  return {
    ...(value.excludedPaths !== undefined
      ? { excludedPaths: value.excludedPaths }
      : {}),
    targets: value.targets,
    ...(value.thresholds !== undefined ? { thresholds: value.thresholds } : {}),
  };
}

/** Runs the repository-agnostic architecture analyzer against the workspace. */
function runConfiguredArchitectureRule({
  cwd,
  data,
  fail,
  ok,
}: InlineTypeScriptContext): Command {
  const violations = analyzeArchitecture(cwd, data);
  const output = formatArchitectureViolations(violations);
  return violations.length === 0 ? ok(output) : fail(output);
}

/** Runs dependency-cruiser and normalizes the result into the inline command shape. */
async function runConfiguredDependencyCruiserRule({
  cwd,
  existsSync,
  fail,
  ok,
}: InlineTypeScriptContext): Promise<Command> {
  const result = await runDependencyCruiserCheck(cwd, existsSync);
  return result.exitCode === 0 ? ok(result.output) : fail(result.output);
}

/** Runs the lizard complexity analysis after validating the config payload. */
function runConfiguredLizardRule({
  data,
  fail,
  ok,
}: InlineTypeScriptContext): Command {
  const config = readLizardConfig(data);
  if (!config) return fail("lizard config is invalid\n");
  const result = runLizardCheck(config);
  return result.exitCode === 0 ? ok(result.output) : fail(result.output);
}

/** Runs PurgeCSS against the configured content set and reports unused selectors. */
async function runConfiguredPurgeCssRule({
  cwd,
  data,
  fail,
  importModule,
  join,
  ok,
}: InlineTypeScriptContext): Promise<Command> {
  const config = readPurgeCssConfig(data);
  if (!config) return fail("purgecss config is invalid\n");
  const result = await analyzePurgeCss({
    config,
    cwd,
    importModule,
    joinPath: join,
  });
  if (result.kind === "invalid-safelist") return fail(result.message);
  if (result.unusedSelectors.length === 0)
    return ok("no unused CSS selectors found\n");
  return fail(formatUnusedSelectorOutput(result.unusedSelectors));
}

/** Builds a command step backed by post-process line coverage enforcement. */
function testCoverage(options: TestCoverageOptions): StepConfig {
  const {
    allowSuiteFlagArgs,
    args,
    cmd,
    coverage,
    defaultThreshold,
    enabled,
    ensureDirs,
    failMsg,
    key,
    label,
    parseConsoleCoverage,
    passMsg,
    serialGroup,
    timeoutDrainMs,
    timeoutEnvVar,
    timeoutMs,
    tokens,
  } = options;

  return {
    ...(allowSuiteFlagArgs !== undefined && { allowSuiteFlagArgs }),
    args,
    cmd,
    enabled:
      typeof enabled === "string"
        ? hasPackageScript(enabled)
        : (enabled ?? true),
    ...(ensureDirs !== undefined && { ensureDirs }),
    failMsg: failMsg ?? `${label} failed`,
    key,
    label,
    passMsg: passMsg ?? "",
    postProcess: {
      data: buildCoverageData(coverage, defaultThreshold),
      source: buildTestCoveragePostProcess({
        defaultThreshold,
        parseConsoleCoverage,
      }),
    },
    ...(serialGroup !== undefined && { serialGroup }),
    summary: { type: "simple" },
    ...(timeoutDrainMs !== undefined && { timeoutDrainMs }),
    ...(timeoutEnvVar !== undefined && { timeoutEnvVar }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(tokens !== undefined && { tokens }),
  };
}

export default defineCheckSuiteConfig({ paths, steps, suite });
