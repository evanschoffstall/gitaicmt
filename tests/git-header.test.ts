import { describe, expect, test } from "bun:test";

import {
  DIFF_DEV_NULL_PATH,
  DIFF_NEW_FILE_MARKER,
  DIFF_OLD_FILE_MARKER,
  encodeGitQuotedPath,
  normalizeDiffPath,
  parseFileHeader,
  parseUnifiedDiffPathLine,
} from "../src/git/header.js";

describe("git header helpers", () => {
  test("encodeGitQuotedPath leaves plain ascii paths unchanged", () => {
    expect(encodeGitQuotedPath("src/app.ts")).toBe("src/app.ts");
  });

  test("encodeGitQuotedPath escapes quotes, backslashes, and control bytes", () => {
    expect(encodeGitQuotedPath('src/"tab\t\\file.ts')).toBe(
      '"src/\\"tab\\t\\\\file.ts"',
    );
  });

  test("encodeGitQuotedPath octal-escapes non-printable utf8 bytes", () => {
    expect(encodeGitQuotedPath("src/na\u0001me.ts")).toBe(
      '"src/na\\001me.ts"',
    );
  });

  test("normalizeDiffPath decodes git-quoted escapes", () => {
    expect(normalizeDiffPath('"src/line\\nname\\t.ts"')).toBe(
      "src/line\nname\t.ts",
    );
  });

  test("parseFileHeader supports canonical prefixed paths", () => {
    expect(parseFileHeader("diff --git a/src/app.ts b/src/app.ts")).toEqual({
      newPath: "src/app.ts",
      oldPath: "src/app.ts",
    });
  });

  test("parseFileHeader supports reversed prefixed paths", () => {
    expect(parseFileHeader("diff --git b/src/new.ts a/src/old.ts")).toEqual({
      newPath: "src/new.ts",
      oldPath: "src/old.ts",
    });
  });

  test("parseFileHeader supports quoted paths with spaces", () => {
    expect(
      parseFileHeader('diff --git "a/src/old name.ts" "b/src/new name.ts"'),
    ).toEqual({
      newPath: "src/new name.ts",
      oldPath: "src/old name.ts",
    });
  });

  test("parseFileHeader falls back to simple unprefixed tokens", () => {
    expect(parseFileHeader("diff --git old.ts new.ts")).toEqual({
      newPath: "new.ts",
      oldPath: "old.ts",
    });
  });

  test("parseFileHeader rejects malformed headers", () => {
    expect(parseFileHeader("index 123..456 100644")).toBeNull();
    expect(parseFileHeader('diff --git "a/src/app.ts"')).toBeNull();
  });

  test("parseUnifiedDiffPathLine normalizes old, new, and dev-null markers", () => {
    expect(parseUnifiedDiffPathLine("--- a/src/app.ts", DIFF_OLD_FILE_MARKER)).toBe(
      "src/app.ts",
    );
    expect(parseUnifiedDiffPathLine("+++ b/src/app.ts", DIFF_NEW_FILE_MARKER)).toBe(
      "src/app.ts",
    );
    expect(
      parseUnifiedDiffPathLine(`--- ${DIFF_DEV_NULL_PATH}`, DIFF_OLD_FILE_MARKER),
    ).toBe(DIFF_DEV_NULL_PATH);
  });

  test("parseUnifiedDiffPathLine rejects wrong markers and empty paths", () => {
    expect(parseUnifiedDiffPathLine("@@ -1 +1 @@", DIFF_NEW_FILE_MARKER)).toBeNull();
    expect(parseUnifiedDiffPathLine("+++   ", DIFF_NEW_FILE_MARKER)).toBeNull();
  });
});