import { describe, expect, test } from "bun:test";

import { buildFileChangeSignals } from "../src/commit-planning/grouping/file/index.js";
import {
  mergeClusterPass,
  resolveHarmonizedConsolidation,
} from "../src/commit-planning/grouping/group/group-stability.js";
import { absorbIncidentalAdjacentGroups } from "../src/commit-planning/grouping/group/index.js";
import { normalizeBroadSupportGroups } from "../src/commit-planning/grouping/group/normalization.js";
import {
  areDescriptionsRelatedByPrefix,
  mergeGroupsByNormalizedSubject,
  MIN_SECONDARY_EXACT_MERGE_WORD_COUNT,
} from "../src/commit-planning/grouping/group/same-subject-merge.js";
import { type FileDiff } from "../src/git/diff.js";

function makeFileDiff(path: string, hunkCount: number): FileDiff {
  return {
    additions: 0,
    deletions: 0,
    hunks: Array.from({ length: hunkCount }, (_, index) => ({
      countNew: 1,
      countOld: 1,
      header: `@@ -${String(index + 1)},1 +${String(index + 1)},1 @@`,
      lines: [],
      startNew: index + 1,
      startOld: index + 1,
    })),
    oldPath: path,
    path,
    status: "modified",
  };
}

describe("group-finalization", () => {
  test("absorbs a tiny same-surface follow-up into the previous broader commit", () => {
    const fileByPath = new Map([
      ["src/cli/main.ts", makeFileDiff("src/cli/main.ts", 2)],
      [
        "src/cli/output-presentation.ts",
        makeFileDiff("src/cli/output-presentation.ts", 0),
      ],
    ]);

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [
            { path: "src/cli/output-presentation.ts" },
            { hunks: [0], path: "src/cli/main.ts" },
          ],
          message: [
            "refactor(cli): centralize plan and status rendering primitives",
            "",
            "- Extract shared output helpers.",
            "- Replace inline render paths with presentation helpers.",
          ].join("\n"),
        },
        {
          files: [{ hunks: [1], path: "src/cli/main.ts" }],
          message: [
            "fix(cli): normalize usage section title casing",
            "",
            "- Correct the usage summary title casing.",
          ].join("\n"),
        },
      ],
      fileByPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { path: "src/cli/output-presentation.ts" },
      { hunks: [0, 1], path: "src/cli/main.ts" },
    ]);
    expect(result[0]?.message).toContain(
      "refactor(cli): centralize plan and status rendering primitives",
    );
    expect(result[0]?.message).toContain(
      "Correct the usage summary title casing.",
    );
  });

  test("keeps a tiny follow-up separate when it changes a different surface", () => {
    const fileByPath = new Map([
      ["src/cli/main.ts", makeFileDiff("src/cli/main.ts", 1)],
      [
        "src/commit-planning/response-validation.ts",
        makeFileDiff("src/commit-planning/response-validation.ts", 1),
      ],
    ]);

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [{ hunks: [0], path: "src/cli/main.ts" }],
          message: [
            "refactor(cli): centralize plan and status rendering primitives",
            "",
            "- Extract shared output helpers.",
            "- Replace inline render paths with presentation helpers.",
          ].join("\n"),
        },
        {
          files: [
            { hunks: [0], path: "src/commit-planning/response-validation.ts" },
          ],
          message: [
            "fix(response-validation): resolve safe extension drift in file paths",
            "",
            "- Accept unique extension drift safely.",
          ].join("\n"),
        },
      ],
      fileByPath,
    );

    expect(result).toHaveLength(2);
  });

  test("keeps adjacent follow-ups separate when they only share a broad feature root", () => {
    const fileByPath = new Map([
      [
        "src/commit-planning/grouping/repartition.ts",
        makeFileDiff("src/commit-planning/grouping/repartition.ts", 1),
      ],
      [
        "src/commit-planning/path/resolver.ts",
        makeFileDiff("src/commit-planning/path/resolver.ts", 1),
      ],
    ]);

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [
            {
              hunks: [0],
              path: "src/commit-planning/grouping/repartition.ts",
            },
          ],
          message: [
            "fix(grouping): keep weak broad test support from forced attachment",
            "",
            "- Preserve standalone support groups when evidence is weak.",
          ].join("\n"),
        },
        {
          files: [{ hunks: [0], path: "src/commit-planning/path/resolver.ts" }],
          message: [
            "fix(path): resolve unique basenames with directory checks",
            "",
            "- Recover canonical file paths safely.",
          ].join("\n"),
        },
      ],
      fileByPath,
    );

    expect(result).toHaveLength(2);
  });

  test("merges a tiny test-only fragment into the broader adjacent support bucket when they share the same file", () => {
    const fileByPath = new Map([
      [
        "tests/group-finalization.test.ts",
        makeFileDiff("tests/group-finalization.test.ts", 4),
      ],
      [
        "tests/plan-display.test.ts",
        makeFileDiff("tests/plan-display.test.ts", 1),
      ],
    ]);

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [{ hunks: [3], path: "tests/group-finalization.test.ts" }],
          message: [
            "test(group-finalization): expand premerge and consolidation guardrails",
            "",
            "- Cover the new adjacent absorption guardrail.",
          ].join("\n"),
        },
        {
          files: [
            { hunks: [0, 1, 2], path: "tests/group-finalization.test.ts" },
            { hunks: [0], path: "tests/plan-display.test.ts" },
          ],
          message: [
            "style(tests): normalize test formatting and newline endings",
            "",
            "- Reflow long assertions and keep layout-only test edits together.",
          ].join("\n"),
        },
      ],
      fileByPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { hunks: [0, 1, 2, 3], path: "tests/group-finalization.test.ts" },
      { hunks: [0], path: "tests/plan-display.test.ts" },
    ]);
    expect(result[0]?.message.split("\n")[0]).toBe(
      "style(tests): normalize test formatting and newline endings",
    );
  });

  test("preserves a compact incidental-rollout test family when one scope is only a coverage variant", () => {
    const aiCoverageFile = makeFileDiff("tests/ai-coverage.test.ts", 1);
    const aiTestFile = makeFileDiff("tests/ai.test.ts", 1);
    const cliTestFile = makeFileDiff("tests/cli.test.ts", 1);
    const groupFinalizationTestFile = makeFileDiff(
      "tests/group-finalization.test.ts",
      1,
    );
    const group = {
      files: [
        { path: aiCoverageFile.path },
        { path: aiTestFile.path },
        { path: cliTestFile.path },
        { path: groupFinalizationTestFile.path },
      ],
      message: [
        "test(ai): cover incidental merge rules for adjacent rollouts",
        "",
        "- Keep exact-scope follow-up coverage together with the broader incidental rollout family.",
      ].join("\n"),
    };
    const fileByPath = new Map([
      [aiCoverageFile.path, aiCoverageFile],
      [aiTestFile.path, aiTestFile],
      [cliTestFile.path, cliTestFile],
      [groupFinalizationTestFile.path, groupFinalizationTestFile],
    ]);

    // `ai` and `ai-coverage` should count as one aligned support family token.
    const result = normalizeBroadSupportGroups([group], [group], fileByPath);

    expect(result).toEqual([group]);
  });

  test("merges a tiny same-feature style fragment into the broader adjacent style bucket", () => {
    const fileByPath = new Map([
      [
        "src/commit-planning/grouping/group/finalization.ts",
        makeFileDiff("src/commit-planning/grouping/group/finalization.ts", 1),
      ],
      [
        "src/commit-planning/response-validation.ts",
        makeFileDiff("src/commit-planning/response-validation.ts", 1),
      ],
      [
        "src/commit-planning/token-estimation.ts",
        makeFileDiff("src/commit-planning/token-estimation.ts", 1),
      ],
    ]);

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [
            { hunks: [0], path: "src/commit-planning/response-validation.ts" },
            { hunks: [0], path: "src/commit-planning/token-estimation.ts" },
          ],
          message: [
            "style(planning): reflow wrapped lines in planning helpers",
            "",
            "- Reformat long imports and signatures for readability.",
            "- Keep behavior unchanged while normalizing source layout.",
          ].join("\n"),
        },
        {
          files: [
            {
              hunks: [0],
              path: "src/commit-planning/grouping/group/finalization.ts",
            },
          ],
          message: [
            "style(grouping): wrap cluster event calls for readability",
            "",
            "- Reformat cluster event calls onto multiple lines without changing behavior.",
          ].join("\n"),
        },
      ],
      fileByPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { hunks: [0], path: "src/commit-planning/response-validation.ts" },
      { hunks: [0], path: "src/commit-planning/token-estimation.ts" },
      {
        hunks: [0],
        path: "src/commit-planning/grouping/group/finalization.ts",
      },
    ]);
    expect(result[0]?.message.split("\n")[0]).toBe(
      "style(planning): reflow wrapped lines in planning helpers",
    );
    expect(result[0]?.message).toContain(
      "Reformat cluster event calls onto multiple lines without changing behavior.",
    );
  });

  test("merges a same-file style shard into a broader mixed-area adjacent rollout", () => {
    const fileByPath = new Map([
      [
        "src/cli/resume/execution.ts",
        makeFileDiff("src/cli/resume/execution.ts", 1),
      ],
      [
        "src/commit-planning/plan-bundles/service.ts",
        makeFileDiff("src/commit-planning/plan-bundles/service.ts", 1),
      ],
      ["tests/cli.test.ts", makeFileDiff("tests/cli.test.ts", 2)],
    ]);

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [
            { path: "src/cli/resume/execution.ts" },
            { path: "src/commit-planning/plan-bundles/service.ts" },
            { hunks: [1], path: "tests/cli.test.ts" },
          ],
          message: [
            "feat(resume): add saved bundle listing and strict replay modes",
            "",
            "- Add resume listing and strict replay coverage wiring.",
          ].join("\n"),
        },
        {
          files: [{ hunks: [0], path: "tests/cli.test.ts" }],
          message: [
            "style(cli): remove duplicate mkdirSync import",
            "",
            "- Deduplicate the test import list without changing behavior.",
          ].join("\n"),
        },
      ],
      fileByPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { path: "src/cli/resume/execution.ts" },
      { path: "src/commit-planning/plan-bundles/service.ts" },
      { hunks: [0, 1], path: "tests/cli.test.ts" },
    ]);
    expect(result[0]?.message.split("\n")[0]).toBe(
      "feat(resume): add saved bundle listing and strict replay modes",
    );
  });

  test("merges adjacent same-feature implementation rollouts when docs and coverage are attached on opposite sides", () => {
    const fileByPath = new Map([
      ["README.md", makeFileDiff("README.md", 5)],
      [
        "src/cli/commit/execution.ts",
        makeFileDiff("src/cli/commit/execution.ts", 5),
      ],
      [
        "src/cli/execution-flow.ts",
        makeFileDiff("src/cli/execution-flow.ts", 11),
      ],
      ["src/cli/main.ts", makeFileDiff("src/cli/main.ts", 8)],
      ["src/cli/options.ts", makeFileDiff("src/cli/options.ts", 5)],
      [
        "src/cli/resume/execution.ts",
        makeFileDiff("src/cli/resume/execution.ts", 6),
      ],
      ["src/cli/resume/index.ts", makeFileDiff("src/cli/resume/index.ts", 1)],
      [
        "src/cli/resume/options.ts",
        makeFileDiff("src/cli/resume/options.ts", 1),
      ],
      [
        "tests/zz-cli-coverage.test.ts",
        makeFileDiff("tests/zz-cli-coverage.test.ts", 1),
      ],
    ]);

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [
            { path: "src/cli/resume/execution.ts" },
            { path: "src/cli/resume/index.ts" },
            { path: "src/cli/resume/options.ts" },
            { path: "README.md" },
          ],
          message: [
            "feat(resume): add saved bundle listing and strict replay modes",
            "",
            "- Add resume execution support for listing saved bundles and stricter replay flows.",
          ].join("\n"),
        },
        {
          files: [
            { path: "src/cli/options.ts" },
            { path: "src/cli/execution-flow.ts" },
            { path: "src/cli/main.ts" },
            { path: "src/cli/commit/execution.ts" },
            { path: "tests/zz-cli-coverage.test.ts" },
          ],
          message: [
            "feat(cli): add saved bundle listing and strict replay modes",
            "",
            "- Wire CLI execution, commit flows, and coverage for saved bundle listing.",
            "- Pass strict replay validation through the CLI surface.",
          ].join("\n"),
        },
      ],
      fileByPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { path: "src/cli/resume/execution.ts" },
      { path: "src/cli/resume/index.ts" },
      { path: "src/cli/resume/options.ts" },
      { path: "README.md" },
      { path: "src/cli/options.ts" },
      { path: "src/cli/execution-flow.ts" },
      { path: "src/cli/main.ts" },
      { path: "src/cli/commit/execution.ts" },
      { path: "tests/zz-cli-coverage.test.ts" },
    ]);
    expect(result[0]?.message.split("\n")[0]).toBe(
      "feat(cli): add saved bundle listing and strict replay modes",
    );
    expect(result[0]?.message).toContain(
      "Add resume execution support for listing saved bundles and stricter replay flows.",
    );
    expect(result[0]?.message).toContain(
      "Wire CLI execution, commit flows, and coverage for saved bundle listing.",
    );
  });

  test("merges a tiny subject-only diff shard into the broader adjacent git-support bucket", () => {
    const fileByPath = new Map([
      ["tests/diff.test.ts", makeFileDiff("tests/diff.test.ts", 1)],
      [
        "tests/git-coverage.test.ts",
        makeFileDiff("tests/git-coverage.test.ts", 2),
      ],
      ["tests/git-header.test.ts", makeFileDiff("tests/git-header.test.ts", 1)],
    ]);

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [
            { hunks: [0, 1], path: "tests/git-coverage.test.ts" },
            { hunks: [0], path: "tests/git-header.test.ts" },
          ],
          message: [
            "test(git): isolate integration repos from global git settings",
            "",
            "- Add shared Git test setup that disables signing and hooks.",
          ].join("\n"),
        },
        {
          files: [{ hunks: [0], path: "tests/diff.test.ts" }],
          message:
            "test(diff): isolate integration repos from global git settings",
        },
      ],
      fileByPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { hunks: [0, 1], path: "tests/git-coverage.test.ts" },
      { hunks: [0], path: "tests/git-header.test.ts" },
      { hunks: [0], path: "tests/diff.test.ts" },
    ]);
    expect(result[0]?.message.split("\n")[0]).toBe(
      "test(git): isolate integration repos from global git settings",
    );
  });

  test("rejects a broad cluster merge when stabilization restores most live-shaped commit-planning ownership slices", () => {
    const groups = [
      {
        files: [
          { path: "src/cli/execution-flow.ts" },
          { path: "src/cli/index.ts" },
          { path: "src/cli/interactive-prompt.ts" },
          { path: "src/cli/main.ts" },
          { path: "src/cli/options.ts" },
        ],
        message: [
          "feat(cli): add resumable plan bundles and resume selection flags",
          "",
          "- Keep resume command wiring and selection parsing on the CLI surface.",
        ].join("\n"),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/support-attachment/selection.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/single-owner-anchor.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/test-ownership.ts",
          },
          { path: "src/commit-planning/grouping/surface-rollout-shape.ts" },
        ],
        message: [
          "feat(grouping): add support-attachment ownership heuristics",
          "",
          "- Keep ownership rejection and rollout-shape heuristics on the grouping surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/prompt-builders/cluster-prompts.ts" },
          { path: "src/commit-planning/prompt-builders/commit-format.ts" },
          {
            path: "src/commit-planning/prompt-builders/consolidation-prompts.ts",
          },
          {
            path: "src/commit-planning/prompt-builders/generation-prompts.ts",
          },
          {
            path: "src/commit-planning/prompt-builders/grouping-prompts.ts",
          },
          { path: "src/commit-planning/prompts/context/diff-context.ts" },
          { path: "src/commit-planning/prompts/index.ts" },
          { path: "src/commit-planning/prompts/rules/cluster-merge.ts" },
          {
            path: "src/commit-planning/prompts/rules/commit/generation.ts",
          },
          { path: "src/commit-planning/prompts/rules/commit/index.ts" },
          { path: "src/commit-planning/prompts/rules/commit/message.ts" },
          { path: "src/commit-planning/prompts/rules/formatting.ts" },
          { path: "src/commit-planning/prompts/rules/hunk-grouping.ts" },
        ],
        message: [
          "refactor(prompts): centralize prompt rules into reusable modules",
          "",
          "- Keep prompt builders, prompt rules, and prompt entrypoints on the prompts surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/path/structure.ts" },
          { path: "src/commit-planning/plan-bundles/hashes.ts" },
          { path: "src/commit-planning/plan-bundles/index.ts" },
          { path: "src/commit-planning/plan-bundles/schemas.ts" },
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/plan-bundles/storage.ts" },
          { path: "src/commit-planning/planned-commit-clone.ts" },
          { path: "src/commit-planning/planning-workflow.ts" },
        ],
        message: [
          "feat(planning): add persisted plan bundles with integrity checks",
          "",
          "- Keep bundle persistence, hashing, storage, and cloned-plan workflow changes together.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/path-resolver.ts" },
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/index.ts" },
          {
            path: "src/commit-planning/path/repository-structure.ts",
          },
          { path: "src/commit-planning/path/resolver.ts" },
        ],
        message: [
          "feat(path): expand file alias resolution across repo path shapes",
          "",
          "- Keep alias, repository-structure, and path-resolver work together.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/baseline-restoration.ts" },
          { path: "src/commit-planning/grouping/dependency/rules.ts" },
          { path: "src/commit-planning/grouping/file/extraction.ts" },
        ],
        message: [
          "feat(grouping): strengthen baseline restoration and alias-aware signals",
          "",
          "- Keep baseline restoration, alias extraction, and dependency rules on the grouping surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/prompts/rules/index.ts" },
          {
            path: "src/commit-planning/prompts/rules/plan-consolidation.ts",
          },
          {
            path: "src/commit-planning/prompts/rules/semantic-planning.ts",
          },
          { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
          {
            path: "src/commit-planning/prompts/stages/commit-generation.ts",
          },
          { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
          { path: "src/commit-planning/prompts/stages/index.ts" },
          {
            path: "src/commit-planning/prompts/stages/plan-consolidation.ts",
          },
          { path: "src/commit-planning/response-validation.ts" },
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
        ],
        message: [
          "feat(commit-planning): add modular prompt stages and breaking-aware planning",
          "",
          "- Keep prompt stages, prompt rules, validation, caching, and token estimation together.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/style-splitting/service.ts" },
        ],
        message: [
          "feat(grouping): split broad style commits by ownership boundaries",
          "",
          "- Keep style repartitioning isolated from neighboring rollout work.",
        ].join("\n"),
      },
      {
        files: [{ path: "tests/plan-bundles.test.ts" }],
        message: [
          "test(plan-bundles): add end-to-end coverage for persisted resume data",
          "",
          "- Keep saved-plan bundle coverage isolated from production rollout commits.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/subject/premerge/index.ts" },
          {
            path: "src/commit-planning/grouping/subject/premerge/service.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
          },
          { path: "src/commit-planning/grouping/support-attachment/index.ts" },
          {
            path: "src/commit-planning/grouping/support-attachment/scoring.ts",
          },
        ],
        message: [
          "feat(grouping): add deterministic premerge and support attachment",
          "",
          "- Keep subject premerge clustering and core support attachment routing together.",
        ].join("\n"),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFileDiff(file.path, 1)),
    );

    const result = mergeClusterPass(
      groups,
      [[1, 2, 3, 4, 5, 6]],
      new Map(allFiles.map((file) => [file.path, file])),
      buildFileChangeSignals(allFiles),
    );

    expect(result).toBeNull();
  });

  test("rejects a live-shaped commit-planning umbrella when repartition still restores most ownership slices", () => {
    const groups = [
      {
        files: [
          { path: "src/cli/execution-flow.ts" },
          { path: "src/cli/index.ts" },
          { path: "src/cli/interactive-prompt.ts" },
          { path: "src/cli/main.ts" },
          { path: "src/cli/options.ts" },
        ],
        message: [
          "feat(cli): add resumable plan bundles and resume selection flags",
          "",
          "- Keep resume command wiring and selection parsing on the CLI surface.",
        ].join("\n"),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/support-attachment/selection.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/single-owner-anchor.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/test-ownership.ts",
          },
          { path: "src/commit-planning/grouping/surface-rollout-shape.ts" },
        ],
        message: [
          "feat(grouping): add support-attachment ownership heuristics",
          "",
          "- Keep ownership rejection and rollout-shape heuristics on the grouping surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/prompt-builders/cluster-prompts.ts" },
          { path: "src/commit-planning/prompt-builders/commit-format.ts" },
          {
            path: "src/commit-planning/prompt-builders/consolidation-prompts.ts",
          },
          {
            path: "src/commit-planning/prompt-builders/generation-prompts.ts",
          },
          {
            path: "src/commit-planning/prompt-builders/grouping-prompts.ts",
          },
          { path: "src/commit-planning/prompts/context/diff-context.ts" },
          { path: "src/commit-planning/prompts/index.ts" },
          { path: "src/commit-planning/prompts/rules/cluster-merge.ts" },
          {
            path: "src/commit-planning/prompts/rules/commit/generation.ts",
          },
          { path: "src/commit-planning/prompts/rules/commit/index.ts" },
          { path: "src/commit-planning/prompts/rules/commit/message.ts" },
          { path: "src/commit-planning/prompts/rules/formatting.ts" },
          { path: "src/commit-planning/prompts/rules/hunk-grouping.ts" },
        ],
        message: [
          "refactor(prompts): centralize prompt rules into reusable modules",
          "",
          "- Keep prompt builders, prompt rules, and prompt entrypoints on the prompts surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/path/structure.ts" },
          { path: "src/commit-planning/plan-bundles/hashes.ts" },
          { path: "src/commit-planning/plan-bundles/index.ts" },
          { path: "src/commit-planning/plan-bundles/schemas.ts" },
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/plan-bundles/storage.ts" },
          { path: "src/commit-planning/planned-commit-clone.ts" },
          { path: "src/commit-planning/planning-workflow.ts" },
        ],
        message: [
          "feat(planning): add persisted plan bundles with integrity checks",
          "",
          "- Keep bundle persistence, hashing, storage, and cloned-plan workflow changes together.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/path-resolver.ts" },
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/index.ts" },
          {
            path: "src/commit-planning/path/repository-structure.ts",
          },
          { path: "src/commit-planning/path/resolver.ts" },
        ],
        message: [
          "feat(path): expand file alias resolution across repo path shapes",
          "",
          "- Keep alias, repository-structure, and path-resolver work together.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/baseline-restoration.ts" },
          { path: "src/commit-planning/grouping/dependency/rules.ts" },
          { path: "src/commit-planning/grouping/file/extraction.ts" },
        ],
        message: [
          "feat(grouping): strengthen baseline restoration and alias-aware signals",
          "",
          "- Keep baseline restoration, alias extraction, and dependency rules on the grouping surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/prompts/rules/index.ts" },
          {
            path: "src/commit-planning/prompts/rules/plan-consolidation.ts",
          },
          {
            path: "src/commit-planning/prompts/rules/semantic-planning.ts",
          },
          { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
          {
            path: "src/commit-planning/prompts/stages/commit-generation.ts",
          },
          { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
          { path: "src/commit-planning/prompts/stages/index.ts" },
          {
            path: "src/commit-planning/prompts/stages/plan-consolidation.ts",
          },
          { path: "src/commit-planning/response-validation.ts" },
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
        ],
        message: [
          "feat(commit-planning): add modular prompt stages and breaking-aware planning",
          "",
          "- Keep prompt stages, prompt rules, validation, caching, and token estimation together.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/style-splitting/service.ts" },
        ],
        message: [
          "feat(grouping): split broad style commits by ownership boundaries",
          "",
          "- Keep style repartitioning isolated from neighboring rollout work.",
        ].join("\n"),
      },
      {
        files: [{ path: "tests/plan-bundles.test.ts" }],
        message: [
          "test(plan-bundles): add end-to-end coverage for persisted resume data",
          "",
          "- Keep saved-plan bundle coverage isolated from production rollout commits.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/subject/premerge/index.ts" },
          {
            path: "src/commit-planning/grouping/subject/premerge/service.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
          },
          { path: "src/commit-planning/grouping/support-attachment/index.ts" },
          {
            path: "src/commit-planning/grouping/support-attachment/scoring.ts",
          },
        ],
        message: [
          "feat(grouping): add deterministic premerge and support attachment",
          "",
          "- Keep subject premerge clustering and core support attachment routing together.",
        ].join("\n"),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFileDiff(file.path, 1)),
    );
    const fileByPath = new Map(allFiles.map((file) => [file.path, file]));

    const result = resolveHarmonizedConsolidation(
      groups,
      [
        {
          files: groups.flatMap((group) => group.files),
          message: [
            "feat(commit-planning): add modular prompt stages and breaking-aware planning",
            "",
            "- Fold prompt stages, path aliases, plan bundles, support routing, and CLI resume flows into one umbrella feature.",
            "- Thread breaking-aware planning and shared prompt mode behavior through the same broad planning rollout.",
          ].join("\n"),
        },
      ],
      fileByPath,
      buildFileChangeSignals(allFiles),
      performance.now(),
    );

    expect(result).toBeNull();
  });

  test("rejects an implementation-only umbrella when repartition still leaves one dominant multi-owner mega group", () => {
    const groups = [
      {
        files: [
          { path: "src/commit-messages/breaking-change-footers.ts" },
          { path: "src/commit-messages/subject-parser.ts" },
        ],
        message: [
          "fix(commit-messages): validate breaking metadata and normalized scopes",
          "",
          "- Keep breaking footer validation and scope normalization on the commit-message surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/prompts/rules/index.ts" },
          { path: "src/commit-planning/prompts/stages/plan-consolidation.ts" },
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
        ],
        message: [
          "fix(commit-planning): centralize prompt rules and breaking-aware caching",
          "",
          "- Keep prompt stages, cache identity, and token estimation on the commit-planning surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/group/adjacent/absorption.ts" },
          { path: "src/commit-planning/grouping/group/consolidation-shape.ts" },
          { path: "src/commit-planning/grouping/group/group-stability.ts" },
        ],
        message: [
          "fix(grouping-group): tighten adjacent absorption and consolidation stability",
          "",
          "- Keep adjacent absorption boundaries and consolidation stability on the nested group surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/implementation-components.ts" },
          {
            path: "src/commit-planning/grouping/implementation-merge/service.ts",
          },
          {
            path: "src/commit-planning/grouping/implementation-merge/rollout-signal.ts",
          },
        ],
        message: [
          "fix(grouping): tighten implementation merge rollout boundaries",
          "",
          "- Keep implementation component partitioning and rollout-signal guards on the grouping surface.",
        ].join("\n"),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/compact-rollout-merge.ts",
          },
          { path: "src/commit-planning/grouping/subject/path-areas.ts" },
        ],
        message: [
          "fix(grouping): tighten subject rollout merges to contextual path areas",
          "",
          "- Keep compact rollout heuristics and path-area guards together on the subject surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/group/events.ts" },
          { path: "src/commit-planning/grouping/group/finalization.ts" },
          {
            path: "src/commit-planning/grouping/group/message-harmonization.ts",
          },
        ],
        message: [
          "fix(grouping-group): salvage coverage-safe consolidation and message repair",
          "",
          "- Keep fallback events, finalization, and message harmonization on the nested group surface.",
        ].join("\n"),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFileDiff(file.path, 1)),
    );
    const fileByPath = new Map(allFiles.map((file) => [file.path, file]));

    const result = resolveHarmonizedConsolidation(
      groups,
      [
        {
          files: groups.flatMap((group) => group.files),
          message: [
            "fix(commit-planning): centralize prompt rules and honor breaking mode",
            "",
            "- Fold commit-message validation, prompt rules, grouping stability, implementation merge guards, and subject rollout checks into one umbrella fix.",
            "- Keep cache identity, message harmonization, and fallback events aligned in the same broad planning rollout.",
          ].join("\n"),
        },
      ],
      fileByPath,
      buildFileChangeSignals(allFiles),
      performance.now(),
    );

    expect(result).toBeNull();
  });

  test("rejects a trace-shaped commit-planning mega-umbrella that still leaves one dominant planner group plus narrow test survivors", () => {
    const groups = [
      {
        files: [
          { path: "src/commit-planning/prompts/index.ts" },
          { path: "src/commit-planning/prompts/rules/commit/generation.ts" },
          { path: "src/commit-planning/prompts/rules/commit/index.ts" },
          { path: "src/commit-planning/prompts/rules/commit/message.ts" },
          { path: "src/commit-planning/prompts/rules/formatting.ts" },
          { path: "src/commit-planning/prompts/rules/hunk-grouping.ts" },
          { path: "src/commit-planning/prompts/rules/index.ts" },
          { path: "src/commit-planning/prompts/rules/plan-consolidation.ts" },
          { path: "src/commit-planning/prompts/rules/semantic-planning.ts" },
          { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
          { path: "src/commit-planning/prompts/stages/commit-generation.ts" },
          { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
          { path: "src/commit-planning/prompts/stages/index.ts" },
          { path: "src/commit-planning/prompts/stages/plan-consolidation.ts" },
        ],
        message: [
          "feat(prompts): centralize prompt rule builders by planning stage",
          "",
          "- Keep shared prompt rules and stage builders on the prompts surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/index.ts" },
          { path: "src/commit-planning/path/repository-structure.ts" },
          { path: "src/commit-planning/path/resolver.ts" },
          { path: "src/commit-planning/path/structure.ts" },
        ],
        message: [
          "feat(path): expand structural planner path resolution",
          "",
          "- Keep alias expansion and repository-structure discovery together on the path surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/plan-bundles/hashes.ts" },
          { path: "src/commit-planning/plan-bundles/index.ts" },
          { path: "src/commit-planning/plan-bundles/resume/index.ts" },
          {
            path: "src/commit-planning/plan-bundles/resume/plan-commit-mismatch.ts",
          },
          { path: "src/commit-planning/plan-bundles/resume/preparation.ts" },
          { path: "src/commit-planning/plan-bundles/resume/validation.ts" },
          { path: "src/commit-planning/plan-bundles/schemas.ts" },
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/plan-bundles/storage.ts" },
          { path: "src/commit-planning/planned-commit-clone.ts" },
        ],
        message: [
          "feat(plan-bundles): add persisted bundle integrity and resume safeguards",
          "",
          "- Keep bundle hashing, persisted metadata, and resume preparation on the saved-plan surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/baseline-restoration.ts" },
          { path: "src/commit-planning/grouping/component-routing.ts" },
          { path: "src/commit-planning/grouping/ownership.ts" },
          { path: "src/commit-planning/grouping/preservation-rules.ts" },
          { path: "src/commit-planning/grouping/structural-fanout.ts" },
          {
            path: "src/commit-planning/grouping/weak-consolidation-preservation.ts",
          },
          {
            path: "src/commit-planning/grouping/group/feature-surface-heuristics.ts",
          },
          { path: "src/commit-planning/grouping/group/normalization.ts" },
          {
            path: "src/commit-planning/grouping/group/ownership-boundaries.ts",
          },
          { path: "src/commit-planning/grouping/group/primary-subject.ts" },
          {
            path: "src/commit-planning/grouping/group/rollout-preservation.ts",
          },
          { path: "src/commit-planning/grouping/group/split-trace-events.ts" },
          {
            path: "src/commit-planning/grouping/group/structural-owner-splitting.ts",
          },
          { path: "src/commit-planning/grouping/group/consolidation-shape.ts" },
          { path: "src/commit-planning/grouping/group/coverage-salvage.ts" },
          {
            path: "src/commit-planning/grouping/group/covered-message-resolution.ts",
          },
          { path: "src/commit-planning/grouping/group/events.ts" },
          { path: "src/commit-planning/grouping/group/finalization.ts" },
          {
            path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
          },
          { path: "src/commit-planning/grouping/support-attachment/index.ts" },
          {
            path: "src/commit-planning/grouping/support-attachment/ownership-words.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/scoring.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/selection.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/single-owner-anchor.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/test-ownership.ts",
          },
          { path: "src/commit-planning/grouping/surface-rollout-shape.ts" },
          { path: "src/commit-planning/orchestration.ts" },
          { path: "src/commit-planning/planning-workflow.ts" },
        ],
        message: [
          "feat(grouping): add ownership-aware consolidation and support routing",
          "",
          "- Keep grouping fallback repair, support attachment, and trace diagnostics on the grouping surface.",
        ].join("\n"),
      },
      {
        files: [
          { path: "tests/planner-helpers.test.ts" },
          { path: "tests/response-validation.test.ts" },
          { path: "tests/terminal-line-wrapping.test.ts" },
        ],
        message: [
          "test(commit-planning): expand helper and validation coverage for the planner refactor",
          "",
          "- Keep helper, validation, and terminal wrapping assertions outside the implementation rollout.",
        ].join("\n"),
      },
    ];
    const allFiles = groups.flatMap((group) =>
      group.files.map((file) => makeFileDiff(file.path, 1)),
    );
    const fileByPath = new Map(allFiles.map((file) => [file.path, file]));

    const result = resolveHarmonizedConsolidation(
      groups,
      [
        {
          files: groups.flatMap((group) => group.files),
          message: [
            "feat(commit-planning): centralize prompt rule builders by planning stage",
            "",
            "- Fold prompt rules, path utilities, plan bundles, grouping heuristics, and planner helper coverage into one umbrella feature.",
            "- Keep breaking-aware planning and resume-safe bundle behavior aligned in the same broad planner rollout.",
          ].join("\n"),
        },
      ],
      fileByPath,
      buildFileChangeSignals(allFiles),
      performance.now(),
    );

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// areDescriptionsRelatedByPrefix
// ---------------------------------------------------------------------------
describe("areDescriptionsRelatedByPrefix", () => {
  test("returns true when shorter description is a word-prefix of longer", () => {
    expect(
      areDescriptionsRelatedByPrefix(
        "add resume subcommand parsing and strict",
        "add resume subcommand parsing and strict hash checks",
      ),
    ).toBe(true);
  });

  test("returns true for identical descriptions (degenerate prefix)", () => {
    expect(
      areDescriptionsRelatedByPrefix(
        "anchor support files on exact descriptions",
        "anchor support files on exact descriptions",
      ),
    ).toBe(true);
  });

  test("returns true regardless of argument order (symmetric)", () => {
    expect(
      areDescriptionsRelatedByPrefix(
        "add resume subcommand parsing and strict hash checks",
        "add resume subcommand parsing and strict",
      ),
    ).toBe(true);
  });

  test("returns false when shorter description has fewer than 4 words", () => {
    // "add button" is only 2 words — below the minimum threshold.
    expect(
      areDescriptionsRelatedByPrefix("add button", "add button handler click"),
    ).toBe(false);
  });

  test("returns false when exactly 3 words (boundary below minimum)", () => {
    expect(
      areDescriptionsRelatedByPrefix("add foo bar", "add foo bar baz qux quux"),
    ).toBe(false);
  });

  test("returns true when exactly 4 words (boundary at minimum)", () => {
    expect(
      areDescriptionsRelatedByPrefix(
        "add foo bar baz",
        "add foo bar baz qux quux",
      ),
    ).toBe(true);
  });

  test("returns false when descriptions share no common prefix", () => {
    expect(
      areDescriptionsRelatedByPrefix(
        "anchor support files on exact descriptions",
        "refactor path resolver to derive roots dynamically",
      ),
    ).toBe(false);
  });

  test("returns false when shorter description diverges mid-sequence", () => {
    // First 4 words match but word 5 differs — not a prefix.
    expect(
      areDescriptionsRelatedByPrefix(
        "add resume subcommand parsing strict",
        "add resume subcommand parsing and strict hash checks",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeGroupsByNormalizedSubject — same-description / type-agnostic merging
// ---------------------------------------------------------------------------
describe("mergeGroupsByNormalizedSubject", () => {
  function makeCommit(message: string, ...paths: string[]) {
    return { files: paths.map((path) => ({ path })), message };
  }

  function makeFileMap(...paths: string[]): Map<string, FileDiff> {
    return new Map(paths.map((path) => [path, makeFileDiff(path, 1)]));
  }

  test("returns single group unchanged", () => {
    const groups = [
      makeCommit(
        "fix(cli): anchor support files on exact descriptions",
        "src/a.ts",
      ),
    ];
    const result = mergeGroupsByNormalizedSubject(
      groups,
      makeFileMap("src/a.ts"),
    );
    expect(result).toHaveLength(1);
  });

  test("merges two commits with identical description but different types", () => {
    // Regression: fix:X and test:X must merge — type must not block merging.
    const groups = [
      makeCommit(
        "fix(grouping): anchor support files on exact descriptions",
        "src/commit-planning/grouping/support-attachment/single-owner-anchor.ts",
      ),
      makeCommit(
        "test(ai): anchor support files on exact descriptions",
        "tests/planner-helpers.test.ts",
      ),
    ];
    const fileByPath = makeFileMap(
      "src/commit-planning/grouping/support-attachment/single-owner-anchor.ts",
      "tests/planner-helpers.test.ts",
    );
    const result = mergeGroupsByNormalizedSubject(groups, fileByPath);
    expect(result).toHaveLength(1);
    expect(result[0]!.files.map((f) => f.path)).toContain(
      "src/commit-planning/grouping/support-attachment/single-owner-anchor.ts",
    );
    expect(result[0]!.files.map((f) => f.path)).toContain(
      "tests/planner-helpers.test.ts",
    );
  });

  test("merges two commits when one description is a word-prefix of the other", () => {
    // Regression: "add resume subcommand parsing and strict" is a prefix of
    // "add resume subcommand parsing and strict hash checks" — must merge.
    const groups = [
      makeCommit(
        "feat(trace): add resume subcommand parsing and strict hash checks",
        "src/cli/trace/coverage.ts",
      ),
      makeCommit(
        "test(session-display-trace-aggregation): add resume subcommand parsing and strict",
        "tests/session-display-trace-aggregation.test.ts",
      ),
    ];
    const fileByPath = makeFileMap(
      "src/cli/trace/coverage.ts",
      "tests/session-display-trace-aggregation.test.ts",
    );
    const result = mergeGroupsByNormalizedSubject(groups, fileByPath);
    expect(result).toHaveLength(1);
    const paths = result[0]!.files.map((f) => f.path);
    expect(paths).toContain("src/cli/trace/coverage.ts");
    expect(paths).toContain("tests/session-display-trace-aggregation.test.ts");
  });

  test("does not merge commits with different unrelated descriptions", () => {
    const groups = [
      makeCommit(
        "fix(grouping): anchor support files on exact descriptions",
        "src/a.ts",
      ),
      makeCommit(
        "refactor(path): derive root segments from path topology",
        "src/b.ts",
      ),
    ];
    const result = mergeGroupsByNormalizedSubject(
      groups,
      makeFileMap("src/a.ts", "src/b.ts"),
    );
    expect(result).toHaveLength(2);
  });

  test("does not prefix-merge when shared prefix is shorter than 4 words", () => {
    const groups = [
      makeCommit("fix(a): add tests", "src/a.ts"),
      makeCommit("fix(b): add tests for longer scenario", "src/b.ts"),
    ];
    const result = mergeGroupsByNormalizedSubject(
      groups,
      makeFileMap("src/a.ts", "src/b.ts"),
    );
    // "add tests" has only 2 words — below MIN_PREFIX_MERGE_WORD_COUNT.
    expect(result).toHaveLength(2);
  });

  test("merges two of three groups while leaving the third alone", () => {
    const groups = [
      makeCommit(
        "fix(grouping): anchor support files on exact descriptions",
        "src/a.ts",
      ),
      makeCommit(
        "refactor(path): derive root segments from path topology",
        "src/b.ts",
      ),
      makeCommit(
        "test(grouping): anchor support files on exact descriptions",
        "tests/a.test.ts",
      ),
    ];
    const fileByPath = makeFileMap("src/a.ts", "src/b.ts", "tests/a.test.ts");
    const result = mergeGroupsByNormalizedSubject(groups, fileByPath);
    expect(result).toHaveLength(2);
    const mergedGroup = result.find((g) =>
      g.files.some((f) => f.path === "src/a.ts"),
    )!;
    expect(mergedGroup.files.map((f) => f.path)).toContain("tests/a.test.ts");
    const separateGroup = result.find((g) =>
      g.files.some((f) => f.path === "src/b.ts"),
    )!;
    expect(separateGroup.files).toHaveLength(1);
  });

  test("merges commits with identical description regardless of scope differences", () => {
    // fix(cli):X vs fix(git):X — same type, different scope — should always merge.
    const groups = [
      makeCommit("fix(cli): enforce body on explicit request only", "src/a.ts"),
      makeCommit("fix(git): enforce body on explicit request only", "src/b.ts"),
    ];
    const result = mergeGroupsByNormalizedSubject(
      groups,
      makeFileMap("src/a.ts", "src/b.ts"),
    );
    expect(result).toHaveLength(1);
  });

  test("does not merge identical 4-word descriptions when minExactMatchWordCount is 5", () => {
    // Regression: secondary pass must not collapse groups whose short (4-word)
    // description coincidentally matches after AI harmonization. These represent
    // distinct change families that repartition already separated (e.g.
    // "tighten merge planning rules" for grouping vs. for tests).
    const groups = [
      makeCommit(
        "refactor(commit-planning-grouping): tighten merge planning rules",
        "src/commit-planning/grouping/index.ts",
      ),
      makeCommit("test(ai): tighten merge planning rules", "tests/ai.test.ts"),
    ];
    const fileByPath = makeFileMap(
      "src/commit-planning/grouping/index.ts",
      "tests/ai.test.ts",
    );
    const result = mergeGroupsByNormalizedSubject(
      groups,
      fileByPath,
      MIN_SECONDARY_EXACT_MERGE_WORD_COUNT,
    );
    // 4 words < MIN_SECONDARY_EXACT_MERGE_WORD_COUNT (5) — must stay separate.
    expect(result).toHaveLength(2);
  });

  test("merges identical 7-word descriptions even with minExactMatchWordCount of 5", () => {
    // Regression: when two groups from separate AI batches both receive the same
    // specific 7-word description (e.g. implementation + test split for the same
    // feature), the secondary finalization pass must merge them.
    const groups = [
      makeCommit(
        "fix(commit-planning-grouping): merge duplicate same-subject commits after stabilization",
        "src/commit-planning/grouping/group/group-stability.ts",
        "src/commit-planning/grouping/group/finalization.ts",
      ),
      makeCommit(
        "test(group-finalization): merge duplicate same-subject commits after stabilization",
        "tests/group-finalization.test.ts",
      ),
    ];
    const fileByPath = makeFileMap(
      "src/commit-planning/grouping/group/group-stability.ts",
      "src/commit-planning/grouping/group/finalization.ts",
      "tests/group-finalization.test.ts",
    );
    const result = mergeGroupsByNormalizedSubject(
      groups,
      fileByPath,
      MIN_SECONDARY_EXACT_MERGE_WORD_COUNT,
    );
    // 7 words >= MIN_SECONDARY_EXACT_MERGE_WORD_COUNT (5) — must merge.
    expect(result).toHaveLength(1);
    const paths = result[0]!.files.map((f) => f.path);
    expect(paths).toContain(
      "src/commit-planning/grouping/group/group-stability.ts",
    );
    expect(paths).toContain("tests/group-finalization.test.ts");
  });
});
