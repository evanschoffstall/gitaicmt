import { describe, expect, test } from "bun:test";

import { evaluateCoveredBaselineFallback } from "../src/commit-planning/grouping/baseline-restoration.js";
import { repartitionByIntent } from "../src/commit-planning/grouping/component-routing.js";
import { buildFileChangeSignals } from "../src/commit-planning/grouping/file/index.js";
import {
  absorbIncidentalAdjacentGroups,
  mergeClusterPass,
} from "../src/commit-planning/grouping/group/index.js";
import {
  harmonizeConsolidatedMessages,
  rescopeGroupMessageToCoveredGroups,
} from "../src/commit-planning/grouping/group/message-harmonization.js";
import { normalizeMixedRootImplementationGroups } from "../src/commit-planning/grouping/group/normalization.js";
import { shouldPreserveFeatureSurfaceRollout } from "../src/commit-planning/grouping/group/rollout-preservation.js";
import { premergeBySubject } from "../src/commit-planning/grouping/index.js";
import { splitWeakConsolidations } from "../src/commit-planning/grouping/repartition.js";
import { shouldPreserveIdenticalRollout } from "../src/commit-planning/grouping/rollout-preservation.js";
import { chooseSupportAttachment } from "../src/commit-planning/grouping/support-attachment/index.js";
import {
  getSupportAttachmentBreadthPenalty,
  getSupportAttachmentScore,
} from "../src/commit-planning/grouping/support-attachment/scoring.js";
import { setAiOutputObserver } from "../src/commit-planning/openai-client.js";
import { type PlannedCommit } from "../src/commit-planning/types.js";
import { type FileDiff } from "../src/git/diff.js";

function commitMessage(subject: string, ...bullets: string[]): string {
  const body = bullets.length === 0 ? ["- Summarize the change."] : bullets;
  return [subject, "", ...body].join("\n");
}

/**
 * Mirrors the last fallback repair step where adjacent tiny follow-up commits
 * should be absorbed into the broader neighboring rollout instead of surviving
 * as standalone shards.
 */
function expectAdjacentGroupsToMerge(options: {
  allFiles: FileDiff[];
  groups: PlannedCommit[];
  mergedFiles?: PlannedCommit["files"];
  mergedSubject: string;
}): void {
  const result = absorbIncidentalAdjacentGroups(
    options.groups,
    fileMap(options.allFiles),
  );

  expect(result).toHaveLength(1);
  if (options.mergedFiles) {
    expect(result[0]?.files).toEqual(options.mergedFiles);
  }
  expect(result[0]?.message.split("\n", 1)[0]).toBe(options.mergedSubject);
}

/**
 * Mirrors the planner fallback path where an umbrella commit should be split
 * back to the original structurally coherent baseline groups.
 */
function expectConsolidationSplitToRestoreBaseline(options: {
  allFiles: FileDiff[];
  baselineGroups: PlannedCommit[];
  umbrellaMessage: string;
}): void {
  const result = splitWeakConsolidations(
    options.baselineGroups,
    [
      {
        files: options.baselineGroups.flatMap((group) => group.files),
        message: options.umbrellaMessage,
      },
    ],
    fileMap(options.allFiles),
    buildFileChangeSignals(options.allFiles),
  );

  expect(subjects(result)).toEqual(subjects(options.baselineGroups));
}

function fileMap(files: FileDiff[]): Map<string, FileDiff> {
  return new Map(files.map((file) => [file.path, file]));
}

function makeFile(path: string, hunkCount = 1): FileDiff {
  return {
    additions: hunkCount,
    deletions: 0,
    hunks: Array.from({ length: hunkCount }, (_, index) => ({
      countNew: 1,
      countOld: 0,
      header: `@@ -${String(index + 1)},0 +${String(index + 1)},1 @@`,
      lines: [`+change ${index}`],
      startNew: index + 1,
      startOld: index + 1,
    })),
    oldPath: null,
    path,
    status: "modified",
  };
}

function parsePlannerDecisionEvents(
  events: { content: string; kind?: string; stage: string }[],
  stage: "cluster" | "consolidate" | "group" = "consolidate",
): Record<string, boolean | number | object | object[] | string>[] {
  return events
    .filter(
      (event) => event.kind === "planner-decision" && event.stage === stage,
    )
    .map(
      (event) =>
        JSON.parse(event.content) as Record<
          string,
          boolean | number | object | object[] | string
        >,
    );
}

function subjects(groups: PlannedCommit[]): string[] {
  return groups.map((group) => group.message.split("\n", 1)[0] ?? "");
}

