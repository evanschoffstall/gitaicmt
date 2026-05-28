import { describe, expect, test } from "bun:test";

import { groupsShareTopLevelArea } from "../src/commit-planning/grouping/group/ownership-boundaries.js";
import {
  getPathOwnerDescriptor,
  inferSupportScopeFromPath,
} from "../src/commit-planning/grouping/ownership.js";
import { splitMultiAreaStyleGroup } from "../src/commit-planning/grouping/style-splitting/area-splitting.js";
import {
  getProjectPathAliases,
  getTopLevelAreaName,
  getVirtualPathAliases,
  isSupportLikePath,
} from "../src/commit-planning/path/index.js";

describe("dynamic path structure helpers", () => {
  test("getProjectPathAliases resolves absolute aliases for any repo-relative path", () => {
    const aliases = getProjectPathAliases("commit-messages/index.ts");

    expect(aliases).toContain("commit-messages/index.ts");
    expect(aliases).toContain(
      `${process.cwd().replace(/\\/gu, "/")}/commit-messages/index.ts`,
    );
  });

  test("getTopLevelAreaName collapses broad container roots to their owned feature", () => {
    expect(getTopLevelAreaName("src/git/operations.ts")).toBe("git");
    expect(getTopLevelAreaName("commit-messages/index.ts")).toBe(
      "commit-messages",
    );
  });

  test("getVirtualPathAliases keeps the first subtree segment when dropping deeper directories", () => {
    expect(
      getVirtualPathAliases("src/commit-planning/prompts/rules/formatting.ts"),
    ).toContain("src/commit-planning/prompts/formatting.ts");
  });

  test("getPathOwnerDescriptor keeps nested source ownership structural without literal root checks", () => {
    expect(
      getPathOwnerDescriptor("src/commit-planning/path/aliases.ts"),
    ).toEqual({
      featureRoot: "src/commit-planning",
      kind: "nested-subtree",
      ownerId: "src/commit-planning/path",
    });
  });

  test("splitMultiAreaStyleGroup splits source sweeps by structural area instead of a hardcoded source root", () => {
    const result = splitMultiAreaStyleGroup({
      files: [
        { path: "src/git/operations.ts" },
        { path: "src/git/output-sanitization.ts" },
        { path: "src/cli/options.ts" },
        { path: "src/cli/output-presentation.ts" },
        { path: "src/cli/viewport.ts" },
        { path: "src/cli/main.ts" },
      ],
      message: "style(all): normalize formatting",
    });

    expect(result?.map((group) => group.message.split(":")[0])).toEqual([
      "style(git)",
      "style(cli)",
    ]);
  });

  test("inferSupportScopeFromPath derives support scopes from meaningful structural words instead of a fallback literal", () => {
    expect(
      inferSupportScopeFromPath("tests/terminal-ui/viewport.test.ts"),
    ).toBe("viewport");
    expect(inferSupportScopeFromPath("tests/cli/__tests__/index.test.ts")).toBe(
      "cli",
    );
  });

  test("groupsShareTopLevelArea compares structural areas instead of the first raw path segment", () => {
    expect(
      groupsShareTopLevelArea(
        {
          files: [{ path: "src/git/operations.ts" }],
          message: "feat(git): update operations",
        },
        {
          files: [{ path: "src/cli/main.ts" }],
          message: "feat(cli): update main",
        },
      ),
    ).toBe(false);

    expect(
      groupsShareTopLevelArea(
        {
          files: [{ path: "src/git/operations.ts" }],
          message: "feat(git): update operations",
        },
        {
          files: [{ path: "src/git/output-sanitization.ts" }],
          message: "feat(git): update output",
        },
      ),
    ).toBe(true);
  });

  test("isSupportLikePath infers support-only roots from the working tree", () => {
    expect(isSupportLikePath("tests/tsconfig.json")).toBe(true);
    expect(isSupportLikePath("src/cli/main.ts")).toBe(false);
  });
});
