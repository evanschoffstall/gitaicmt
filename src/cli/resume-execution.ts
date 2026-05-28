import type {
  PersistedPlanBundle,
  PlannedCommitFile,
} from "../commit-planning/index.js";
import type { ResumeSelection } from "./options.js";

import { ValidationError } from "../application/errors.js";
import {
  filterValidPlanCommitsForResume,
  preparePlanBundleForResume,
} from "../commit-planning/index.js";
import { formatCount } from "./counts.js";
import { log } from "./session-display.js";

const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";

export interface ResumeExecutionPlan {
  invalidCommits: {
    index: number;
    message: string;
    mismatch: string;
  }[];
  validPlan: { files: PlannedCommitFile[]; message: string }[];
}

export function buildResumeStatusRows(input: {
  createdAt: string;
  fileCount: number;
  forceHashCheck: boolean;
  hash: string;
  resumeSelection: ResumeSelection;
  totalCommits: number;
  validOnly: boolean;
}): { label: string; value: string }[] {
  const statusRows = [
    { label: "bundle", value: input.hash.slice(0, 12) },
    {
      label: "files",
      value: `${formatCount(input.fileCount)} changed file(s)`,
    },
    {
      label: "hash-check",
      value: resolveResumeHashCheckLabel(input.forceHashCheck, input.validOnly),
    },
    { label: "saved", value: input.createdAt },
  ];
  const selectionLabel = formatResumeSelectionLabel(
    input.resumeSelection,
    input.totalCommits,
  );
  if (selectionLabel !== null) {
    statusRows.splice(1, 0, { label: "selection", value: selectionLabel });
  }
  return statusRows;
}

export function logResumeHashCheckMessages(
  forceHashCheck: boolean,
  invalidCommits: ResumeExecutionPlan["invalidCommits"],
  validOnly: boolean,
): void {
  if (forceHashCheck) {
    log(
      `${YELLOW}Warning: --force bypasses staged hash validation. Use only as a last resort because non-identical staged content may replay differently.${RESET}`,
    );
    log(
      `${YELLOW}Warning: repository state outside the staged patch (attributes, filters, sparse checkout, hooks, submodules) can still affect patch replay.${RESET}`,
    );
    log("");
    return;
  }

  if (invalidCommits.length > 0) {
    log(
      `${YELLOW}Skipping ${formatCount(invalidCommits.length)} commit(s) whose saved file or hunk hashes no longer match the current staged patch${validOnly ? "" : " for this resume pass"}.${RESET}`,
    );
    for (const invalidCommit of invalidCommits) {
      const subject =
        invalidCommit.message.split("\n")[0] ?? invalidCommit.message;
      log(
        `${YELLOW}  #${String(invalidCommit.index)} ${subject}: ${invalidCommit.mismatch}${RESET}`,
      );
    }
    log("");
  }
}

export function resolveResumeExecutionPlan(
  bundle: PersistedPlanBundle,
  forceHashCheck: boolean,
  resumeSelection: ResumeSelection,
  _validOnly: boolean,
): ResumeExecutionPlan {
  const selectedIndexes = selectResumeIndexes(
    bundle.plan.length,
    resumeSelection,
  );
  void forceHashCheck;
  preparePlanBundleForResume(bundle, selectedIndexes);
  return filterValidPlanCommitsForResume(bundle, selectedIndexes);
}

function assertResumeIndex(
  index: number,
  totalCommits: number,
  flagName: "--from" | "--only" | "--range",
): void {
  if (index < 1 || index > totalCommits) {
    throw new ValidationError(
      `${flagName} index ${String(index)} is outside the saved bundle range 1-${String(totalCommits)}.`,
    );
  }
}

function formatResumeSelectionLabel(
  resumeSelection: ResumeSelection,
  totalCommits: number,
): null | string {
  switch (resumeSelection.kind) {
    case "all":
      return null;
    case "from":
      return `${String(resumeSelection.startIndex)}-${String(totalCommits)} of ${String(totalCommits)}`;
    case "only":
      return `${resumeSelection.indices.map(String).join(",")} of ${String(totalCommits)}`;
    case "range":
      return `${String(resumeSelection.startIndex)}-${String(resumeSelection.endIndex)} of ${String(totalCommits)}`;
  }
}

function resolveResumeHashCheckLabel(
  forceHashCheck: boolean,
  validOnly: boolean,
): string {
  if (forceHashCheck) {
    return "force override";
  }
  if (validOnly) {
    return "valid-only";
  }
  return "strict";
}

function selectResumeIndexes(
  totalCommits: number,
  resumeSelection: ResumeSelection,
): number[] {
  switch (resumeSelection.kind) {
    case "all":
      return Array.from({ length: totalCommits }, (_, index) => index + 1);
    case "from":
      assertResumeIndex(resumeSelection.startIndex, totalCommits, "--from");
      return Array.from(
        { length: totalCommits - resumeSelection.startIndex + 1 },
        (_, index) => resumeSelection.startIndex + index,
      );
    case "only":
      return resumeSelection.indices.map((index) => {
        assertResumeIndex(index, totalCommits, "--only");
        return index;
      });
    case "range":
      assertResumeIndex(resumeSelection.startIndex, totalCommits, "--range");
      assertResumeIndex(resumeSelection.endIndex, totalCommits, "--range");
      return Array.from(
        {
          length: resumeSelection.endIndex - resumeSelection.startIndex + 1,
        },
        (_, index) => resumeSelection.startIndex + index,
      );
  }
}
