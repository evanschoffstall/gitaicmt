import { describe, expect, test } from "bun:test";

import * as application from "../src/application/index.js";
import * as cliCommit from "../src/cli/commit/index.js";
import * as cli from "../src/cli/index.js";
import * as cliTerminal from "../src/cli/terminal/index.js";
import * as cliToken from "../src/cli/token/index.js";
import * as cliVerboseRendering from "../src/cli/verbose-rendering/index.js";
import * as commitMessages from "../src/commit-messages/index.js";
import * as groupingGroup from "../src/commit-planning/grouping/group/index.js";
import * as groupingSubject from "../src/commit-planning/grouping/subject/index.js";
import * as commitPlanning from "../src/commit-planning/index.js";
import * as git from "../src/git/index.js";

describe("folder entrypoints", () => {
  test("application entrypoint exposes config and errors", () => {
    expect(typeof application.loadConfig).toBe("function");
    expect(typeof application.ConfigError).toBe("function");
  });

  test("cli entrypoints expose commit, terminal, token, and rendering helpers", () => {
    expect(typeof cliCommit.executePlannedCommits).toBe("function");
    expect(typeof cliTerminal.wrapTerminalTextBlock).toBe("function");
    expect(typeof cliToken.confirmTokenUsage).toBe("function");
    expect(typeof cliVerboseRendering.buildEventTitle).toBe("function");
    expect(typeof cli.resolveDisplayWidth).toBe("function");
  });

  test("commit message entrypoint exposes parsing and validation", () => {
    expect(typeof commitMessages.markCommitMessageBreaking).toBe("function");
    expect(typeof commitMessages.validateCommitMessage).toBe("function");
    expect(typeof commitMessages.parseConventionalSubject).toBe("function");
  });

  test("commit planning entrypoints expose planner helpers", () => {
    expect(typeof commitPlanning.planCommits).toBe("function");
    expect(typeof groupingGroup.finalizePlannedGroups).toBe("function");
    expect(typeof groupingSubject.parseSubjectWords).toBe("function");
  });

  test("git entrypoint exposes diff and operations helpers", () => {
    expect(typeof git.parseDiff).toBe("function");
    expect(typeof git.commitWithMessage).toBe("function");
  });
});