describe("trace regression commit boundaries", () => {
  test("emits weak consolidation diagnostics when direct-file baseline restoration wins", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const baselineGroups: PlannedCommit[] = [
        {
          files: [{ path: "src/git/path-validation.ts" }],
          message: commitMessage(
            "fix(git): harden repository path validation",
            "- Normalize repository file paths before git operations touch the worktree.",
          ),
        },
        {
          files: [{ path: "src/git/repository-state.ts" }],
          message: commitMessage(
            "fix(git): harden repository probe state",
            "- Keep repository probe state non-interactive before git operations reuse the result.",
          ),
        },
      ];
      const allFiles = [
        makeFile("src/git/path-validation.ts"),
        makeFile("src/git/repository-state.ts"),
      ];

      const result = splitWeakConsolidations(
        baselineGroups,
        [
          {
            files: baselineGroups.flatMap((group) => group.files),
            message: commitMessage(
              "fix(git): align repository hardening helpers",
              "- Keep direct-file git hardening follow-ups from collapsing into one umbrella commit.",
            ),
          },
        ],
        fileMap(allFiles),
        buildFileChangeSignals(allFiles),
      );

      expect(subjects(result)).toEqual(subjects(baselineGroups));

      const plannerEvents = parsePlannerDecisionEvents(events);
      const repartitionEvent = plannerEvents.find(
        (event) => event.decision === "repartition-by-intent",
      );
      const resolutionEvent = plannerEvents.find(
        (event) => event.decision === "weak-consolidation-resolution",
      );

      expect(repartitionEvent).toMatchObject({
        decision: "repartition-by-intent",
        inputGroupCount: 2,
        outputGroupCount: 1,
      });
      expect(resolutionEvent).toMatchObject({
        decision: "weak-consolidation-resolution",
        reason: "distinct-direct-file-baseline",
        resolution: "restore-covered-baseline",
      });
      expect(
        (resolutionEvent?.diagnostics as Record<string, unknown>)?.[
          "shouldRestoreDistinctDirectFileBaseline"
        ],
      ).toBe(true);
      expect(
        (resolutionEvent?.diagnostics as Record<string, unknown>)?.[
          "repartitionedGroupCount"
        ],
      ).toBe(1);
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("keeps the plan-display fixture refresh merged with the planner-ui fixture sibling", () => {
    const files = [
      makeFile("tests/plan-display.test.ts"),
      makeFile("tests/planner-notices.test.ts"),
    ];

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [{ path: "tests/planner-notices.test.ts" }],
          message: commitMessage(
            "test(planner-ui): refresh display and notice fixtures",
            "- Keep planner notice fixtures aligned with the shorter display tokens.",
          ),
        },
        {
          files: [{ path: "tests/plan-display.test.ts" }],
          message: commitMessage(
            "test(plan-display): refresh display and notice fixtures",
            "- Update wrapped path expectations for the current CLI layout.",
          ),
        },
      ],
      fileMap(files),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { path: "tests/planner-notices.test.ts" },
      { path: "tests/plan-display.test.ts" },
    ]);
    expect(result[0]?.message.split("\n", 1)[0]).toBe(
      "test(planner-ui): refresh display and notice fixtures",
    );
  });

  test("emits adjacent absorption diagnostics when follow-up groups merge", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const files = [
        makeFile("tests/plan-display.test.ts"),
        makeFile("tests/planner-notices.test.ts"),
      ];

      const result = absorbIncidentalAdjacentGroups(
        [
          {
            files: [{ path: "tests/planner-notices.test.ts" }],
            message: commitMessage(
              "test(planner-ui): refresh display and notice fixtures",
              "- Keep planner notice fixtures aligned with the shorter display tokens.",
            ),
          },
          {
            files: [{ path: "tests/plan-display.test.ts" }],
            message: commitMessage(
              "test(plan-display): refresh display and notice fixtures",
              "- Update wrapped path expectations for the current CLI layout.",
            ),
          },
        ],
        fileMap(files),
      );

      expect(result).toHaveLength(1);

      const plannerEvents = parsePlannerDecisionEvents(events);
      const absorptionEvent = plannerEvents.find(
        (event) => event.decision === "incidental-adjacent-merge",
      );

      expect(absorptionEvent).toMatchObject({
        decision: "incidental-adjacent-merge",
        diagnostics: {
          candidateFileCount: 1,
          mergedFileCount: 2,
          previousFileCount: 1,
          sharedPaths: false,
        },
      });
      expect(absorptionEvent?.reason).toBeTruthy();
      expect(absorptionEvent?.mergedGroup).toMatchObject({
        fileCount: 2,
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("emits cluster merge rejection diagnostics when a cluster is too broad", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const groups = Array.from({ length: 8 }, (_, index) => ({
        files: [{ path: `src/grouping/feature-${String(index)}.ts` }],
        message: commitMessage(
          `fix(grouping): refine feature ${String(index)}`,
          `- Keep feature ${String(index)} isolated from broad umbrella clustering.`,
        ),
      })) satisfies PlannedCommit[];
      const files = groups.map((group) => makeFile(group.files[0]?.path ?? ""));

      const result = mergeClusterPass(
        groups,
        [Array.from({ length: groups.length }, (_, index) => index)],
        fileMap(files),
        buildFileChangeSignals(files),
      );

      expect(result).toBeNull();

      const plannerEvents = parsePlannerDecisionEvents(events, "cluster");
      const resolutionEvent = plannerEvents.find(
        (event) => event.decision === "cluster-merge-resolution",
      );

      expect(resolutionEvent).toMatchObject({
        clusterCount: 1,
        decision: "cluster-merge-resolution",
        largestClusterSize: 8,
        reason: "oversized-non-style-cluster",
        resolution: "rejected",
      });
      expect(resolutionEvent?.diagnostics).toMatchObject({
        maxSingleClusterSize: 7,
        oversizedClusterCount: 1,
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("emits premerge pair and summary diagnostics when a small test follow-up premerges", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const promptRuleFile = makeFile(
        "src/commit-planning/prompts/rules/commit/message.ts",
      );
      const promptIndexFile = makeFile(
        "src/commit-planning/prompts/rules/commit/index.ts",
      );
      const commitMessagesTestFile = makeFile("tests/commit-messages.test.ts");
      const allFiles = [
        promptRuleFile,
        promptIndexFile,
        commitMessagesTestFile,
      ];
      const groups: PlannedCommit[] = [
        {
          files: [
            { path: promptRuleFile.path },
            { path: promptIndexFile.path },
          ],
          message: commitMessage(
            "refactor(prompts): split commit message rule exports",
            "- Move commit rule exports under a dedicated module.",
          ),
        },
        {
          files: [{ path: commitMessagesTestFile.path }],
          message: commitMessage(
            "test(commit-messages): align rule tests with renamed prompt exports",
            "- Update renamed rule export coverage.",
          ),
        },
      ];

      const result = premergeBySubject(groups, fileMap(allFiles));

      expect(result).toHaveLength(1);

      const plannerEvents = parsePlannerDecisionEvents(events, "group");
      const pairEvent = plannerEvents.find(
        (event) => event.decision === "premerge-pair-evaluation",
      );
      const summaryEvent = plannerEvents.find(
        (event) => event.decision === "premerge-by-subject",
      );

      expect(pairEvent).toMatchObject({
        decision: "premerge-pair-evaluation",
        diagnostics: {
          shouldPremergeSubjects: false,
          shouldPremergeTestFollowUp: true,
        },
        matchedRules: ["test-follow-up"],
        resolution: "merge",
      });
      expect(summaryEvent).toMatchObject({
        decision: "premerge-by-subject",
        diagnostics: {
          matchedPairCount: 1,
          pairCount: 1,
        },
        outputGroupCount: 1,
        reason: "merged-clusters",
        resolution: "use-premerged",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("emits no-premerge diagnostics when subjects stay unrelated", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const allFiles = [
        makeFile("src/commit-planning/path/resolver.ts"),
        makeFile("tests/response-validation.test.ts"),
      ];
      const groups: PlannedCommit[] = [
        {
          files: [{ path: "src/commit-planning/path/resolver.ts" }],
          message: commitMessage(
            "fix(path): harden resolver fallbacks",
            "- Keep path fallback normalization local to the resolver.",
          ),
        },
        {
          files: [{ path: "tests/response-validation.test.ts" }],
          message: commitMessage(
            "test(validation): cover response parser boundaries",
            "- Keep response validation coverage separate from resolver fixes.",
          ),
        },
      ];

      const result = premergeBySubject(groups, fileMap(allFiles));

      expect(result).toEqual(groups);

      const plannerEvents = parsePlannerDecisionEvents(events, "group");
      const pairEvent = plannerEvents.find(
        (event) => event.decision === "premerge-pair-evaluation",
      );
      const summaryEvent = plannerEvents.find(
        (event) => event.decision === "premerge-by-subject",
      );

      expect(pairEvent).toMatchObject({
        decision: "premerge-pair-evaluation",
        matchedRules: [],
        resolution: "keep-separate",
      });
      expect(summaryEvent).toMatchObject({
        decision: "premerge-by-subject",
        diagnostics: {
          matchedPairCount: 0,
          pairCount: 1,
        },
        outputGroupCount: 2,
        reason: "no-premerge-pairs",
        resolution: "preserve-input",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("premerges a same-file trace-regression assertion follow-up into the broader regression shard", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const allFiles = [
        makeFile("tests/trace-regression-boundaries.test.ts", 2),
      ];
      const groups: PlannedCommit[] = [
        {
          files: [
            { hunks: [0], path: "tests/trace-regression-boundaries.test.ts" },
          ],
          message: commitMessage(
            "test(trace-regression): cover rollout-preservation split rules",
            "- Add regression coverage for rollout-preservation split boundaries.",
          ),
        },
        {
          files: [
            { hunks: [1], path: "tests/trace-regression-boundaries.test.ts" },
          ],
          message: commitMessage(
            "test(trace-regression): relax repartition diagnostic assertion",
            "- Keep the assertion update merged with the broader trace-regression rollout.",
          ),
        },
      ];

      const result = premergeBySubject(groups, fileMap(allFiles));

      expect(result).toHaveLength(1);

      const plannerEvents = parsePlannerDecisionEvents(events, "group");
      const pairEvent = plannerEvents.find(
        (event) => event.decision === "premerge-pair-evaluation",
      );
      const summaryEvent = plannerEvents.find(
        (event) => event.decision === "premerge-by-subject",
      );

      expect(pairEvent).toMatchObject({
        decision: "premerge-pair-evaluation",
        diagnostics: {
          shouldPremergeTestFollowUp: true,
        },
        matchedRules: ["test-follow-up"],
        resolution: "merge",
      });
      expect(summaryEvent).toMatchObject({
        decision: "premerge-by-subject",
        diagnostics: {
          matchedPairCount: 1,
          pairCount: 1,
        },
        outputGroupCount: 1,
        reason: "merged-clusters",
        resolution: "use-premerged",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("keeps mixed resume-listing test coverage separate from a commit-body owner fix", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const allFiles = [
        makeFile("src/git/commit-input-validation.ts"),
        makeFile("tests/git-coverage.test.ts"),
        makeFile("tests/cli.test.ts"),
        makeFile("tests/zz-cli-coverage.test.ts"),
      ];
      const groups: PlannedCommit[] = [
        {
          files: [
            { path: "src/git/commit-input-validation.ts" },
            { path: "tests/git-coverage.test.ts" },
            { path: "tests/cli.test.ts" },
          ],
          message: commitMessage(
            "fix(commit-body): allow subject-only commits unless enforcement is requested",
            "- Keep commit-body validation and its direct CLI coverage on the same owner-led fix.",
          ),
        },
        {
          files: [{ path: "tests/zz-cli-coverage.test.ts" }],
          message: commitMessage(
            "test(cli): cover resume listing and commit-body enforcement",
            "- Keep the mixed resume-listing and replay coverage separate until a stronger owner anchor exists.",
          ),
        },
      ];

      expect(premergeBySubject(groups, fileMap(allFiles))).toEqual(groups);

      const plannerEvents = parsePlannerDecisionEvents(events, "group");
      const pairEvent = plannerEvents.find(
        (event) => event.decision === "premerge-pair-evaluation",
      );
      const summaryEvent = plannerEvents.find(
        (event) => event.decision === "premerge-by-subject",
      );

      expect(pairEvent).toMatchObject({
        decision: "premerge-pair-evaluation",
        diagnostics: {
          shouldPremergeTestFollowUp: false,
        },
        matchedRules: [],
        resolution: "keep-separate",
      });
      expect(summaryEvent).toMatchObject({
        decision: "premerge-by-subject",
        reason: "no-premerge-pairs",
        resolution: "preserve-input",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("emits support attachment scoring diagnostics for score and breadth penalty evaluation", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const supportGroup: PlannedCommit = {
        files: [{ path: "tests/api/request-handler.test.ts" }],
        message: commitMessage(
          "test(api): cover request handler",
          "- Keep the request handler regression attached to the API implementation owner.",
        ),
      };
      const targetGroup: PlannedCommit = {
        files: [{ path: "src/api/request-handler.ts" }],
        message: commitMessage(
          "fix(api): harden request handler",
          "- Tighten request handler ownership around the API request flow.",
        ),
      };
      const siblingGroup: PlannedCommit = {
        files: [{ path: "src/api/request-router.ts" }],
        message: commitMessage(
          "fix(api): harden request router",
          "- Keep router ownership separate while the scorer evaluates breadth.",
        ),
      };
      const files = [
        makeFile("tests/api/request-handler.test.ts"),
        makeFile("src/api/request-handler.ts"),
        makeFile("src/api/request-router.ts"),
      ];
      const fileSignals = buildFileChangeSignals(files);

      const score = getSupportAttachmentScore(
        supportGroup,
        targetGroup,
        fileSignals,
      );
      const penalty = getSupportAttachmentBreadthPenalty(
        supportGroup,
        [0, 1],
        [targetGroup, siblingGroup],
        fileSignals,
      );

      expect(score.score).toBeGreaterThan(0);
      expect(penalty).toBe(1);

      const plannerEvents = parsePlannerDecisionEvents(events);
      const scoreEvent = plannerEvents.find(
        (event) => event.decision === "support-attachment-score",
      );
      const breadthPenaltyEvent = plannerEvents.find(
        (event) => event.decision === "support-attachment-breadth-penalty",
      );

      expect(scoreEvent).toMatchObject({
        decision: "support-attachment-score",
        diagnostics: {
          hasExactScopeSignal: true,
          supportSubjectType: "test",
          surfaceScore: expect.any(Number),
          targetSubjectType: "fix",
          wordOverlapScore: expect.any(Number),
        },
      });
      expect(scoreEvent?.score).toBe(score.score);
      expect(breadthPenaltyEvent).toMatchObject({
        decision: "support-attachment-breadth-penalty",
        diagnostics: {
          componentGroupCount: 2,
          distinctFeatureRootCount: 1,
          supportSubjectType: "test",
          uniquePathCount: 2,
        },
        penalty: 1,
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("emits message harmonization diagnostics when owner-aligned covered subjects rewrite a narrowed slice", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const umbrellaSourceGroups: PlannedCommit[] = [
        {
          files: [
            { path: "src/commit-planning/plan-bundles/service.ts" },
            { path: "src/commit-planning/plan-bundles/storage.ts" },
          ],
          message: commitMessage(
            "feat(plan-bundles): persist and verify resume-safe staged content",
            "- Keep staged resume content durable across retries.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/grouping/baseline-restoration.ts" },
            { path: "src/commit-planning/grouping/component-routing.ts" },
          ],
          message: commitMessage(
            "feat(commit-planning-grouping): split weak consolidations by ownership",
            "- Keep grouping owner restoration and component routing on the grouping surface.",
          ),
        },
      ];
      const inputGroup: PlannedCommit = {
        files: [
          { path: "src/commit-planning/grouping/baseline-restoration.ts" },
          { path: "src/commit-planning/grouping/component-routing.ts" },
        ],
        message: commitMessage(
          "feat(plan-bundles): persist and verify resume-safe staged content",
          "- Fold saved staged content and grouping owner restoration into one umbrella feature.",
        ),
      };
      const result = rescopeGroupMessageToCoveredGroups(
        inputGroup,
        umbrellaSourceGroups,
        fileMap([
          makeFile("src/commit-planning/plan-bundles/service.ts"),
          makeFile("src/commit-planning/plan-bundles/storage.ts"),
          makeFile("src/commit-planning/grouping/baseline-restoration.ts"),
          makeFile("src/commit-planning/grouping/component-routing.ts"),
        ]),
      );

      expect(result.message.split("\n", 1)[0]).toBe(
        "feat(commit-planning-grouping): split weak consolidations by ownership",
      );

      const plannerEvents = parsePlannerDecisionEvents(events);
      const harmonizationEvent = plannerEvents.find(
        (event) =>
          event.decision === "message-harmonization" &&
          event.operation === "rescope-covered",
      );

      expect(harmonizationEvent).toMatchObject({
        decision: "message-harmonization",
        diagnostics: {
          coveredGroupCount: 1,
          usedOwnerAlignedCoveredSubject: true,
        },
        operation: "rescope-covered",
        reason: "owner-aligned-covered-subject",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("emits message harmonization diagnostics when covered groups rebuild narrowed umbrella copy", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const originalGroups: PlannedCommit[] = [
        {
          files: [{ path: "src/commit-planning/path/resolver.ts" }],
          message: commitMessage(
            "fix(path): harden resolver fallbacks",
            "- Keep resolver fallback normalization local to the path layer.",
          ),
        },
        {
          files: [{ path: "src/commit-planning/result-cache.ts" }],
          message: commitMessage(
            "fix(cache): harden planner cache reuse",
            "- Keep cache reuse invalidation local to the cache layer.",
          ),
        },
      ];
      const consolidatedGroups: PlannedCommit[] = [
        {
          files: [{ path: "src/commit-planning/path/resolver.ts" }],
          message: commitMessage(
            "fix(planning): harden resolver fallbacks and planner cache reuse",
            "- Keep resolver fallback normalization and cache reuse invalidation in one umbrella fix.",
          ),
        },
      ];

      const result = harmonizeConsolidatedMessages(
        originalGroups,
        consolidatedGroups,
        fileMap([
          makeFile("src/commit-planning/path/resolver.ts"),
          makeFile("src/commit-planning/result-cache.ts"),
        ]),
      );

      expect(result[0]?.message.split("\n", 1)[0]).toBe(
        "fix(path): harden resolver fallbacks",
      );

      const plannerEvents = parsePlannerDecisionEvents(events);
      const harmonizationEvent = plannerEvents.find(
        (event) =>
          event.decision === "message-harmonization" &&
          event.operation === "harmonize-covered",
      );

      expect(harmonizationEvent).toMatchObject({
        decision: "message-harmonization",
        diagnostics: {
          coveredGroupCount: 1,
          scopedMessageChanged: true,
        },
        operation: "harmonize-covered",
        reason: "scoped-covered-message",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("emits rollout preservation diagnostics when a config export rollout stays merged", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const mergedGroup: PlannedCommit = {
        files: [
          { path: "src/application/config/service.ts" },
          { path: "src/application/config/index.ts" },
          { path: "src/application/index.ts" },
        ],
        message: commitMessage(
          "feat(application-config): expose config entrypoints directly",
          "- Add a dedicated config service and keep config and application entrypoints aligned behind explicit exports.",
        ),
      };
      const allFiles = mergedGroup.files.map((file) => makeFile(file.path));

      expect(
        normalizeMixedRootImplementationGroups(
          [mergedGroup],
          [mergedGroup],
          fileMap(allFiles),
        ),
      ).toEqual([mergedGroup]);

      const plannerEvents = parsePlannerDecisionEvents(events);
      const rolloutEvent = plannerEvents.find(
        (event) => event.decision === "feature-surface-rollout",
      );
      const normalizationEvent = plannerEvents.find(
        (event) => event.decision === "normalization-preserve",
      );

      expect(rolloutEvent).toMatchObject({
        decision: "feature-surface-rollout",
        diagnostics: {
          featureRootCount: 1,
          fileCount: 3,
          hasSingleRolloutReason: true,
          isPreservableFeatureSurfaceShape: true,
        },
        reason: expect.any(String),
        resolution: "preserve-rollout",
      });
      expect(normalizationEvent).toMatchObject({
        decision: "normalization-preserve",
        normalizationKind: "mixed-root-implementation",
        reason: "feature-surface-rollout",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("keeps a shallow cross-root replay rollout merged when entrypoints and owner surfaces stay compact", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const sourceGroups: PlannedCommit[] = [
        {
          files: [
            { path: "src/cli/main.ts" },
            { path: "src/cli/options.ts" },
            { path: "src/cli/resume/index.ts" },
            { path: "src/cli/resume/options.ts" },
          ],
          message: commitMessage(
            "feat(cli): persist replay progress and list saved plan bundles",
            "- Keep the CLI entrypoints and resume parsing surfaces aligned with replay progress support.",
          ),
        },
        {
          files: [
            { path: "src/git/commit-input-validation.ts" },
            { path: "src/git/index.ts" },
          ],
          message: commitMessage(
            "feat(git): persist replay progress and list saved plan bundles",
            "- Keep git-side replay validation and public exports aligned with the saved bundle flow.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/plan-bundles/index.ts" },
            { path: "src/commit-planning/plan-bundles/storage.ts" },
            { path: "src/commit-planning/plan-bundles/resume/index.ts" },
            { path: "src/commit-planning/plan-bundles/resume/progress.ts" },
            { path: "src/commit-planning/index.ts" },
          ],
          message: commitMessage(
            "feat(plan-bundles): persist replay progress and list saved plan bundles",
            "- Keep plan-bundle persistence, resume progress, and public exports on one shallow rollout.",
          ),
        },
      ];
      const umbrellaGroup: PlannedCommit = {
        files: sourceGroups.flatMap((group) => group.files),
        message: commitMessage(
          "feat(resume): persist replay progress and list saved plan bundles",
          "- Fold the replay progress rollout across CLI, git validation, and plan-bundle entrypoints without deep implementation fan-out.",
        ),
      };
      const allFiles = umbrellaGroup.files.map((file) => makeFile(file.path));

      expect(
        normalizeMixedRootImplementationGroups(
          [umbrellaGroup],
          sourceGroups,
          fileMap(allFiles),
        ),
      ).toEqual([umbrellaGroup]);

      const plannerEvents = parsePlannerDecisionEvents(events);
      const rolloutEvent = plannerEvents.find(
        (event) => event.decision === "feature-surface-rollout",
      );
      const normalizationEvent = plannerEvents.find(
        (event) => event.decision === "normalization-preserve",
      );

      expect(rolloutEvent).toMatchObject({
        decision: "feature-surface-rollout",
        diagnostics: {
          featureRootCount: 3,
          fileCount: umbrellaGroup.files.length,
          hasSingleRolloutReason: true,
        },
        resolution: "preserve-rollout",
      });
      expect(normalizationEvent).toMatchObject({
        decision: "normalization-preserve",
        normalizationKind: "mixed-root-implementation",
        reason: "feature-surface-rollout",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("keeps a balanced git and plan-bundles replay rollout merged when both roots stay shallow", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const sourceGroups: PlannedCommit[] = [
        {
          files: [
            { path: "src/git/repository-state.ts" },
            { path: "src/git/index.ts" },
            { path: "src/git/commit-input-validation.ts" },
          ],
          message: commitMessage(
            "feat(git): skip already replayed saved-plan commits",
            "- Keep recent-history replay checks and git validation aligned with saved-plan resume recovery.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/plan-bundles/resume/progress.ts" },
            { path: "src/commit-planning/plan-bundles/resume/validation.ts" },
            {
              path: "src/commit-planning/plan-bundles/resume/preparation.ts",
            },
            { path: "src/commit-planning/plan-bundles/resume/index.ts" },
            { path: "src/commit-planning/plan-bundles/index.ts" },
            { path: "src/commit-planning/plan-bundles/service.ts" },
            { path: "src/commit-planning/plan-bundles/storage.ts" },
          ],
          message: commitMessage(
            "feat(plan-bundles): skip already replayed saved-plan commits",
            "- Keep saved-plan progress, bundle storage, and resume validation on one compact rollout.",
          ),
        },
      ];
      const umbrellaGroup: PlannedCommit = {
        files: sourceGroups.flatMap((group) => group.files),
        message: commitMessage(
          "feat(resume): skip already replayed saved-plan commits",
          "- Fold git-side replay detection and plan-bundle progress tracking into one shallow saved-plan rollout.",
        ),
      };
      const allFiles = umbrellaGroup.files.map((file) => makeFile(file.path));

      expect(
        normalizeMixedRootImplementationGroups(
          [umbrellaGroup],
          sourceGroups,
          fileMap(allFiles),
        ),
      ).toEqual([umbrellaGroup]);

      const plannerEvents = parsePlannerDecisionEvents(events);
      const rolloutEvent = plannerEvents.find(
        (event) => event.decision === "feature-surface-rollout",
      );
      const normalizationEvent = plannerEvents.find(
        (event) => event.decision === "normalization-preserve",
      );

      expect(rolloutEvent).toMatchObject({
        decision: "feature-surface-rollout",
        diagnostics: {
          featureRootCount: 2,
          fileCount: umbrellaGroup.files.length,
          hasSingleRolloutReason: true,
        },
        resolution: "preserve-rollout",
      });
      expect(normalizationEvent).toMatchObject({
        decision: "normalization-preserve",
        normalizationKind: "mixed-root-implementation",
        reason: "feature-surface-rollout",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("keeps compact exact-overlap execution slices merged after weak-consolidation repartition", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const baselineGroups: PlannedCommit[] = [
        {
          files: [{ path: "src/cli/commit/execution.ts" }],
          message: commitMessage(
            "fix(commit): make body validation opt-in during execution",
            "- Keep the execution entrypoint aligned with the opt-in contract.",
          ),
        },
        {
          files: [
            { path: "src/cli/execution-flow.ts" },
            { path: "src/cli/main.ts" },
          ],
          message: commitMessage(
            "fix(cli): make body validation opt-in during execution",
            "- Keep CLI forwarding and command wiring on the same rollout.",
          ),
        },
        {
          files: [{ path: "src/git/commit-input-validation.ts" }],
          message: commitMessage(
            "fix(commit): allow subject-only messages unless body checks are requested",
            "- Keep git-side body validation separate from execution plumbing.",
          ),
        },
      ];
      const allFiles = [
        makeFile("src/cli/commit/execution.ts"),
        makeFile("src/cli/execution-flow.ts"),
        makeFile("src/cli/main.ts"),
        makeFile("src/git/commit-input-validation.ts"),
      ];

      const result = splitWeakConsolidations(
        baselineGroups,
        [
          {
            files: baselineGroups.flatMap((group) => group.files),
            message: commitMessage(
              "fix(commit): allow subject-only messages unless body checks are requested",
              "- Fold execution-path wiring and git-side body validation into one broad umbrella fix.",
            ),
          },
        ],
        fileMap(allFiles),
        buildFileChangeSignals(allFiles),
      );

      expect(result).toHaveLength(2);
      expect(result[0]?.files).toEqual([
        { path: "src/cli/commit/execution.ts" },
        { path: "src/cli/execution-flow.ts" },
        { path: "src/cli/main.ts" },
      ]);
      expect(result[0]?.message.split("\n", 1)[0]).toBe(
        "fix(cli): make body validation opt-in during execution",
      );
      expect(result[1]?.message.split("\n", 1)[0]).toBe(
        "fix(commit): allow subject-only messages unless body checks are requested",
      );

      const plannerEvents = parsePlannerDecisionEvents(events);
      const resolutionEvent = plannerEvents.find(
        (event) => event.decision === "weak-consolidation-resolution",
      );

      expect(resolutionEvent).toMatchObject({
        decision: "weak-consolidation-resolution",
        diagnostics: {
          coveredBaselineFallbackResolution: "use-repartitioned",
          repartitionedGroupCount: 3,
        },
        reason: "use-repartitioned",
        resolution: "use-repartitioned",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("keeps a shallow saved-plan rollout consolidated after weak repartition when docs are only follow-up support", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const baselineGroups: PlannedCommit[] = [
        {
          files: [
            { path: "src/git/repository-state.ts" },
            { path: "src/git/index.ts" },
          ],
          message: commitMessage(
            "feat(git): track saved plan replay progress and list bundles",
            "- Keep git-side replay detection aligned with the saved-plan resume flow.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/plan-bundles/resume/progress.ts" },
            { path: "src/commit-planning/plan-bundles/resume/validation.ts" },
            { path: "src/commit-planning/plan-bundles/resume/preparation.ts" },
            { path: "src/commit-planning/plan-bundles/resume/index.ts" },
            { path: "src/commit-planning/plan-bundles/storage.ts" },
            { path: "src/commit-planning/plan-bundles/service.ts" },
            { path: "src/commit-planning/plan-bundles/index.ts" },
          ],
          message: commitMessage(
            "feat(plan-bundles-resume): track saved plan replay progress and list bundles",
            "- Keep saved-plan progress, resume preparation, and bundle storage on one rollout surface.",
          ),
        },
        {
          files: [
            { path: "src/cli/resume/execution.ts" },
            { path: "src/cli/resume/index.ts" },
            { path: "src/cli/resume/options.ts" },
            { path: "README.md" },
            { path: "src/cli/options.ts" },
            { path: "src/cli/execution-flow.ts" },
            { path: "src/cli/main.ts" },
            { path: "src/cli/commit/execution.ts" },
          ],
          message: commitMessage(
            "feat(resume): track saved plan replay progress and list bundles",
            "- Keep CLI resume execution, command wiring, and the README follow-up on the same rollout.",
          ),
        },
      ];
      const umbrellaGroup: PlannedCommit = {
        files: baselineGroups.flatMap((group) => group.files),
        message: commitMessage(
          "feat(resume): track saved plan replay progress and list bundles",
          "- Fold git-side replay detection, plan-bundle progress, and CLI resume entrypoints into one shallow rollout.",
        ),
      };
      const allFiles = umbrellaGroup.files.map((file) => makeFile(file.path));

      expect(
        splitWeakConsolidations(
          baselineGroups,
          [umbrellaGroup],
          fileMap(allFiles),
          buildFileChangeSignals(allFiles),
        ),
      ).toEqual([umbrellaGroup]);

      const plannerEvents = parsePlannerDecisionEvents(events);
      const resolutionEvent = plannerEvents.find(
        (event) => event.decision === "weak-consolidation-resolution",
      );

      expect(resolutionEvent).toMatchObject({
        decision: "weak-consolidation-resolution",
        diagnostics: {
          coveredBaselineFallbackResolution: "preserve-consolidated",
          preserveShallowSurfaceRollout: true,
          repartitionedGroupCount: 3,
        },
        reason: "preserve-shallow-surface-rollout",
        resolution: "preserve-consolidated",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("does not preserve identical rollouts across distinct owner-scoped grouping buckets", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/grouping/compact-rollout-families.ts" },
          { path: "src/commit-planning/grouping/repartition.ts" },
        ],
        message: commitMessage(
          "fix(commit-planning-grouping): attach small follow-ups to their owning rollout",
          "- Keep grouping repartition helpers aligned on the commit-planning grouping surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/group/normalization.ts" },
          { path: "src/commit-planning/grouping/group/group-stability.ts" },
          {
            path: "src/commit-planning/grouping/group/adjacent/follow-up-rules.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping-group): attach small follow-ups to their owning rollout",
          "- Keep nested group normalization and stability fixes on the same owner bucket.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/subject/path-areas.ts" },
          {
            path: "src/commit-planning/grouping/subject/rollout-bridge-signals.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping-subject): attach small follow-ups to their owning rollout",
          "- Keep subject path-area and bridge signals scoped to the grouping subject surface.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/premerge/follow-ups.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/pair-evaluation.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/style-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/test-follow-up-signals.ts",
          },
        ],
        message: commitMessage(
          "fix(subject-premerge): attach small follow-ups to their owning rollout",
          "- Keep premerge follow-up rules scoped to the subject premerge owner bucket.",
        ),
      },
    ];

    expect(shouldPreserveIdenticalRollout(baselineGroups)).toBe(false);
  });

  test("remerges a compact exact-overlap rollout family after owner-split normalization", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const sourceGroups: PlannedCommit[] = [
        {
          files: [{ path: "src/commit-planning/index.ts" }],
          message: commitMessage(
            "feat(commit-planning): update public exports",
            "- Keep the public export surface scoped to commit-planning.",
          ),
        },
        {
          files: [{ path: "src/cli/commit/execution.ts" }],
          message: commitMessage(
            "feat(commit): add bundle listing and strict resume hash checks",
            "- Keep commit execution aligned with the new bundle-listing and strict hash contract.",
          ),
        },
        {
          files: [
            { path: "src/cli/execution-flow.ts" },
            { path: "src/cli/main.ts" },
            { path: "src/cli/options.ts" },
          ],
          message: commitMessage(
            "feat(cli): add bundle listing and strict resume hash checks",
            "- Keep CLI flow and top-level command wiring on the same rollout.",
          ),
        },
        {
          files: [{ path: "README.md" }],
          message: commitMessage(
            "feat(root): add bundle listing and strict resume hash checks",
            "- Keep the root follow-up docs aligned with the same rollout wording.",
          ),
        },
      ];
      const umbrellaGroup: PlannedCommit = {
        files: sourceGroups.flatMap((group) => group.files),
        message: commitMessage(
          "feat(resume): add bundle listing and strict resume hash checks",
          "- Fold commit-planning exports, CLI execution wiring, and the root follow-up under one rollout umbrella.",
        ),
      };

      const allFiles = umbrellaGroup.files.map((file) => makeFile(file.path));

      const result = normalizeMixedRootImplementationGroups(
        [umbrellaGroup],
        sourceGroups,
        fileMap(allFiles),
      );

      expect(result).toHaveLength(2);
      expect(result[0]?.message.split("\n", 1)[0]).toBe(
        "feat(commit-planning): update public exports",
      );
      expect(result[1]?.files).toEqual([
        { path: "src/cli/commit/execution.ts" },
        { path: "src/cli/execution-flow.ts" },
        { path: "src/cli/main.ts" },
        { path: "src/cli/options.ts" },
        { path: "README.md" },
      ]);
      expect(result[1]?.message.split("\n", 1)[0]).toBe(
        "feat(cli): add bundle listing and strict resume hash checks",
      );

      const plannerEvents = parsePlannerDecisionEvents(events);
      const structuralOwnerEvent = plannerEvents.find(
        (event) => event.decision === "structural-owner-split",
      );
      const normalizationEvent = plannerEvents.find(
        (event) => event.decision === "normalization-split",
      );

      expect(structuralOwnerEvent).toMatchObject({
        decision: "structural-owner-split",
        diagnostics: {
          fileCount: umbrellaGroup.files.length,
          refinedStructuralOwnerBucketCount: 4,
        },
        reason: "refined-multi-owner-umbrella",
        resolution: "split-group",
      });
      expect(normalizationEvent).toMatchObject({
        decision: "normalization-split",
        normalizationKind: "mixed-root-implementation",
        outputGroups: expect.any(Array),
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("restores covered grouping slices when repartition still leaves one dominant mega bucket", () => {
    const coveredGroups: PlannedCommit[] = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/implementation-merge/service.ts",
          },
          {
            path: "src/commit-planning/grouping/implementation-merge/rollout-signal.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping-implementation-merge): split unrelated support follow-ups from impl slices",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/repartition.ts" },
          { path: "src/commit-planning/grouping/rollout-preservation.ts" },
        ],
        message: commitMessage(
          "fix(commit-planning-grouping): split unrelated support follow-ups from impl slices",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/group/normalization.ts" },
          {
            path: "src/commit-planning/grouping/group/message-harmonization.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping-group): split unrelated support follow-ups from impl slices",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/subject/path-areas.ts" },
          {
            path: "src/commit-planning/grouping/subject/rollout-bridge-signals.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping-subject): split unrelated support follow-ups from impl slices",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/premerge/follow-ups.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/pair-evaluation.ts",
          },
        ],
        message: commitMessage(
          "fix(subject-premerge): split unrelated support follow-ups from impl slices",
        ),
      },
      {
        files: [{ path: "tests/group-finalization.test.ts" }],
        message: commitMessage(
          "test(group-finalization): split unrelated support follow-ups from impl slices",
        ),
      },
      {
        files: [{ path: "tests/trace-regression-boundaries.test.ts" }],
        message: commitMessage(
          "test(trace-regression): cover owner-scoped rollout splitting",
        ),
      },
      {
        files: [{ path: "tests/ai.test.ts" }],
        message: commitMessage(
          "test(ai): cover premerge follow-up ownership rules",
        ),
      },
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message: commitMessage(
          "test(ai): cover premerge follow-up ownership rules",
        ),
      },
    ];
    const repartitioned: PlannedCommit[] = [
      {
        files: coveredGroups.slice(0, 7).flatMap((group) => group.files),
        message: commitMessage(
          "fix(commit-planning-grouping): split unrelated support follow-ups from impl slices",
        ),
      },
      coveredGroups[7]!,
      coveredGroups[8]!,
    ];

    const fallback = evaluateCoveredBaselineFallback(
      {
        files: coveredGroups.flatMap((group) => group.files),
        message: commitMessage(
          "fix(grouping): split unrelated support follow-ups from impl slices",
        ),
      },
      coveredGroups,
      repartitioned,
      false,
      (group) => group.files[0]?.path ?? "",
    );

    expect(fallback).toMatchObject({
      diagnostics: {
        coveredGroupCount: 9,
        hasDominantMegaRepartitionedGroup: true,
        hasRestoreCoveredBaselineSignal: true,
        repartitionedGroupCount: 3,
      },
      reason: "restore-covered-baseline",
      resolution: "restore-covered-baseline",
    });
    expect(fallback.groups).toEqual(coveredGroups);
  });

  test("restores covered follow-up attachment slices when repartition collapses implementation owners into one non-shallow bundle", () => {
    const coveredGroups: PlannedCommit[] = [
      {
        files: [{ path: "src/commit-planning/grouping/repartition.ts" }],
        message: commitMessage(
          "feat(commit-planning-grouping): attach follow-up shards to their owning rollout",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/rollout-bridge-signals.ts",
          },
          { path: "src/commit-planning/grouping/subject/path-areas.ts" },
        ],
        message: commitMessage(
          "feat(grouping-subject): attach follow-up shards to their owning rollout",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/premerge/style-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/test-follow-up-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/follow-ups.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/pair-evaluation.ts",
          },
        ],
        message: commitMessage(
          "feat(subject-premerge): attach follow-up shards to their owning rollout",
        ),
      },
      {
        files: [{ path: "tests/trace-regression-boundaries.test.ts" }],
        message: commitMessage(
          "test(trace-regression): cover grouping boundary regressions",
        ),
      },
    ];
    const repartitioned: PlannedCommit[] = [
      {
        files: coveredGroups.slice(0, 3).flatMap((group) => group.files),
        message: commitMessage(
          "feat(subject-premerge): attach follow-up shards to their owning rollout",
        ),
      },
      coveredGroups[3]!,
    ];

    const fallback = evaluateCoveredBaselineFallback(
      {
        files: coveredGroups.flatMap((group) => group.files),
        message: commitMessage(
          "feat(grouping): attach follow-up shards to their owning rollout",
        ),
      },
      coveredGroups,
      repartitioned,
      false,
      (group) => group.files[0]?.path ?? "",
    );

    expect(fallback).toMatchObject({
      diagnostics: {
        coveredGroupCount: 4,
        hasCollapsedImplementationBundle: true,
        hasRestoreCoveredBaselineSignal: true,
        repartitionedGroupCount: 2,
      },
      reason: "restore-covered-baseline",
      resolution: "restore-covered-baseline",
    });
    expect(fallback.groups).toEqual(coveredGroups);
  });

  test("restores covered owner slices when repartitioned output still leaves a multi-owner implementation umbrella", () => {
    const coveredGroups: PlannedCommit[] = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/implementation-merge/strong-rollout-compatibility.ts",
          },
          {
            path: "src/commit-planning/grouping/implementation-merge/rollout-signal.ts",
          },
          {
            path: "src/commit-planning/grouping/implementation-merge/service.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping-implementation-merge): keep split rollout slices scoped to their owner",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/implementation-components.ts" },
          { path: "src/commit-planning/grouping/compact-rollout-families.ts" },
          { path: "src/commit-planning/grouping/baseline-restoration.ts" },
        ],
        message: commitMessage(
          "fix(commit-planning-grouping): keep split rollout slices scoped to their owner",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/group/adjacent/follow-up-rules.ts",
          },
        ],
        message: commitMessage(
          "fix(group-adjacent): keep split rollout slices scoped to their owner",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/group/feature-surface-heuristics.ts",
          },
          { path: "src/commit-planning/grouping/group/group-stability.ts" },
          {
            path: "src/commit-planning/grouping/group/message-harmonization.ts",
          },
          { path: "src/commit-planning/grouping/group/normalization.ts" },
        ],
        message: commitMessage(
          "fix(grouping-group): keep split rollout slices scoped to their owner",
        ),
      },
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message: commitMessage(
          "test(commit-planning): cover duplicate-group stabilization cases",
        ),
      },
      {
        files: [{ path: "tests/trace-regression-boundaries.test.ts" }],
        message: commitMessage(
          "test(trace-regression): cover owner-scoped grouping fallbacks",
        ),
      },
    ];
    const repartitioned: PlannedCommit[] = [
      {
        files: coveredGroups
          .filter(
            (group) =>
              !group.message.startsWith("fix(group-adjacent)") &&
              !group.message.startsWith("test("),
          )
          .flatMap((group) => group.files),
        message: commitMessage(
          "fix(grouping-group): keep split rollout slices scoped to their owner",
        ),
      },
      coveredGroups[2]!,
      coveredGroups[5]!,
    ];

    const fallback = evaluateCoveredBaselineFallback(
      {
        files: coveredGroups.flatMap((group) => group.files),
        message: commitMessage(
          "fix(grouping): keep split rollout slices scoped to their owner",
        ),
      },
      coveredGroups,
      repartitioned,
      false,
      (group) => group.files[0]?.path ?? "",
    );

    expect(fallback).toMatchObject({
      diagnostics: {
        coveredGroupCount: 6,
        hasCollapsedImplementationBundle: true,
        hasRestoreCoveredBaselineSignal: true,
        repartitionedGroupCount: 3,
      },
      reason: "restore-covered-baseline",
      resolution: "restore-covered-baseline",
    });
    expect(fallback.groups).toEqual(coveredGroups);
  });

  test("restores a lone covered test baseline instead of preserving a mixed implementation umbrella", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const resumeFlowFile: FileDiff = {
        ...makeFile("src/cli/execution-flow.ts", 2),
        hunks: [
          {
            countNew: 1,
            countOld: 0,
            header: "@@ -1,0 +1,1 @@",
            lines: ["+resume flow change"],
            startNew: 1,
            startOld: 1,
          },
          {
            countNew: 1,
            countOld: 0,
            header: "@@ -2,0 +2,1 @@",
            lines: ["+stricter replay mode change"],
            startNew: 2,
            startOld: 2,
          },
        ],
      };
      const resumeMainFile = makeFile("src/cli/main.ts");
      const traceBoundaryFile = makeFile(
        "tests/trace-regression-boundaries.test.ts",
      );
      const allFiles = [resumeFlowFile, resumeMainFile, traceBoundaryFile];
      const baselineGroups: PlannedCommit[] = [
        {
          files: [
            { hunks: [0, 1], path: resumeFlowFile.path },
            { path: resumeMainFile.path },
          ],
          message: commitMessage(
            "feat(resume): add saved bundle listing and stricter replay modes",
            "- Keep CLI resume wiring and replay mode changes on the same rollout.",
          ),
        },
        {
          files: [{ path: traceBoundaryFile.path }],
          message: commitMessage(
            "test(trace-regression-boundaries): add saved bundle listing and stricter replay modes",
            "- Keep the trace regression coverage isolated until an owner-led baseline fully matches.",
          ),
        },
      ];

      const result = splitWeakConsolidations(
        baselineGroups,
        [
          {
            files: [
              { hunks: [0], path: resumeFlowFile.path },
              { path: resumeMainFile.path },
              { path: traceBoundaryFile.path },
            ],
            message: commitMessage(
              "test(trace-regression-boundaries): add saved bundle listing and stricter replay modes",
              "- Fold the lone trace regression into a broader mixed umbrella.",
            ),
          },
        ],
        fileMap(allFiles),
        buildFileChangeSignals(allFiles),
      );

      expect(result).toEqual([
        {
          files: [{ path: traceBoundaryFile.path }],
          message: commitMessage(
            "test(trace-regression-boundaries): add saved bundle listing and stricter replay modes",
            "- Keep the trace regression coverage isolated until an owner-led baseline fully matches.",
          ),
        },
      ]);

      const plannerEvents = parsePlannerDecisionEvents(events);
      const resolutionEvent = plannerEvents.find(
        (event) => event.decision === "weak-consolidation-resolution",
      );

      expect(resolutionEvent).toMatchObject({
        decision: "weak-consolidation-resolution",
        diagnostics: {
          coveredGroupCount: 1,
        },
        reason: "restore-expanded-single-support-baseline",
        resolution: "restore-covered-baseline",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("emits rollout preservation diagnostics when a deep grouping umbrella should split", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const mergedGroup: PlannedCommit = {
        files: [
          { path: "src/commit-planning/grouping/group/events.ts" },
          { path: "src/commit-planning/grouping/group/group-stability.ts" },
          {
            path: "src/commit-planning/grouping/group/message-harmonization.ts",
          },
          {
            path: "src/commit-planning/grouping/group/adjacent/absorption.ts",
          },
        ],
        message: commitMessage(
          "fix(commit-planning): centralize prompt rules and honor breaking mode",
          "- Keep grouping fallback events, stability checks, message harmonization, and adjacent absorption boundaries on one umbrella surface.",
        ),
      };

      expect(shouldPreserveFeatureSurfaceRollout(mergedGroup)).toBe(false);

      const plannerEvents = parsePlannerDecisionEvents(events);
      const rolloutEvent = plannerEvents.find(
        (event) => event.decision === "feature-surface-rollout",
      );

      expect(rolloutEvent).toMatchObject({
        decision: "feature-surface-rollout",
        diagnostics: {
          fileCount: 4,
          hasSingleRolloutReason: true,
        },
        reason: expect.any(String),
        resolution: "split-rollout",
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("normalizeMixedRootImplementationGroups splits unrelated support shards out of an implementation-led resume group", () => {
    const sourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/plan-bundles/resume/validation.ts" },
        ],
        message: commitMessage(
          "feat(resume): retain original selected indexes after validation",
          "- Track surviving bundle-relative indexes after invalid resume selections are filtered out.",
        ),
      },
      {
        files: [{ path: "tests/plan-bundles.test.ts" }],
        message: commitMessage(
          "test(plan-bundles): cover retained selected indexes after validation",
          "- Verify resume validation returns the original selected indexes for surviving entries.",
        ),
      },
      {
        files: [{ path: "tests/cli.test.ts" }],
        message: commitMessage(
          "test(cli): cover enforce-commit-body help text",
          "- Verify CLI help text documents the renamed enforcement flag.",
        ),
      },
    ];
    const umbrellaGroup: PlannedCommit = {
      files: sourceGroups.flatMap((group) => group.files),
      message: commitMessage(
        "feat(resume): retain original selected indexes after validation",
        "- Keep resume validation changes, plan-bundle coverage, and incidental CLI help updates on one broad rollout.",
      ),
    };
    const allFiles = umbrellaGroup.files.map((file) => makeFile(file.path));

    const result = normalizeMixedRootImplementationGroups(
      [umbrellaGroup],
      sourceGroups,
      fileMap(allFiles),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.files).toEqual([
      { path: "src/commit-planning/plan-bundles/resume/validation.ts" },
      { path: "tests/plan-bundles.test.ts" },
    ]);
    expect(result[0]?.message.split("\n", 1)[0]).toBe(
      "feat(resume): retain original selected indexes after validation",
    );
    expect(result[1]?.files).toEqual([{ path: "tests/cli.test.ts" }]);
    expect(result[1]?.message.split("\n", 1)[0]).toBe(
      "test(cli): retain original selected indexes after validation",
    );
  });

  test("does not preserve an oversized same-feature umbrella just because one nested base surface has sibling child surfaces", () => {
    const mergedGroup: PlannedCommit = {
      files: [
        { path: "src/commit-planning/grouping/baseline-restoration.ts" },
        { path: "src/commit-planning/grouping/component-routing.ts" },
        { path: "src/commit-planning/grouping/ownership.ts" },
        { path: "src/commit-planning/grouping/preservation-rules.ts" },
        { path: "src/commit-planning/grouping/structural-fanout.ts" },
        {
          path: "src/commit-planning/grouping/weak-consolidation-preservation.ts",
        },
        { path: "src/commit-planning/grouping/group/consolidation-shape.ts" },
        { path: "src/commit-planning/grouping/group/coverage-salvage.ts" },
        {
          path: "src/commit-planning/grouping/group/covered-message-resolution.ts",
        },
        { path: "src/commit-planning/grouping/group/events.ts" },
        {
          path: "src/commit-planning/grouping/group/feature-surface-heuristics.ts",
        },
        { path: "src/commit-planning/grouping/group/finalization.ts" },
        { path: "src/commit-planning/grouping/group/normalization.ts" },
        { path: "src/commit-planning/grouping/group/ownership-boundaries.ts" },
        { path: "src/commit-planning/grouping/group/primary-subject.ts" },
        { path: "src/commit-planning/grouping/group/rollout-preservation.ts" },
        { path: "src/commit-planning/grouping/group/split-trace-events.ts" },
        {
          path: "src/commit-planning/grouping/group/structural-owner-splitting.ts",
        },
        { path: "src/commit-planning/grouping/subject/analysis.ts" },
        {
          path: "src/commit-planning/grouping/subject/premerge/pair-evaluation.ts",
        },
        { path: "src/commit-planning/grouping/subject/premerge/service.ts" },
        {
          path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
        },
        {
          path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
        },
        { path: "src/commit-planning/grouping/support-attachment/index.ts" },
        {
          path: "src/commit-planning/grouping/support-attachment/ownership-words.ts",
        },
        { path: "src/commit-planning/grouping/support-attachment/scoring.ts" },
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
        { path: "src/commit-planning/planned-commit-clone.ts" },
        { path: "src/commit-planning/path/aliases.ts" },
        { path: "src/commit-planning/path/index.ts" },
        { path: "src/commit-planning/path/repository-structure.ts" },
        { path: "src/commit-planning/path/resolver.ts" },
        { path: "src/commit-planning/path/structure.ts" },
        { path: "src/commit-planning/plan-bundles/hashes.ts" },
        { path: "src/commit-planning/plan-bundles/index.ts" },
        { path: "src/commit-planning/plan-bundles/schemas.ts" },
        { path: "src/commit-planning/plan-bundles/service.ts" },
        { path: "src/commit-planning/plan-bundles/storage.ts" },
        { path: "src/commit-planning/plan-bundles/resume/index.ts" },
        {
          path: "src/commit-planning/plan-bundles/resume/plan-commit-mismatch.ts",
        },
        { path: "src/commit-planning/plan-bundles/resume/preparation.ts" },
        { path: "src/commit-planning/plan-bundles/resume/validation.ts" },
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
      message: commitMessage(
        "feat(commit-planning): centralize prompt rule builders by planning stage",
        "- Fold prompt rules, path utilities, plan bundles, and grouping heuristics into one umbrella feature.",
      ),
    };

    expect(shouldPreserveFeatureSurfaceRollout(mergedGroup)).toBe(false);
  });

  test("normalizeMixedRootImplementationGroups splits a root-plus-child-plus-grandchild grouping umbrella", () => {
    const sourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/grouping/compact-rollout-families.ts" },
          { path: "src/commit-planning/grouping/repartition.ts" },
        ],
        message: commitMessage(
          "fix(commit-planning-grouping): attach tiny export and test follow-ups to owners",
          "- Keep compact rollout repair and repartition boundaries on the grouping root surface.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/rollout-bridge-signals.ts",
          },
          { path: "src/commit-planning/grouping/subject/path-areas.ts" },
        ],
        message: commitMessage(
          "fix(grouping-subject): attach tiny export and test follow-ups to owners",
          "- Keep subject-level bridge signals and path-area merge checks on the grouping subject surface.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/style-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/test-follow-up-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/follow-ups.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/pair-evaluation.ts",
          },
        ],
        message: commitMessage(
          "fix(subject-premerge): attach tiny export and test follow-ups to owners",
          "- Keep premerge pair evaluation and follow-up signal handling on the premerge child surface.",
        ),
      },
    ];
    const umbrellaGroup: PlannedCommit = {
      files: sourceGroups.flatMap((group) => group.files),
      message: commitMessage(
        "fix(subject-premerge): attach tiny export and test follow-ups to owners",
        "- Fold grouping root repairs, subject merge checks, and premerge follow-up handling into one umbrella rollout.",
      ),
    };
    const allFiles = umbrellaGroup.files.map((file) => makeFile(file.path));

    const result = normalizeMixedRootImplementationGroups(
      [umbrellaGroup],
      sourceGroups,
      fileMap(allFiles),
    );

    expect(
      result
        .map((group: PlannedCommit) => group.files.map((file) => file.path))
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    ).toEqual(
      sourceGroups
        .map((group) => group.files.map((file) => file.path))
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    );
    expect(subjects(result).sort()).toEqual(subjects(sourceGroups).sort());
  });

  test("normalizeMixedRootImplementationGroups splits owner buckets after detaching misaligned AI tests", () => {
    const sourceGroups: PlannedCommit[] = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/rollout-bridge-signals.ts",
          },
          { path: "src/commit-planning/grouping/subject/path-areas.ts" },
        ],
        message: commitMessage(
          "fix(grouping-subject): attach export and scoped test follow-ups correctly",
          "- Keep subject-level bridge signals and path-area merge checks on the grouping subject surface.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/group/adjacent/follow-up-rules.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping-group): attach export and scoped test follow-ups correctly",
          "- Keep adjacent follow-up ownership rules on the grouping group surface.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/premerge/style-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/test-follow-up-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/follow-ups.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/pair-evaluation.ts",
          },
          { path: "src/commit-planning/grouping/subject/premerge/index.ts" },
          {
            path: "src/commit-planning/grouping/subject/premerge/service.ts",
          },
        ],
        message: commitMessage(
          "fix(subject-premerge): attach export and scoped test follow-ups correctly",
          "- Keep premerge follow-up and pair-evaluation logic on the premerge child surface.",
        ),
      },
      {
        files: [{ path: "tests/ai-coverage.test.ts" }],
        message: commitMessage(
          "test(ai): attach export and scoped test follow-ups correctly",
          "- Keep AI coverage for export-only and scoped test follow-up routing isolated from implementation owners.",
        ),
      },
      {
        files: [{ path: "tests/ai.test.ts" }],
        message: commitMessage(
          "test(ai): attach export and scoped test follow-ups correctly",
          "- Keep AI planner regressions for scoped test follow-up routing isolated from implementation owners.",
        ),
      },
    ];
    const umbrellaGroup: PlannedCommit = {
      files: sourceGroups.flatMap((group) => group.files),
      message: commitMessage(
        "fix(premerge): attach export and scoped test follow-ups correctly",
        "- Fold subject merge signals, adjacent follow-up ownership, premerge evaluation, and AI regressions into one umbrella rollout.",
      ),
    };
    const allFiles = umbrellaGroup.files.map((file) => makeFile(file.path));

    const result = normalizeMixedRootImplementationGroups(
      [umbrellaGroup],
      sourceGroups,
      fileMap(allFiles),
    );

    expect(
      result
        .map((group: PlannedCommit) => group.files.map((file) => file.path))
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    ).toEqual(
      sourceGroups
        .map((group) => group.files.map((file) => file.path))
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    );
    expect(subjects(result).sort()).toEqual(subjects(sourceGroups).sort());
  });

  test("normalizeMixedRootImplementationGroups detaches a lone support file before splitting implementation owners", () => {
    const sourceGroups: PlannedCommit[] = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/premerge/follow-ups.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/pair-evaluation.ts",
          },
        ],
        message: commitMessage(
          "fix(subject-premerge): preserve compact rollout slices through stabilization",
          "- Keep subject premerge follow-up evaluation on its own owner surface.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/group/message-harmonization.ts",
          },
          {
            path: "src/commit-planning/grouping/group/adjacent/follow-up-rules.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping-group): preserve compact rollout slices through stabilization",
          "- Keep group harmonization and adjacent follow-up routing on the nested group surface.",
        ),
      },
      {
        files: [{ path: "tests/group-finalization.test.ts" }],
        message: commitMessage(
          "test(group-finalization): preserve compact rollout slices through stabilization",
          "- Keep finalization coverage isolated until the owning implementation surface is chosen.",
        ),
      },
    ];
    const umbrellaGroup: PlannedCommit = {
      files: sourceGroups.flatMap((group) => group.files),
      message: commitMessage(
        "fix(grouping): preserve compact rollout slices through stabilization",
        "- Fold subject premerge, group harmonization, and finalization coverage into one umbrella fix.",
      ),
    };
    const allFiles = umbrellaGroup.files.map((file) => makeFile(file.path));

    const result = normalizeMixedRootImplementationGroups(
      [umbrellaGroup],
      sourceGroups,
      fileMap(allFiles),
    );

    expect(result).toHaveLength(3);
    expect(
      result.some(
        (group) =>
          (group.message.split("\n", 1)[0] ?? "") ===
            "test(group-finalization): preserve compact rollout slices through stabilization" &&
          group.files.length === 1 &&
          group.files[0]?.path === "tests/group-finalization.test.ts",
      ),
    ).toBe(true);
    expect(
      result
        .map((group) => group.files.map((file) => file.path))
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    ).toEqual(
      sourceGroups
        .map((group) => group.files.map((file) => file.path))
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    );
  });

  test("keeps the planner-notices fixture refresh merged with the planner-ui fixture sibling in reverse order", () => {
    const files = [
      makeFile("tests/plan-display.test.ts"),
      makeFile("tests/planner-notices.test.ts"),
    ];

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [{ path: "tests/plan-display.test.ts" }],
          message: commitMessage(
            "test(planner-ui): refresh display and notice fixtures",
            "- Keep wrapped plan-display fixtures aligned with the shorter path tokens.",
          ),
        },
        {
          files: [{ path: "tests/planner-notices.test.ts" }],
          message: commitMessage(
            "test(planner-notices): refresh display and notice fixtures",
            "- Reformat notice fixtures without splitting them away from the same planner-ui change.",
          ),
        },
      ],
      fileMap(files),
    );

    expect(result).toHaveLength(1);
    expect(subjects(result)).toEqual([
      "test(planner-ui): refresh display and notice fixtures",
    ]);
  });

  test("attaches renamed-main fixture updates to the resume CLI rollout instead of leaving them standalone", () => {
    const supportGroup = {
      files: [
        { path: "tests/group-finalization.test.ts" },
        { path: "tests/terminal-line-wrapping.test.ts" },
      ],
      message: commitMessage(
        "test(cli): align renamed main-entrypoint fixtures",
        "- Replace command-line-interface path fixtures with src/cli/main.ts across grouping and wrapping coverage.",
      ),
    };
    const cliResumeGroup = {
      files: [
        { path: "src/cli/main.ts" },
        { path: "src/cli/execution-flow.ts" },
      ],
      message: commitMessage(
        "feat(cli): add resumable plan execution and shared command parsing",
        "- Add a resume command and validate bundle replay selection before execution.",
      ),
    };
    const groupingGroup = {
      files: [{ path: "src/commit-planning/grouping/group/finalization.ts" }],
      message: commitMessage(
        "fix(grouping): keep support and owner rollouts from over-merging",
        "- Tighten adjacent absorption and owner-split recovery during finalization.",
      ),
    };
    const files = [
      makeFile("tests/group-finalization.test.ts"),
      makeFile("tests/terminal-line-wrapping.test.ts"),
      makeFile("src/cli/main.ts"),
      makeFile("src/cli/execution-flow.ts"),
      makeFile("src/commit-planning/grouping/group/finalization.ts"),
    ];

    expect(
      chooseSupportAttachment(
        supportGroup,
        [cliResumeGroup, groupingGroup],
        [[0], [1]],
        buildFileChangeSignals(files),
      ),
    ).toBe(0);
  });

  test("splits git helper extraction from repository-probe hardening and path validation", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/git/commit-input-validation.ts" },
          { path: "src/git/failures.ts" },
          { path: "src/git/output-sanitization.ts" },
          { path: "src/git/operation-support.ts" },
          { path: "src/git/operations.ts" },
          { path: "src/git/index.ts" },
        ],
        message: commitMessage(
          "refactor(git): split command support helpers into focused modules",
          "- Extract commit validation, failure construction, and output sanitization into dedicated modules.",
        ),
      },
      {
        files: [
          { path: "src/git/process-environment.ts" },
          { path: "src/git/spawn-success.ts" },
          { path: "src/git/subprocess.ts" },
          { path: "src/git/repository-state.ts" },
        ],
        message: commitMessage(
          "fix(git): make repository probes non-interactive and reusable",
          "- Disable prompts during automated repository probes and expose reusable subprocess helpers.",
        ),
      },
      {
        files: [{ path: "src/git/path-validation.ts" }],
        message: commitMessage(
          "fix(git): reject unsafe and non-normalized file paths",
          "- Normalize and reject path traversal before touching the worktree.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/git/commit-input-validation.ts"),
      makeFile("src/git/failures.ts"),
      makeFile("src/git/output-sanitization.ts"),
      makeFile("src/git/operation-support.ts"),
      makeFile("src/git/operations.ts"),
      makeFile("src/git/index.ts"),
      makeFile("src/git/process-environment.ts"),
      makeFile("src/git/spawn-success.ts"),
      makeFile("src/git/subprocess.ts"),
      makeFile("src/git/repository-state.ts"),
      makeFile("src/git/path-validation.ts"),
    ];

    const result = splitWeakConsolidations(
      baselineGroups,
      [
        {
          files: baselineGroups.flatMap((group) => group.files),
          message: commitMessage(
            "refactor(git): harden support helpers and repository probes",
            "- Combine helper extraction, non-interactive probes, and path validation in one umbrella change.",
          ),
        },
      ],
      fileMap(allFiles),
      buildFileChangeSignals(allFiles),
    );

    expect(subjects(result)).toEqual(subjects(baselineGroups));
  });

  test("splits planner support-module renames from lazy OpenAI client loading", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/ai-file-paths.ts" },
          { path: "src/commit-planning/entry-normalization.ts" },
          { path: "src/commit-planning/file-batching.ts" },
          { path: "src/commit-planning/grouping/commit-coverage.ts" },
        ],
        message: commitMessage(
          "refactor(commit-planning): align renamed planner support modules",
          "- Rename shared planner support modules without changing behavior.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/openai-client.ts" },
          { path: "src/commit-planning/output-text.ts" },
        ],
        message: commitMessage(
          "refactor(openai): lazy-load the client without changing planner output",
          "- Construct the runtime client lazily while preserving request flow and token accounting.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/ai-file-paths.ts"),
      makeFile("src/commit-planning/entry-normalization.ts"),
      makeFile("src/commit-planning/file-batching.ts"),
      makeFile("src/commit-planning/grouping/commit-coverage.ts"),
      makeFile("src/commit-planning/openai-client.ts"),
      makeFile("src/commit-planning/output-text.ts"),
    ];

    const result = splitWeakConsolidations(
      baselineGroups,
      [
        {
          files: baselineGroups.flatMap((group) => group.files),
          message: commitMessage(
            "refactor(commit-planning): align planner support modules and lazy-load OpenAI",
            "- Fold support-module renames and lazy client loading into one refactor umbrella.",
          ),
        },
      ],
      fileMap(allFiles),
      buildFileChangeSignals(allFiles),
    );

    expect(subjects(result)).toEqual(subjects(baselineGroups));
  });

  test("drops leaked formatting bullets when a narrowed style slice only covers commit-planning helpers", () => {
    const broadSourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/commit-planning/usage-tracking.ts" },
          { path: "src/commit-planning/response-validation.ts" },
          { path: "src/cli/execution-flow.ts" },
          { path: "tests/verbose-output.test.ts" },
        ],
        message: commitMessage(
          "style(commit-planning): normalize formatting and shared helper usage",
          "- Switch plan cache reads to the shared planned-commit cloning helper for consistency with cache writes.",
          "- Reflow validation and token-usage expressions without changing planner behavior.",
          "- Rewrap CLI assertions and normalize file endings in verbose-output fixtures.",
        ),
      },
    ];
    const narrowedSlice: PlannedCommit = {
      files: [
        { path: "src/commit-planning/result-cache.ts" },
        { path: "src/commit-planning/usage-tracking.ts" },
        { path: "src/commit-planning/response-validation.ts" },
      ],
      message: commitMessage(
        "style(commit-planning): normalize formatting and shared helper usage",
        "- Keep only the planner-helper formatting details that the covered slice actually owns.",
      ),
    };
    const allFiles = [
      makeFile("src/commit-planning/result-cache.ts"),
      makeFile("src/commit-planning/usage-tracking.ts"),
      makeFile("src/commit-planning/response-validation.ts"),
      makeFile("src/cli/execution-flow.ts"),
      makeFile("tests/verbose-output.test.ts"),
    ];

    expect(
      rescopeGroupMessageToCoveredGroups(
        narrowedSlice,
        broadSourceGroups,
        fileMap(allFiles),
      ),
    ).toEqual({
      files: narrowedSlice.files,
      message:
        "style(commit-planning): normalize formatting and shared helper usage",
    });
  });

  test("splits prompt-builder migration from grouping helper extraction", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/prompts/index.ts" },
          { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
          { path: "src/commit-planning/prompts/stages/commit-generation.ts" },
          { path: "src/commit-planning/prompts/stages/hunk-grouping.ts" },
        ],
        message: commitMessage(
          "refactor(commit-planning): split prompt builders into rules and stages",
          "- Move prompt construction under dedicated prompts context, rules, and stage modules.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/dependency/ordering.ts" },
          { path: "src/commit-planning/grouping/file/signals.ts" },
          { path: "src/commit-planning/grouping/intent/scoring.ts" },
          {
            path: "src/commit-planning/grouping/support-attachment/test-ownership.ts",
          },
        ],
        message: commitMessage(
          "refactor(grouping): extract grouping helper modules behind focused boundaries",
          "- Split dependency, file-signal, intent, and support heuristics into their own modules.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/prompts/index.ts"),
      makeFile("src/commit-planning/prompts/stages/cluster-merge.ts"),
      makeFile("src/commit-planning/prompts/stages/commit-generation.ts"),
      makeFile("src/commit-planning/prompts/stages/hunk-grouping.ts"),
      makeFile("src/commit-planning/grouping/dependency/ordering.ts"),
      makeFile("src/commit-planning/grouping/file/signals.ts"),
      makeFile("src/commit-planning/grouping/intent/scoring.ts"),
      makeFile(
        "src/commit-planning/grouping/support-attachment/test-ownership.ts",
      ),
    ];

    const result = splitWeakConsolidations(
      baselineGroups,
      [
        {
          files: baselineGroups.flatMap((group) => group.files),
          message: commitMessage(
            "refactor(commit-planning): split prompt builders and grouping helpers",
            "- Combine prompt migration and grouping helper extraction into one large refactor.",
          ),
        },
      ],
      fileMap(allFiles),
      buildFileChangeSignals(allFiles),
    );

    expect(subjects(result)).toEqual(subjects(baselineGroups));
  });

  test("splits path resolution from saved-plan resume and support-routing umbrellas", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/resolver.ts" },
          { path: "src/commit-planning/path/structure.ts" },
        ],
        message: commitMessage(
          "feat(path): resolve planner file references across path aliases",
          "- Normalize planner file references across structural alias shapes.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/plan-bundles/index.ts" },
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/planned-commit-clone.ts" },
        ],
        message: commitMessage(
          "feat(planning): add persisted plan bundles for resumable commits",
          "- Save validated plan bundles and restore them against the same repository state.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/selection.ts",
          },
        ],
        message: commitMessage(
          "feat(grouping): attach support work to the most specific component",
          "- Score support attachment against the narrowest implementation owner.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/orchestration.ts" },
          { path: "src/commit-planning/prompts/stages/plan-consolidation.ts" },
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
        ],
        message: commitMessage(
          "feat(commit-planning): carry breaking-change mode through prompts and cache keys",
          "- Thread prompt mode and breaking mode through orchestration, consolidation prompts, caching, and token estimation.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/path/aliases.ts"),
      makeFile("src/commit-planning/path/resolver.ts"),
      makeFile("src/commit-planning/path/structure.ts"),
      makeFile("src/commit-planning/plan-bundles/index.ts"),
      makeFile("src/commit-planning/plan-bundles/service.ts"),
      makeFile("src/commit-planning/planned-commit-clone.ts"),
      makeFile(
        "src/commit-planning/grouping/support-attachment/component-attachment.ts",
      ),
      makeFile("src/commit-planning/grouping/support-attachment/selection.ts"),
      makeFile("src/commit-planning/orchestration.ts"),
      makeFile("src/commit-planning/prompts/stages/plan-consolidation.ts"),
      makeFile("src/commit-planning/result-cache.ts"),
      makeFile("src/commit-planning/token-estimation.ts"),
    ];

    const result = splitWeakConsolidations(
      baselineGroups,
      [
        {
          files: baselineGroups.flatMap((group) => group.files),
          message: commitMessage(
            "feat(planning): resolve aliases, persist plan bundles, route support, and thread prompt modes",
            "- Fold path resolution, saved-plan bundles, support routing, and orchestration policy changes into one umbrella commit.",
          ),
        },
      ],
      fileMap(allFiles),
      buildFileChangeSignals(allFiles),
    );

    expect(subjects(result)).toEqual(subjects(baselineGroups));
  });

  test("splits consolidation salvage from estimation-planner prompt-context fixes", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/grouping/group/coverage-salvage.ts" },
          { path: "src/commit-planning/grouping/group/finalization.ts" },
          { path: "src/commit-planning/grouping/group/group-stability.ts" },
          { path: "src/commit-planning/grouping/group/adjacent-absorption.ts" },
        ],
        message: commitMessage(
          "fix(grouping): salvage safe consolidations after coverage mismatches",
          "- Recover valid consolidations while rejecting unstable umbrella merges.",
        ),
      },
      {
        files: [{ path: "src/commit-planning/estimation-planner.ts" }],
        message: commitMessage(
          "fix(estimation): carry prompt context into token planning",
          "- Keep token estimates aligned with the real prompt context and breaking mode.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/commit-planning/grouping/group/coverage-salvage.ts"),
      makeFile("src/commit-planning/grouping/group/finalization.ts"),
      makeFile("src/commit-planning/grouping/group/group-stability.ts"),
      makeFile("src/commit-planning/grouping/group/adjacent-absorption.ts"),
      makeFile("src/commit-planning/estimation-planner.ts"),
    ];

    const result = splitWeakConsolidations(
      baselineGroups,
      [
        {
          files: baselineGroups.flatMap((group) => group.files),
          message: commitMessage(
            "fix(grouping): salvage consolidation coverage and token planning",
            "- Fold grouping salvage and estimation planner context fixes into one broad repair.",
          ),
        },
      ],
      fileMap(allFiles),
      buildFileChangeSignals(allFiles),
    );

    expect(subjects(result)).toEqual(subjects(baselineGroups));
  });

  test("attaches the CLI default-model assertion to the config default change instead of leaving it separate", () => {
    const supportGroup = {
      files: [{ path: "tests/cli.test.ts" }],
      message: commitMessage(
        "test(cli): update defaults for the new OpenAI model",
        "- Replace the stale gpt-4o-mini assertion with the current config default.",
      ),
    };
    const configDefaultsGroup = {
      files: [
        { path: "src/application/config/schema.ts" },
        { path: "tests/config.test.ts" },
      ],
      message: commitMessage(
        "feat(config): document saved plan bundles and new defaults",
        "- Switch the documented default model to gpt-5.3-codex and update config defaults coverage.",
      ),
    };
    const clientContractsGroup = {
      files: [{ path: "src/commit-planning/client-contracts.ts" }],
      message: commitMessage(
        "fix(openai): allow temperature for GPT-5 codex models",
        "- Keep sampling controls enabled for codex-flavored GPT-5 requests.",
      ),
    };
    const files = [
      makeFile("tests/cli.test.ts"),
      makeFile("src/application/config/schema.ts"),
      makeFile("tests/config.test.ts"),
      makeFile("src/commit-planning/client-contracts.ts"),
    ];

    expect(
      chooseSupportAttachment(
        supportGroup,
        [configDefaultsGroup, clientContractsGroup],
        [[0], [1]],
        buildFileChangeSignals(files),
      ),
    ).toBe(0);
  });

  test("merges the EOF confirmation fix with the adjacent newline-only same-file shard", () => {
    const files = [makeFile("src/cli/token/confirmation.ts", 2)];

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [{ hunks: [0], path: "src/cli/token/confirmation.ts" }],
          message: commitMessage(
            "fix(token): abort confirmation on prompt EOF",
            "- Treat closed stdin as a declined confirmation instead of auto-accepting.",
          ),
        },
        {
          files: [{ hunks: [1], path: "src/cli/token/confirmation.ts" }],
          message: commitMessage(
            "style(token): add trailing newline to confirmation module",
            "- Normalize file termination without changing runtime behavior.",
          ),
        },
      ],
      fileMap(files),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.files).toEqual([
      { hunks: [0, 1], path: "src/cli/token/confirmation.ts" },
    ]);
  });

  test("keeps the EOF confirmation fix as the primary subject after absorbing the newline-only shard", () => {
    const files = [makeFile("src/cli/token/confirmation.ts", 2)];

    const result = absorbIncidentalAdjacentGroups(
      [
        {
          files: [{ hunks: [0], path: "src/cli/token/confirmation.ts" }],
          message: commitMessage(
            "fix(token): abort confirmation on prompt EOF",
            "- Treat closed stdin as a declined confirmation instead of auto-accepting.",
          ),
        },
        {
          files: [{ hunks: [1], path: "src/cli/token/confirmation.ts" }],
          message: commitMessage(
            "style(token): add trailing newline to confirmation module",
            "- Normalize file termination without changing runtime behavior.",
          ),
        },
      ],
      fileMap(files),
    );

    expect(result[0]?.message.split("\n", 1)[0]).toBe(
      "fix(token): abort confirmation on prompt EOF",
    );
  });

  test("splits CLI export cleanup from plan-display normalization helpers", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/cli/staging-guard.ts" },
          { path: "src/cli/terminal/index.ts" },
          { path: "src/cli/token/index.ts" },
          { path: "src/cli/verbose-rendering/index.ts" },
          { path: "src/cli/verbose-output.ts" },
        ],
        message: commitMessage(
          "refactor(cli): tighten exports and align formatter imports",
          "- Replace wildcard barrel exports with explicit public symbols across CLI helper modules.",
        ),
      },
      {
        files: [
          { path: "src/cli/commit/plan-display.ts" },
          { path: "src/cli/counts.ts" },
          { path: "src/cli/commit/execution.ts" },
        ],
        message: commitMessage(
          "refactor(cli): normalize plan display helpers and formatting",
          "- Strip repository prefixes from displayed paths and keep execution formatting local to the plan-display surface.",
        ),
      },
    ];
    const allFiles = [
      makeFile("src/cli/staging-guard.ts"),
      makeFile("src/cli/terminal/index.ts"),
      makeFile("src/cli/token/index.ts"),
      makeFile("src/cli/verbose-rendering/index.ts"),
      makeFile("src/cli/verbose-output.ts"),
      makeFile("src/cli/commit/plan-display.ts"),
      makeFile("src/cli/counts.ts"),
      makeFile("src/cli/commit/execution.ts"),
    ];

    const result = splitWeakConsolidations(
      baselineGroups,
      [
        {
          files: baselineGroups.flatMap((group) => group.files),
          message: commitMessage(
            "refactor(cli): tighten exports and normalize plan display helpers",
            "- Fold CLI export cleanup together with plan-display normalization and execution formatting.",
          ),
        },
      ],
      fileMap(allFiles),
      buildFileChangeSignals(allFiles),
    );

    expect(subjects(result)).toEqual(subjects(baselineGroups));
  });

  test("splits a broad tests-formatting umbrella by structural domain instead of keeping one global style commit", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "tests/diff.test.ts" },
          { path: "tests/git-coverage.test.ts" },
          { path: "tests/git-header.test.ts" },
          { path: "tests/output-presentation.test.ts" },
        ],
        message: commitMessage(
          "style(tests): normalize wrapping in git and output fixtures",
          "- Reflow git and output-presentation assertions without mixing them with terminal or staging fixtures.",
        ),
      },
      {
        files: [
          { path: "tests/terminal-geometry.test.ts" },
          { path: "tests/terminal-line-wrapping.test.ts" },
          { path: "tests/verbose-output.test.ts" },
        ],
        message: commitMessage(
          "style(tests): normalize wrapping in terminal and verbose fixtures",
          "- Keep terminal rendering fixture churn grouped by the terminal UI surface.",
        ),
      },
      {
        files: [
          { path: "tests/response-validation.test.ts" },
          { path: "tests/staging.test.ts" },
          { path: "tests/zz-cli-coverage.test.ts" },
        ],
        message: commitMessage(
          "style(tests): normalize wrapping in staging and planner-validation fixtures",
          "- Reflow staging and validation assertions without merging them into unrelated git or terminal formatting.",
        ),
      },
    ];
    const allFiles = [
      makeFile("tests/diff.test.ts"),
      makeFile("tests/git-coverage.test.ts"),
      makeFile("tests/git-header.test.ts"),
      makeFile("tests/output-presentation.test.ts"),
      makeFile("tests/terminal-geometry.test.ts"),
      makeFile("tests/terminal-line-wrapping.test.ts"),
      makeFile("tests/verbose-output.test.ts"),
      makeFile("tests/response-validation.test.ts"),
      makeFile("tests/staging.test.ts"),
      makeFile("tests/zz-cli-coverage.test.ts"),
    ];

    const result = splitWeakConsolidations(
      baselineGroups,
      [
        {
          files: baselineGroups.flatMap((group) => group.files),
          message: commitMessage(
            "style(tests): reflow assertions and normalize file endings",
            "- Rewrap git, terminal, staging, planner-validation, and CLI coverage assertions in one global formatting umbrella.",
          ),
        },
      ],
      fileMap(allFiles),
      buildFileChangeSignals(allFiles),
    );

    expect(subjects(result)).toEqual(subjects(baselineGroups));
  });

  test("drops umbrella bullets when a narrowed CLI test slice no longer covers config support scopes", () => {
    const umbrellaSourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "tests/cli.test.ts" },
          { path: "tests/config.test.ts" },
        ],
        message: commitMessage(
          "test(cli): align defaults and isolate OPENAI_API_KEY in tests",
          "- Update default-model assertions across config and CLI init coverage.",
          "- Replace the legacy performance default assertion with performance.maxSavedPlanBundles coverage.",
          "- Snapshot and clear OPENAI_API_KEY during config tests, then restore it in teardown.",
        ),
      },
    ];
    const narrowedSlice: PlannedCommit = {
      files: [{ path: "tests/cli.test.ts" }],
      message: commitMessage(
        "test(cli): align defaults and isolate OPENAI_API_KEY in tests",
        "- Keep only the CLI-facing default and help-surface expectations on this slice.",
      ),
    };

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      umbrellaSourceGroups,
      fileMap([
        makeFile("tests/cli.test.ts"),
        makeFile("tests/config.test.ts"),
      ]),
    );

    expect(result.files).toEqual(narrowedSlice.files);
    expect(result.message.split("\n")[0]).toBe(
      "test(cli): align defaults and isolate OPENAI_API_KEY in tests",
    );
    expect(result.message).not.toContain("config and CLI init coverage");
    expect(result.message).not.toContain("maxSavedPlanBundles");
    expect(result.message).not.toContain("config tests");
  });

  test("splits a broad style(tests) umbrella away from unrelated config and CLI expectation updates", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "tests/diff.test.ts" },
          { path: "tests/git-coverage.test.ts" },
          { path: "tests/git-header.test.ts" },
          { path: "tests/output-presentation.test.ts" },
          { path: "tests/staging.test.ts" },
          { path: "tests/terminal-geometry.test.ts" },
          { path: "tests/terminal-line-wrapping.test.ts" },
        ],
        message: commitMessage(
          "style(tests): normalize wrapping in git, staging, and terminal fixtures",
          "- Keep layout-only test fixture churn isolated from semantic CLI and config expectation updates.",
        ),
      },
      {
        files: [{ path: "tests/config.test.ts" }],
        message: commitMessage(
          "test(config): cover saved bundle defaults and env-key isolation",
          "- Keep config default and OPENAI_API_KEY expectation changes separate from broad formatting-only test churn.",
        ),
      },
      {
        files: [
          { path: "tests/cli.test.ts" },
          { path: "tests/entrypoints.test.ts" },
        ],
        message: commitMessage(
          "test(cli): align CLI and entrypoint expectations with resume flows",
          "- Keep CLI help and entrypoint expectation updates grouped without folding them into formatting umbrellas.",
        ),
      },
    ];
    const allFiles = baselineGroups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    const result = splitWeakConsolidations(
      baselineGroups,
      [
        {
          files: baselineGroups.flatMap((group) => group.files),
          message: commitMessage(
            "style(tests): apply formatting and explicit export cleanup",
            "- Reflow test assertions and file endings while also updating CLI and config expectations in one umbrella.",
            "- Replace removed cache TTL assertions with saved bundle coverage and align CLI entrypoint defaults.",
          ),
        },
      ],
      fileMap(allFiles),
      buildFileChangeSignals(allFiles),
    );

    expect(subjects(result)).toEqual(subjects(baselineGroups));
    expect(result.map((group) => group.files)).toEqual(
      baselineGroups.map((group) => group.files),
    );
  });

  test("commit 3 keeps tests/tsconfig fixture churn grouped with the trace-regression fixture sweep", () => {
    expectAdjacentGroupsToMerge({
      allFiles: [
        makeFile("tests/trace-regression-boundaries.test.ts"),
        makeFile("tests/tsconfig.json"),
      ],
      groups: [
        {
          files: [{ path: "tests/trace-regression-boundaries.test.ts" }],
          message: commitMessage(
            "test(trace-regression): lock boundary fixtures for verbose trace output",
            "- Cover the planner fallback boundary decisions that split or absorb nearby fixture shards.",
          ),
        },
        {
          files: [{ path: "tests/tsconfig.json" }],
          message: commitMessage(
            "test(tsconfig): keep trace-regression fixture build settings aligned",
            "- Preserve the Node test fixture options needed by the same trace-regression rollout.",
          ),
        },
      ],
      mergedSubject:
        "test(trace-regression): lock boundary fixtures for verbose trace output",
    });
  });

  test("commit 5 keeps planner-notices fixture updates merged with the broader planner-ui fixture sweep", () => {
    expectAdjacentGroupsToMerge({
      allFiles: [
        makeFile("tests/planner-notices.test.ts"),
        makeFile("tests/planner-helpers.test.ts"),
        makeFile("tests/plan-display.test.ts"),
      ],
      groups: [
        {
          files: [{ path: "tests/plan-display.test.ts" }],
          message: commitMessage(
            "test(planner-ui): refresh helper and notice fixtures",
            "- Keep plan-display snapshots aligned with the same planner-ui wording sweep.",
          ),
        },
        {
          files: [
            { path: "tests/planner-notices.test.ts" },
            { path: "tests/planner-helpers.test.ts" },
          ],
          message: commitMessage(
            "test(planner-notices): refresh helper and notice fixtures",
            "- Update planner notices and helper fixtures without splitting them away from the same planner-ui fixture rollout.",
          ),
        },
      ],
      mergedFiles: [
        { path: "tests/plan-display.test.ts" },
        { path: "tests/planner-notices.test.ts" },
        { path: "tests/planner-helpers.test.ts" },
      ],
      mergedSubject: "test(planner-ui): refresh helper and notice fixtures",
    });
  });

  test("commit 6 keeps the tiny terminal-width expectation with the renamed main-entrypoint fixture sweep", () => {
    expectAdjacentGroupsToMerge({
      allFiles: [
        makeFile("tests/group-finalization.test.ts"),
        makeFile("tests/terminal-line-wrapping.test.ts"),
      ],
      groups: [
        {
          files: [{ path: "tests/group-finalization.test.ts" }],
          message: commitMessage(
            "test(cli): align renamed main-entrypoint fixtures",
            "- Refresh grouped fixture snapshots after moving the CLI entrypoint to main.ts.",
          ),
        },
        {
          files: [{ path: "tests/terminal-line-wrapping.test.ts" }],
          message: commitMessage(
            "test(terminal): align tiny-width token wrapping expectation",
            "- Keep the tiny-width split points aligned with the same renamed main-entrypoint fixture refresh.",
          ),
        },
      ],
      mergedSubject: "test(cli): align renamed main-entrypoint fixtures",
    });
  });

  test("commit 7 keeps verbose-output fixture refresh grouped with the trace-regression fixture sweep", () => {
    expectAdjacentGroupsToMerge({
      allFiles: [
        makeFile("tests/trace-regression-boundaries.test.ts"),
        makeFile("tests/verbose-output.test.ts"),
        makeFile("tests/tsconfig.json"),
      ],
      groups: [
        {
          files: [{ path: "tests/verbose-output.test.ts" }],
          message: commitMessage(
            "test(verbose-output): lock boundary fixtures for verbose trace output",
            "- Rewrap verbose-output snapshots in the same trace-driven fixture sweep.",
          ),
        },
        {
          files: [
            { path: "tests/trace-regression-boundaries.test.ts" },
            { path: "tests/tsconfig.json" },
          ],
          message: commitMessage(
            "test(trace-regression): lock boundary fixtures for verbose trace output",
            "- Capture the trace-driven grouping regressions and fixture build settings in the same sweep.",
          ),
        },
      ],
      mergedFiles: [
        { path: "tests/verbose-output.test.ts" },
        { path: "tests/trace-regression-boundaries.test.ts" },
        { path: "tests/tsconfig.json" },
      ],
      mergedSubject:
        "test(verbose-output): lock boundary fixtures for verbose trace output",
    });
  });

  test("commit 12 keeps plan-display fixture updates merged with the planner helper fixture sweep", () => {
    expectAdjacentGroupsToMerge({
      allFiles: [
        makeFile("tests/plan-display.test.ts"),
        makeFile("tests/planner-helpers.test.ts"),
        makeFile("tests/planner-notices.test.ts"),
      ],
      groups: [
        {
          files: [{ path: "tests/planner-notices.test.ts" }],
          message: commitMessage(
            "test(planner-ui): refresh helper and display fixtures",
            "- Keep planner notice expectations aligned with the shorter display paths.",
          ),
        },
        {
          files: [
            { path: "tests/plan-display.test.ts" },
            { path: "tests/planner-helpers.test.ts" },
          ],
          message: commitMessage(
            "test(plan-display): refresh helper and display fixtures",
            "- Update wrapped plan-display and planner-helper expectations without splitting them away from the same planner-ui fixture sweep.",
          ),
        },
      ],
      mergedFiles: [
        { path: "tests/planner-notices.test.ts" },
        { path: "tests/plan-display.test.ts" },
        { path: "tests/planner-helpers.test.ts" },
      ],
      mergedSubject: "test(planner-ui): refresh helper and display fixtures",
    });
  });

  test("commit 16 keeps the dedicated trace-regression suite merged with verbose fixture updates", () => {
    expectAdjacentGroupsToMerge({
      allFiles: [
        makeFile("tests/trace-regression-boundaries.test.ts"),
        makeFile("tests/verbose-output.test.ts"),
        makeFile("tests/tsconfig.json"),
      ],
      groups: [
        {
          files: [{ path: "tests/trace-regression-boundaries.test.ts" }],
          message: commitMessage(
            "test(trace-regression): lock commit-boundary and verbose fixture updates",
            "- Add the dedicated trace boundary suite for the same verbose fixture refresh.",
          ),
        },
        {
          files: [
            { path: "tests/verbose-output.test.ts" },
            { path: "tests/tsconfig.json" },
          ],
          message: commitMessage(
            "test(verbose-output): lock commit-boundary and verbose fixture updates",
            "- Keep verbose snapshots and the tests tsconfig fixture aligned with the same trace-regression rollout.",
          ),
        },
      ],
      mergedSubject:
        "test(trace-regression): lock commit-boundary and verbose fixture updates",
    });
  });

  test("commit 20 splits README resume docs from config-default and CLI coverage churn", () => {
    const umbrellaSourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "README.md" },
          { path: "src/application/config/schema.ts" },
          { path: "tests/cli.test.ts" },
          { path: "tests/config.test.ts" },
        ],
        message: commitMessage(
          "docs(readme): refresh CLI guidance for resume and new defaults",
          "- Rewrite the README guidance for resume commands and saved plan bundles.",
          "- Update schema defaults and config coverage for the new default model.",
          "- Rewrap CLI assertions for resume selection and default-model help text.",
        ),
      },
    ];
    const narrowedSlice: PlannedCommit = {
      files: [
        { path: "src/application/config/schema.ts" },
        { path: "tests/config.test.ts" },
      ],
      message: commitMessage(
        "test(config): align default-model coverage with the new schema",
        "- Keep only schema-default and config assertion details on the narrowed slice.",
      ),
    };

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      umbrellaSourceGroups,
      fileMap([
        makeFile("README.md"),
        makeFile("src/application/config/schema.ts"),
        makeFile("tests/cli.test.ts"),
        makeFile("tests/config.test.ts"),
      ]),
    );

    expect(result.files).toEqual(narrowedSlice.files);
    expect(result.message.split("\n", 1)[0]).toBe(
      "test(config): align default-model coverage with the new schema",
    );
    expect(result.message).not.toContain("README guidance");
    expect(result.message).not.toContain("resume selection");
    expect(result.message).not.toContain("saved plan bundles");
  });

  test("commit 21 keeps planner-helpers coverage grouped with the same planner-ui fixture sweep", () => {
    expectAdjacentGroupsToMerge({
      allFiles: [
        makeFile("tests/planner-helpers.test.ts"),
        makeFile("tests/plan-display.test.ts"),
        makeFile("tests/planner-notices.test.ts"),
      ],
      groups: [
        {
          files: [{ path: "tests/planner-notices.test.ts" }],
          message: commitMessage(
            "test(planner-ui): refresh helper and display fixtures",
            "- Keep planner-notices fixtures aligned with the same planner-ui expectation refresh.",
          ),
        },
        {
          files: [
            { path: "tests/planner-helpers.test.ts" },
            { path: "tests/plan-display.test.ts" },
          ],
          message: commitMessage(
            "test(planner-helpers): refresh helper and display fixtures",
            "- Refresh helper coverage and plan-display expectations without splitting them away from the same planner-ui fixture sweep.",
          ),
        },
      ],
      mergedFiles: [
        { path: "tests/planner-notices.test.ts" },
        { path: "tests/planner-helpers.test.ts" },
        { path: "tests/plan-display.test.ts" },
      ],
      mergedSubject: "test(planner-ui): refresh helper and display fixtures",
    });
  });

  test("commit 22 merges planning-workflow prompt-import cleanup with the prompt-stage centralization rollout", () => {
    const umbrellaSourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/planning-workflow.ts" },
          { path: "src/commit-planning/planner-heuristics.ts" },
          { path: "src/commit-planning/prompts/index.ts" },
          { path: "src/commit-planning/prompts/stages/cluster-merge.ts" },
          { path: "src/commit-planning/prompts/stages/commit-generation.ts" },
        ],
        message: commitMessage(
          "refactor(commit-planning): centralize prompt rules and workflow imports",
          "- Fold prompt-stage extraction and workflow import cleanup into one refactor umbrella.",
          "- Rewrap planner-heuristics cleanup while touching the same planning workflow migration.",
        ),
      },
    ];
    const narrowedSlice: PlannedCommit = {
      files: [{ path: "src/commit-planning/planning-workflow.ts" }],
      message: commitMessage(
        "refactor(planning-workflow): relocate prompt imports",
        "- Keep only the workflow import migration details on the narrowed slice.",
      ),
    };

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      umbrellaSourceGroups,
      fileMap([
        makeFile("src/commit-planning/planning-workflow.ts"),
        makeFile("src/commit-planning/planner-heuristics.ts"),
        makeFile("src/commit-planning/prompts/index.ts"),
        makeFile("src/commit-planning/prompts/stages/cluster-merge.ts"),
        makeFile("src/commit-planning/prompts/stages/commit-generation.ts"),
      ]),
    );

    expect(result.files).toEqual(narrowedSlice.files);
    expect(result.message.split("\n", 1)[0]).toBe(
      "refactor(planning-workflow): relocate prompt imports",
    );
    expect(result.message).not.toContain("planner-heuristics cleanup");
    expect(result.message).not.toContain("prompt-stage extraction");
  });

  test("commit 25 merges ai.test ownership-boundary coverage with the adjacent AI planner regression sweep", () => {
    expectAdjacentGroupsToMerge({
      allFiles: [
        makeFile("tests/ai.test.ts"),
        makeFile("tests/ai-coverage.test.ts"),
      ],
      groups: [
        {
          files: [{ path: "tests/ai-coverage.test.ts" }],
          message: commitMessage(
            "test(ai): expand grouping finalization and repartition coverage",
            "- Cover finalization fallback and repartition behavior in the AI planner suite.",
          ),
        },
        {
          files: [{ path: "tests/ai.test.ts" }],
          message: commitMessage(
            "test(commit-planning): expand premerge ownership guard coverage",
            "- Add deterministic ownership-boundary regressions for the same AI planner rollout.",
          ),
        },
      ],
      mergedSubject:
        "test(ai): expand grouping finalization and repartition coverage",
    });
  });

  test("commit 30 splits CLI export cleanup from session-display and plan-display normalization helpers", () => {
    const umbrellaSourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/cli/staging-guard.ts" },
          { path: "src/cli/terminal/index.ts" },
          { path: "src/cli/token/index.ts" },
          { path: "src/cli/verbose-rendering/index.ts" },
          { path: "src/cli/session-display.ts" },
          { path: "src/cli/commit/plan-display.ts" },
          { path: "src/cli/commit/execution.ts" },
          { path: "src/cli/counts.ts" },
        ],
        message: commitMessage(
          "refactor(cli): tighten exports and normalize display helpers",
          "- Replace wildcard barrels with explicit exports on the CLI helper surfaces.",
          "- Normalize session-display and plan-display helper output in the same umbrella cleanup.",
        ),
      },
    ];
    const narrowedSlice: PlannedCommit = {
      files: [
        { path: "src/cli/commit/plan-display.ts" },
        { path: "src/cli/commit/execution.ts" },
        { path: "src/cli/counts.ts" },
      ],
      message: commitMessage(
        "refactor(display): normalize plan and session display helpers",
        "- Keep only the plan-display normalization details on the narrowed slice.",
      ),
    };

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      umbrellaSourceGroups,
      fileMap([
        makeFile("src/cli/staging-guard.ts"),
        makeFile("src/cli/terminal/index.ts"),
        makeFile("src/cli/token/index.ts"),
        makeFile("src/cli/verbose-rendering/index.ts"),
        makeFile("src/cli/session-display.ts"),
        makeFile("src/cli/commit/plan-display.ts"),
        makeFile("src/cli/commit/execution.ts"),
        makeFile("src/cli/counts.ts"),
      ]),
    );

    expect(result.files).toEqual(narrowedSlice.files);
    expect(result.message.split("\n", 1)[0]).toBe(
      "refactor(display): normalize plan and session display helpers",
    );
    expect(result.message).not.toContain("wildcard barrels");
    expect(result.message).not.toContain("CLI helper surfaces");
  });

  test("commit 31 merges isolated CLI style follow-ups into the adjacent CLI surface rollout", () => {
    expectAdjacentGroupsToMerge({
      allFiles: [
        makeFile("src/cli/execution-flow.ts"),
        makeFile("src/cli/output-presentation.ts"),
      ],
      groups: [
        {
          files: [{ path: "src/cli/execution-flow.ts" }],
          message: commitMessage(
            "feat(cli): add resumable plan execution and selection parsing",
            "- Thread resume selection through execution-flow.",
          ),
        },
        {
          files: [{ path: "src/cli/output-presentation.ts" }],
          message: commitMessage(
            "style(cli): apply formatting and newline consistency cleanup",
            "- Reflow output-presentation helpers without changing the adjacent CLI rollout behavior.",
          ),
        },
      ],
      mergedSubject:
        "feat(cli): add resumable plan execution and selection parsing",
    });
  });

  test("commit 11 drops leaked planning and test bullets when a style(git) slice only covers git utilities", () => {
    const broadSourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/git/chunks.ts" },
          { path: "src/git/diff.ts" },
          { path: "src/git/formatting.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
          { path: "tests/staging.test.ts" },
        ],
        message: commitMessage(
          "style(git): apply formatting and newline consistency cleanup",
          "- Reflow long git utility expressions without changing runtime behavior.",
          "- Normalize planner token-estimation formatting after the shared helper sweep.",
          "- Rewrap staging assertions while touching the same broad formatting umbrella.",
        ),
      },
    ];
    const narrowedSlice: PlannedCommit = {
      files: [
        { path: "src/git/chunks.ts" },
        { path: "src/git/diff.ts" },
        { path: "src/git/formatting.ts" },
      ],
      message: commitMessage(
        "style(git): apply formatting and newline consistency cleanup",
        "- Keep only the git utility formatting details that the covered slice owns.",
      ),
    };

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      broadSourceGroups,
      fileMap([
        makeFile("src/git/chunks.ts"),
        makeFile("src/git/diff.ts"),
        makeFile("src/git/formatting.ts"),
        makeFile("src/commit-planning/token-estimation.ts"),
        makeFile("tests/staging.test.ts"),
      ]),
    );

    expect(result.files).toEqual(narrowedSlice.files);
    expect(result.message.split("\n", 1)[0]).toBe(
      "style(git): apply formatting and newline consistency cleanup",
    );
    expect(result.message).not.toContain("token-estimation");
    expect(result.message).not.toContain("staging assertions");
  });

  test("commit 26 drops leaked git and test bullets when a style(commit-planning) slice only covers planner helpers", () => {
    const broadSourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/response-validation.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
          { path: "src/git/diff.ts" },
          { path: "tests/zz-cli-coverage.test.ts" },
        ],
        message: commitMessage(
          "style(commit-planning): apply formatting and newline consistency cleanup",
          "- Reflow planner validation and token estimation helpers.",
          "- Normalize git diff helper wrapping during the same broad formatting sweep.",
          "- Rewrap CLI coverage assertions touched by the umbrella formatter pass.",
        ),
      },
    ];
    const narrowedSlice: PlannedCommit = {
      files: [
        { path: "src/commit-planning/response-validation.ts" },
        { path: "src/commit-planning/token-estimation.ts" },
      ],
      message: commitMessage(
        "style(commit-planning): apply formatting and newline consistency cleanup",
        "- Preserve only the planner-helper formatting details for the covered slice.",
      ),
    };

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      broadSourceGroups,
      fileMap([
        makeFile("src/commit-planning/response-validation.ts"),
        makeFile("src/commit-planning/token-estimation.ts"),
        makeFile("src/git/diff.ts"),
        makeFile("tests/zz-cli-coverage.test.ts"),
      ]),
    );

    expect(result.files).toEqual(narrowedSlice.files);
    expect(result.message.split("\n", 1)[0]).toBe(
      "style(commit-planning): apply formatting and newline consistency cleanup",
    );
    expect(result.message).not.toContain("git diff helper");
    expect(result.message).not.toContain("CLI coverage assertions");
  });

  test("commit 28 splits grouping harmonization and owner-split fixes from prompt-mode cache validation changes", () => {
    const umbrellaSourceGroups: PlannedCommit[] = [
      {
        files: [
          {
            path: "src/commit-planning/grouping/group/message-harmonization.ts",
          },
          { path: "src/commit-planning/grouping/group/group-stability.ts" },
          {
            path: "src/commit-planning/grouping/support-attachment/selection.ts",
          },
          { path: "src/commit-planning/prompts/stages/plan-consolidation.ts" },
          { path: "src/commit-planning/response-validation.ts" },
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
        ],
        message: commitMessage(
          "fix(commit-planning): preserve scoped grouping intent while aligning prompt modes",
          "- Fold grouping harmonization, support attachment, prompt modes, cache keys, and token estimates into one umbrella repair.",
          "- Rework support-attachment selection while touching the same prompt-mode validation surface.",
        ),
      },
    ];
    const narrowedSlice: PlannedCommit = {
      files: [
        { path: "src/commit-planning/grouping/group/message-harmonization.ts" },
        { path: "src/commit-planning/grouping/group/group-stability.ts" },
      ],
      message: commitMessage(
        "fix(grouping): preserve scoped commit intent after consolidation",
        "- Keep only the harmonization and consolidation stability details on the narrowed slice.",
      ),
    };

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      umbrellaSourceGroups,
      fileMap([
        makeFile("src/commit-planning/grouping/group/message-harmonization.ts"),
        makeFile("src/commit-planning/grouping/group/group-stability.ts"),
        makeFile(
          "src/commit-planning/grouping/support-attachment/selection.ts",
        ),
        makeFile("src/commit-planning/prompts/stages/plan-consolidation.ts"),
        makeFile("src/commit-planning/response-validation.ts"),
        makeFile("src/commit-planning/result-cache.ts"),
        makeFile("src/commit-planning/token-estimation.ts"),
      ]),
    );

    expect(result.files).toEqual(narrowedSlice.files);
    expect(result.message.split("\n", 1)[0]).toBe(
      "fix(grouping): preserve scoped commit intent after consolidation",
    );
    expect(result.message).not.toContain("prompt modes");
    expect(result.message).not.toContain("cache keys");
    expect(result.message).not.toContain("token estimates");
  });

  test("commit 32 splits path aliases, resumable plans, support routing, and trace persistence into separate rollouts", () => {
    const umbrellaSourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/resolver.ts" },
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/planned-commit-clone.ts" },
          {
            path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/selection.ts",
          },
          { path: "src/commit-planning/orchestration.ts" },
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/cli/trace-persistence.ts" },
          { path: "src/cli/session-display.ts" },
        ],
        message: commitMessage(
          "feat(planning): resolve aliases, persist bundles, route support, and persist trace output",
          "- Fold path aliases, plan bundles, support routing, and trace persistence into one umbrella feature.",
          "- Thread prompt modes through orchestration and cache keys during the same planning sweep.",
        ),
      },
    ];
    const narrowedSlice: PlannedCommit = {
      files: [
        { path: "src/commit-planning/path/aliases.ts" },
        { path: "src/commit-planning/path/resolver.ts" },
      ],
      message: commitMessage(
        "feat(path): add structural path alias resolution for commit planning",
        "- Keep only the path-alias resolution details on the narrowed slice.",
      ),
    };

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      umbrellaSourceGroups,
      fileMap([
        makeFile("src/commit-planning/path/aliases.ts"),
        makeFile("src/commit-planning/path/resolver.ts"),
        makeFile("src/commit-planning/plan-bundles/service.ts"),
        makeFile("src/commit-planning/planned-commit-clone.ts"),
        makeFile(
          "src/commit-planning/grouping/support-attachment/component-attachment.ts",
        ),
        makeFile(
          "src/commit-planning/grouping/support-attachment/selection.ts",
        ),
        makeFile("src/commit-planning/orchestration.ts"),
        makeFile("src/commit-planning/result-cache.ts"),
        makeFile("src/cli/trace-persistence.ts"),
        makeFile("src/cli/session-display.ts"),
      ]),
    );

    expect(result.files).toEqual(narrowedSlice.files);
    expect(result.message.split("\n", 1)[0]).toBe(
      "feat(path): add structural path alias resolution for commit planning",
    );
    expect(result.message).not.toContain("plan bundles");
    expect(result.message).not.toContain("support routing");
    expect(result.message).not.toContain("trace persistence");
  });

  test("splits a broad commit-planning umbrella that chains prompt stages, plan bundles, path resolution, support routing, and CLI resume flows", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/prompts/index.ts" },
          {
            path: "src/commit-planning/prompts/rules/cluster-merge.ts",
          },
          {
            path: "src/commit-planning/prompts/stages/plan-consolidation.ts",
          },
        ],
        message: commitMessage(
          "feat(prompts): add modular prompt stages for planning flows",
          "- Keep prompt-stage builders and prompt-rule exports on the same prompt surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/resolver.ts" },
          {
            path: "src/commit-planning/path/repository-structure.ts",
          },
        ],
        message: commitMessage(
          "feat(path): resolve planner file references across structural aliases",
          "- Keep alias, resolver, and repository-structure work together on the path surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/plan-bundles/hashes.ts" },
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/plan-bundles/storage.ts" },
          { path: "src/commit-planning/planned-commit-clone.ts" },
        ],
        message: commitMessage(
          "feat(plan-bundles): persist and restore validated plan bundles",
          "- Keep bundle hashing, storage, and cloned-plan persistence on the same saved-plan rollout.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/support-attachment/component-attachment.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/selection.ts",
          },
          {
            path: "src/commit-planning/grouping/support-attachment/single-owner-anchor.ts",
          },
        ],
        message: commitMessage(
          "feat(grouping): route support commits through decisive attachment scoring",
          "- Keep support attachment selection and single-owner anchors together on the grouping surface.",
        ),
      },
      {
        files: [
          { path: "src/cli/execution-flow.ts" },
          { path: "src/cli/main.ts" },
          { path: "src/cli/options.ts" },
        ],
        message: commitMessage(
          "feat(cli): add resumable plan execution with subset selection",
          "- Keep resume execution flow, CLI entry wiring, and selector parsing together.",
        ),
      },
    ];
    const allFiles = baselineGroups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    const result = splitWeakConsolidations(
      baselineGroups,
      [
        {
          files: baselineGroups.flatMap((group) => group.files),
          message: commitMessage(
            "feat(commit-planning): add modular prompt stages and breaking-aware planning",
            "- Fold prompt stages, path aliases, plan bundles, support routing, and CLI resume flows into one umbrella feature.",
            "- Thread breaking-aware planning and shared prompt mode behavior through the same broad planning rollout.",
          ),
        },
      ],
      fileMap(allFiles),
      buildFileChangeSignals(allFiles),
    );

    expect(subjects(result)).toEqual(subjects(baselineGroups));
    expect(result.map((group) => group.files)).toEqual(
      baselineGroups.map((group) => group.files),
    );
  });

  test("commit 34 keeps test formatting shards split by structural test domain", () => {
    const umbrellaSourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "tests/diff.test.ts" },
          { path: "tests/git-coverage.test.ts" },
          { path: "tests/output-presentation.test.ts" },
          { path: "tests/terminal-geometry.test.ts" },
          { path: "tests/verbose-output.test.ts" },
          { path: "tests/response-validation.test.ts" },
          { path: "tests/staging.test.ts" },
          { path: "tests/zz-cli-coverage.test.ts" },
        ],
        message: commitMessage(
          "style(tests): reflow assertions and normalize file endings",
          "- Rewrap git, output, terminal, staging, validation, and CLI coverage assertions in one global style umbrella.",
          "- Keep all touched test fixtures aligned with the same formatting sweep.",
        ),
      },
    ];
    const narrowedSlice: PlannedCommit = {
      files: [
        { path: "tests/diff.test.ts" },
        { path: "tests/git-coverage.test.ts" },
        { path: "tests/output-presentation.test.ts" },
      ],
      message: commitMessage(
        "style(tests): normalize wrapping in git and output fixtures",
        "- Keep only the git and output fixture formatting details on the narrowed slice.",
      ),
    };

    const result = rescopeGroupMessageToCoveredGroups(
      narrowedSlice,
      umbrellaSourceGroups,
      fileMap([
        makeFile("tests/diff.test.ts"),
        makeFile("tests/git-coverage.test.ts"),
        makeFile("tests/output-presentation.test.ts"),
        makeFile("tests/terminal-geometry.test.ts"),
        makeFile("tests/verbose-output.test.ts"),
        makeFile("tests/response-validation.test.ts"),
        makeFile("tests/staging.test.ts"),
        makeFile("tests/zz-cli-coverage.test.ts"),
      ]),
    );

    expect(result.files).toEqual(narrowedSlice.files);
    expect(result.message.split("\n", 1)[0]).toBe(
      "style(tests): normalize wrapping in git and output fixtures",
    );
    expect(result.message).not.toContain("terminal");
    expect(result.message).not.toContain("staging");
    expect(result.message).not.toContain("CLI coverage");
  });

  test("owner-split implementation slices rewrite duplicated umbrella subjects to owner-aligned covered subjects", () => {
    const umbrellaSourceGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/plan-bundles/storage.ts" },
        ],
        message: commitMessage(
          "feat(plan-bundles): persist and verify resume-safe staged content",
          "- Keep saved staged content, hash validation, and resume safety on the bundle surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/baseline-restoration.ts" },
          { path: "src/commit-planning/grouping/component-routing.ts" },
        ],
        message: commitMessage(
          "feat(commit-planning-grouping): split weak consolidations by ownership",
          "- Keep grouping owner restoration and component routing on the grouping surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/group/normalization.ts" },
          { path: "src/commit-planning/grouping/group/primary-subject.ts" },
        ],
        message: commitMessage(
          "feat(grouping-group): keep split group messages owner-aligned",
          "- Keep split group normalization and primary subject repair on the nested group surface.",
        ),
      },
    ];
    const inheritedUmbrellaMessage = commitMessage(
      "feat(plan-bundles): persist and verify resume-safe staged content",
      "- Fold saved staged content, grouping owner restoration, and split message repair into one umbrella feature.",
    );
    const fileByPath = fileMap([
      makeFile("src/commit-planning/plan-bundles/service.ts"),
      makeFile("src/commit-planning/plan-bundles/storage.ts"),
      makeFile("src/commit-planning/grouping/baseline-restoration.ts"),
      makeFile("src/commit-planning/grouping/component-routing.ts"),
      makeFile("src/commit-planning/grouping/group/normalization.ts"),
      makeFile("src/commit-planning/grouping/group/primary-subject.ts"),
    ]);

    const groupingRootSlice = rescopeGroupMessageToCoveredGroups(
      {
        files: [
          { path: "src/commit-planning/grouping/baseline-restoration.ts" },
          { path: "src/commit-planning/grouping/component-routing.ts" },
        ],
        message: inheritedUmbrellaMessage,
      },
      umbrellaSourceGroups,
      fileByPath,
    );
    const groupingNestedSlice = rescopeGroupMessageToCoveredGroups(
      {
        files: [
          { path: "src/commit-planning/grouping/group/normalization.ts" },
          { path: "src/commit-planning/grouping/group/primary-subject.ts" },
        ],
        message: inheritedUmbrellaMessage,
      },
      umbrellaSourceGroups,
      fileByPath,
    );

    expect(groupingRootSlice.message.split("\n", 1)[0]).toBe(
      "feat(commit-planning-grouping): split weak consolidations by ownership",
    );
    expect(groupingNestedSlice.message.split("\n", 1)[0]).toBe(
      "feat(grouping-group): keep split group messages owner-aligned",
    );
    expect(groupingRootSlice.message).not.toContain(
      "resume-safe staged content",
    );
    expect(groupingNestedSlice.message).not.toContain(
      "resume-safe staged content",
    );
  });

  test("rescopeGroupMessageToCoveredGroups keeps an owner-scoped subject when the covered source group is a broader umbrella", () => {
    const umbrellaSourceGroup: PlannedCommit = {
      files: [
        {
          path: "src/commit-planning/grouping/subject/rollout-bridge-signals.ts",
        },
        { path: "src/commit-planning/grouping/subject/path-areas.ts" },
        {
          path: "src/commit-planning/grouping/group/adjacent/follow-up-rules.ts",
        },
      ],
      message: commitMessage(
        "fix(grouping): reunify compact rollout slices after support splits",
        "- Fold grouping subject and adjacent follow-up ownership repairs into one umbrella change.",
      ),
    };
    const fileByPath = fileMap([
      makeFile(
        "src/commit-planning/grouping/subject/rollout-bridge-signals.ts",
      ),
      makeFile("src/commit-planning/grouping/subject/path-areas.ts"),
      makeFile(
        "src/commit-planning/grouping/group/adjacent/follow-up-rules.ts",
      ),
    ]);

    const result = rescopeGroupMessageToCoveredGroups(
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/rollout-bridge-signals.ts",
          },
          { path: "src/commit-planning/grouping/subject/path-areas.ts" },
        ],
        message: commitMessage(
          "fix(grouping-subject): reunify compact rollout slices after support splits",
          "- Keep subject-level bridge signals and path-area merge checks on the grouping subject surface.",
        ),
      },
      [umbrellaSourceGroup],
      fileByPath,
    );

    expect(result.message.split("\n", 1)[0]).toBe(
      "fix(grouping-subject): reunify compact rollout slices after support splits",
    );
    expect(result.message).not.toContain(
      "fix(grouping): reunify compact rollout slices after support splits",
    );
  });

  test("splits breaking-mode prompt rules from grouping stabilization and commit-message parsing umbrellas", () => {
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-messages/breaking-change-footers.ts" },
          { path: "src/commit-messages/subject-parser.ts" },
        ],
        message: commitMessage(
          "fix(commit-messages): validate breaking metadata and normalized scopes",
          "- Keep breaking footer validation and scope normalization on the commit-message surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/prompts/rules/index.ts" },
          { path: "src/commit-planning/prompts/rules/plan-consolidation.ts" },
          { path: "src/commit-planning/prompts/stages/plan-consolidation.ts" },
          { path: "src/commit-planning/response-validation.ts" },
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
        ],
        message: commitMessage(
          "fix(commit-planning): centralize prompt rules and honor breaking mode",
          "- Keep prompt-rule wiring, breaking-mode validation, cache identity, and token estimation on the commit-planning surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/group/adjacent/absorption.ts" },
          { path: "src/commit-planning/grouping/group/consolidation-shape.ts" },
          { path: "src/commit-planning/grouping/group/group-stability.ts" },
        ],
        message: commitMessage(
          "fix(grouping-group): tighten adjacent absorption and consolidation stability",
          "- Keep adjacent absorption boundaries and consolidation stability on the nested group surface.",
        ),
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
          {
            path: "src/commit-planning/grouping/subject/compact-rollout-merge.ts",
          },
          { path: "src/commit-planning/grouping/subject/path-areas.ts" },
        ],
        message: commitMessage(
          "fix(grouping): tighten implementation merge and subject rollout boundaries",
          "- Keep implementation partitioning and subject rollout guards on the grouping surface.",
        ),
      },
    ];
    const allFiles = baselineGroups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    const result = splitWeakConsolidations(
      baselineGroups,
      [
        {
          files: baselineGroups.flatMap((group) => group.files),
          message: commitMessage(
            "fix(commit-planning): centralize prompt rules and honor breaking mode",
            "- Fold commit-message parsing, prompt rules, grouping stabilization, and subject rollout guards into one umbrella fix.",
            "- Keep cache identity, message harmonization, and implementation merge tightening aligned in the same broad planning rollout.",
          ),
        },
      ],
      fileMap(allFiles),
      buildFileChangeSignals(allFiles),
    );

    expect(subjects(result)).toEqual(subjects(baselineGroups));
    expect(result.map((group) => group.files)).toEqual(
      baselineGroups.map((group) => group.files),
    );
  });

  test("owner-splits a large single implementation component into owner-scoped slices", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const groups: PlannedCommit[] = [
        {
          files: [
            { path: "src/commit-planning/result-cache.ts" },
            { path: "src/commit-planning/token-estimation.ts" },
          ],
          message: commitMessage(
            "fix(commit-planning): centralize prompt rules and honor breaking mode",
            "- Keep cache identity and token estimation on the commit-planning surface.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/response-validation.ts" },
            { path: "src/commit-planning/estimation-planner.ts" },
          ],
          message: commitMessage(
            "fix(commit-planning): centralize prompt rules and honor breaking mode",
            "- Keep prompt validation and follow-up estimation passes on the commit-planning surface.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/grouping/group/events.ts" },
            { path: "src/commit-planning/grouping/group/group-stability.ts" },
          ],
          message: commitMessage(
            "fix(commit-planning): centralize prompt rules and honor breaking mode",
            "- Keep grouping fallback events and stability checks on the nested group surface.",
          ),
        },
        {
          files: [
            {
              path: "src/commit-planning/grouping/group/message-harmonization.ts",
            },
            {
              path: "src/commit-planning/grouping/group/adjacent/absorption.ts",
            },
          ],
          message: commitMessage(
            "fix(commit-planning): centralize prompt rules and honor breaking mode",
            "- Keep message harmonization and adjacent absorption boundaries on the nested group surface.",
          ),
        },
        {
          files: [
            { path: "src/commit-messages/breaking-change-footers.ts" },
            { path: "src/commit-messages/subject-parser.ts" },
          ],
          message: commitMessage(
            "fix(commit-planning): centralize prompt rules and honor breaking mode",
            "- Keep breaking metadata parsing aligned with the same broad planning umbrella.",
          ),
        },
      ];
      const allFiles = groups.flatMap((group) =>
        group.files.map((file) => makeFile(file.path)),
      );

      const result = repartitionByIntent(
        groups,
        fileMap(allFiles),
        buildFileChangeSignals(allFiles),
        () => false,
      );

      expect(result).toHaveLength(4);
      expect(subjects(result)).toEqual([
        "fix(commit-planning): centralize prompt rules and honor breaking mode",
        "fix(commit-planning): centralize prompt rules and honor breaking mode",
        "fix(commit-planning): centralize prompt rules and honor breaking mode",
        "fix(commit-planning): centralize prompt rules and honor breaking mode",
      ]);
      expect(result.map((group) => group.files)).toEqual([
        [
          { path: "src/commit-planning/result-cache.ts" },
          { path: "src/commit-planning/token-estimation.ts" },
          { path: "src/commit-planning/response-validation.ts" },
          { path: "src/commit-planning/estimation-planner.ts" },
        ],
        [
          { path: "src/commit-planning/grouping/group/events.ts" },
          { path: "src/commit-planning/grouping/group/group-stability.ts" },
        ],
        [
          {
            path: "src/commit-planning/grouping/group/message-harmonization.ts",
          },
          { path: "src/commit-planning/grouping/group/adjacent/absorption.ts" },
        ],
        [
          { path: "src/commit-messages/breaking-change-footers.ts" },
          { path: "src/commit-messages/subject-parser.ts" },
        ],
      ]);

      const plannerEvents = parsePlannerDecisionEvents(events);
      const repartitionEvent = plannerEvents.find(
        (event) => event.decision === "repartition-by-intent",
      );

      expect(repartitionEvent).toMatchObject({
        componentCount: 4,
        decision: "repartition-by-intent",
        diagnostics: {
          largeImplementationOwnerSplitEligible: true,
          refinedComponentCount: 4,
          supportBearingOwnerSplitEligible: false,
        },
        outputGroupCount: 4,
      });
      expect(repartitionEvent?.resolution).toMatch(
        /^(multi-component-repartition|owner-scoped-implementation-components)$/u,
      );
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("splits a deep grouping umbrella by nested child surfaces instead of preserving one internal rollout", () => {
    const events: { content: string; kind?: string; stage: string }[] = [];
    setAiOutputObserver((event: (typeof events)[number]) => {
      events.push(event);
    });

    try {
      const sourceGroups: PlannedCommit[] = [
        {
          files: [
            { path: "src/commit-planning/grouping/baseline-restoration.ts" },
          ],
          message: commitMessage(
            "feat(grouping): restore covered baseline groups after weak consolidation",
            "- Keep baseline restoration on the root grouping surface.",
          ),
        },
        {
          files: [
            { path: "src/commit-planning/grouping/group/finalization.ts" },
            {
              path: "src/commit-planning/grouping/group/message-harmonization.ts",
            },
          ],
          message: commitMessage(
            "feat(grouping-group): stabilize finalization and covered message repair",
            "- Keep finalization and message harmonization on the nested group surface.",
          ),
        },
        {
          files: [
            {
              path: "src/commit-planning/grouping/group/adjacent/absorption.ts",
            },
            { path: "src/commit-planning/grouping/group/adjacent/index.ts" },
            {
              path: "src/commit-planning/grouping/group/adjacent/support-merge/eligibility.ts",
            },
          ],
          message: commitMessage(
            "feat(grouping-adjacent): split incidental follow-ups by shared adjacent surface",
            "- Keep adjacent absorption and support-merge eligibility on the adjacent child surface.",
          ),
        },
      ];
      const umbrellaGroup: PlannedCommit = {
        files: sourceGroups.flatMap((group) => group.files),
        message: commitMessage(
          "feat(grouping): split broad test support groups by attachable owner",
          "- Fold baseline restoration, finalization, and adjacent absorption under one broad grouping rollout.",
        ),
      };
      const allFiles = umbrellaGroup.files.map((file) => makeFile(file.path));

      const result = normalizeMixedRootImplementationGroups(
        [umbrellaGroup],
        sourceGroups,
        fileMap(allFiles),
      );

      expect(result.map((group: PlannedCommit) => group.files)).toEqual(
        sourceGroups.map((group) => group.files),
      );
      expect(result).toHaveLength(sourceGroups.length);
      expect(result[0]?.message.split("\n", 1)[0]).not.toBe(
        umbrellaGroup.message.split("\n", 1)[0],
      );
      expect(subjects(result).slice(1)).toEqual(
        subjects(sourceGroups).slice(1),
      );

      const plannerEvents = parsePlannerDecisionEvents(events);
      const structuralOwnerEvent = plannerEvents.find(
        (event) => event.decision === "structural-owner-split",
      );
      const rolloutEvent = plannerEvents.find(
        (event) => event.decision === "feature-surface-rollout",
      );
      const normalizationEvent = plannerEvents.find(
        (event) => event.decision === "normalization-split",
      );

      expect(structuralOwnerEvent).toMatchObject({
        decision: "structural-owner-split",
        diagnostics: {
          fileCount: umbrellaGroup.files.length,
          refinedStructuralOwnerBucketCount: sourceGroups.length,
        },
        reason: "split-nested-surface-owner",
        resolution: "split-group",
      });
      expect(rolloutEvent).toMatchObject({
        decision: "feature-surface-rollout",
        diagnostics: {
          fileCount: umbrellaGroup.files.length,
          hasSingleRolloutReason: true,
        },
        resolution: "split-rollout",
      });
      expect(normalizationEvent).toMatchObject({
        decision: "normalization-split",
        normalizationKind: "mixed-root-implementation",
        outputGroups: expect.any(Array),
      });
    } finally {
      setAiOutputObserver(null);
    }
  });

  test("restores baselines for a deep-nested commit-planning umbrella whose covered groups include test files", () => {
    // Regression: isDeepNestedInternalUmbrella was including test file paths
    // in the featureRoot check, which produced multiple feature-roots (e.g.
    // "src/commit-planning" and "tests/path-structure.test.ts"), causing the
    // function to return false and allowing the 97-file mega-merge to survive.
    // Test files that are co-located with implementation files inside baseline
    // groups must not disrupt the single-feature-root guard.
    const baselineGroups: PlannedCommit[] = [
      {
        files: [
          { path: "src/commit-planning/grouping/repartition.ts" },
          {
            path: "src/commit-planning/grouping/weak-consolidation-preservation.ts",
          },
        ],
        message: commitMessage(
          "fix(grouping): preserve intentful rollout splits from over-consolidation",
          "- Keep repartition and weak-consolidation preservation on the grouping surface.",
        ),
      },
      {
        files: [
          { path: "src/commit-planning/grouping/group/finalization.ts" },
          { path: "src/commit-planning/grouping/group/normalization.ts" },
          { path: "src/commit-planning/grouping/group/events.ts" },
        ],
        message: commitMessage(
          "feat(grouping-group): add covered-group message harmonization and events",
          "- Keep finalization, normalization, and event emission on the nested group surface.",
        ),
      },
      {
        files: [
          {
            path: "src/commit-planning/grouping/subject/premerge/pair-evaluation.ts",
          },
          { path: "src/commit-planning/grouping/subject/premerge/service.ts" },
          {
            path: "src/commit-planning/grouping/subject/premerge/structural-signals.ts",
          },
          {
            path: "src/commit-planning/grouping/subject/premerge/style-signals.ts",
          },
        ],
        message: commitMessage(
          "feat(subject-premerge): add deterministic pair-level premerge logic",
          "- Keep premerge pair evaluation, structural signals, and style rules together.",
        ),
      },
      {
        // Mixed group: implementation files plus attached test files.
        // The test paths have distinct featureRoots like "tests/path-structure.test.ts"
        // that differ from "src/commit-planning" — the filter must exclude them.
        files: [
          { path: "src/commit-planning/path/aliases.ts" },
          { path: "src/commit-planning/path/index.ts" },
          { path: "src/commit-planning/path/repository-structure.ts" },
          { path: "src/commit-planning/path/resolver.ts" },
          { path: "src/commit-planning/path/structure.ts" },
          { path: "tests/path-structure.test.ts" },
        ],
        message: commitMessage(
          "feat(path): expand structural planner path resolution",
          "- Keep alias expansion and repository-structure discovery on the path surface.",
        ),
      },
      {
        // Another mixed group: plan-bundle implementation plus a test file.
        files: [
          { path: "src/commit-planning/plan-bundles/hashes.ts" },
          { path: "src/commit-planning/plan-bundles/index.ts" },
          { path: "src/commit-planning/plan-bundles/resume/index.ts" },
          { path: "src/commit-planning/plan-bundles/resume/validation.ts" },
          { path: "src/commit-planning/plan-bundles/schemas.ts" },
          { path: "src/commit-planning/plan-bundles/service.ts" },
          { path: "src/commit-planning/plan-bundles/storage.ts" },
          { path: "tests/plan-bundles.test.ts" },
        ],
        message: commitMessage(
          "feat(plan-bundles): add persisted bundle integrity and resume safeguards",
          "- Keep hashing, storage, and resume validation on the plan-bundles surface.",
        ),
      },
    ];
    const allFiles = baselineGroups.flatMap((group) =>
      group.files.map((file) => makeFile(file.path)),
    );

    expectConsolidationSplitToRestoreBaseline({
      allFiles,
      baselineGroups,
      umbrellaMessage: commitMessage(
        "feat(commit-planning): add modular path resolution, plan bundles, and premerge logic",
        "- Fold grouping fixes, premerge rules, path utilities, and plan bundle persistence into one umbrella feature.",
      ),
    });
  });

  test("premerges a single-file implementation-path style shard into the implementation rollout that owns the same directory", () => {
    // Regression: isSharedSupportStyleFollowUp only handled support-path
    // (test) style shards.  A trailing-newline fix on an implementation file
    // (e.g. src/cli/token/confirmation.ts) was kept as a standalone
    // style(token) commit even when a neighboring refactor(cli) commit already
    // covered other files in the same src/cli/token/ directory.
    const allFiles = [
      makeFile("src/cli/token/confirmation.ts"),
      makeFile("src/cli/token/index.ts"),
      makeFile("src/cli/token/splitting.ts"),
    ];
    const groups: PlannedCommit[] = [
      {
        files: [
          { path: "src/cli/token/index.ts" },
          { path: "src/cli/token/splitting.ts" },
        ],
        message: commitMessage(
          "refactor(cli): tighten token module exports and normalize helpers",
          "- Replace wildcard token barrel with explicit public symbols.",
          "- Align token splitter import paths with the tightened barrel.",
        ),
      },
      {
        files: [{ path: "src/cli/token/confirmation.ts" }],
        message: commitMessage(
          "style(token): add missing trailing newline",
          "- Normalize file termination without changing runtime behavior.",
        ),
      },
    ];

    const result = premergeBySubject(groups, fileMap(allFiles));

    expect(result).toHaveLength(1);
    expect(result[0]?.message.split("\n", 1)[0]).toBe(
      "refactor(cli): tighten token module exports and normalize helpers",
    );
    expect(result[0]?.files.map((f) => f.path).sort()).toEqual([
      "src/cli/token/confirmation.ts",
      "src/cli/token/index.ts",
      "src/cli/token/splitting.ts",
    ]);
  });

  test("keeps a single-file implementation-path style shard separate when no owner covers the same directory", () => {
    // The same-directory rule must only fire when there IS an implementation
    // commit in the same directory — not when the style shard stands alone.
    const allFiles = [
      makeFile("src/cli/token/confirmation.ts"),
      makeFile("src/commit-planning/grouping/repartition.ts"),
    ];
    const groups: PlannedCommit[] = [
      {
        files: [{ path: "src/commit-planning/grouping/repartition.ts" }],
        message: commitMessage(
          "fix(grouping): tighten weak-consolidation split thresholds",
          "- Keep repartition boundary fixes on the grouping surface.",
        ),
      },
      {
        files: [{ path: "src/cli/token/confirmation.ts" }],
        message: commitMessage(
          "style(token): add missing trailing newline",
          "- Normalize file termination without changing runtime behavior.",
        ),
      },
    ];

    expect(premergeBySubject(groups, fileMap(allFiles))).toEqual(groups);
  });
});
