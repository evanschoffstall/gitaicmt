import {
  normalizeConventionalScope,
  normalizeConventionalSubjectScope,
} from "../../../commit-messages/subject-parser.js";
import { isSupportLikePath } from "../../path/index.js";
import {
  type FileChangeSignals,
  type PlannedCommit,
} from "../grouping-types.js";
import { chooseSupportAttachment } from "../merge-heuristics.js";
import {
  inferSplitSupportScopeFromPath,
  inferSupportScopeFromPath,
} from "../ownership.js";
import { parseSubjectWords } from "../subject/analysis.js";

type SupportAttachmentPlan =
  | { kind: "append-direct"; target: number }
  | { kind: "append-original-to-split-target"; split: SupportSplitPlan }
  | { kind: "append-standalone" }
  | { kind: "append-trailing-standalone"; split: SupportSplitPlan }
  | { kind: "materialize-split"; split: SupportSplitPlan };

interface SupportSplitPlan {
  allFilesAttach: boolean;
  attachableTargetCount: number;
  firstTarget: number | undefined;
  splitTargets: number[];
  start: number;
  uniqueTargets: Set<number>;
}

/** Attaches support indexes to the best implementation component when the signal is decisive. */
export function attachSupportIndexes(
  groups: PlannedCommit[],
  supportIndexes: number[],
  components: number[][],
  fileSignals: Map<string, FileChangeSignals>,
): void {
  const attachmentComponentCount = components.length;

  for (const supportIndex of supportIndexes) {
    attachSingleSupportGroup(
      groups,
      supportIndex,
      components,
      fileSignals,
      attachmentComponentCount,
    );
  }
}

/** Builds a focused per-file support subject when a broad support group must split across owners. */
export function buildSplitSupportMessage(
  group: PlannedCommit,
  filePath: string,
): string {
  const [subjectLine, ...bodyLines] = group.message.split("\n");
  const subject = parseSubjectWords(subjectLine);
  const scope =
    normalizeConventionalScope(
      inferSplitSupportScopeFromPath(filePath) ||
        inferSupportScopeFromPath(filePath) ||
        subject.scope ||
        "support",
    ) || "support";
  const description = extractSubjectDescription(subjectLine);
  const body = bodyLines.join("\n").trim();
  const subjectText = `test(${scope}): ${description || "cover related behavior"}`;

  return normalizeConventionalSubjectScope(
    body.length > 0 ? `${subjectText}\n\n${body}` : subjectText,
  );
}

/** Only broad multi-file test support groups are eligible for per-file redistribution. */
export function shouldSplitSupportGroupForAttachment(
  group: PlannedCommit,
): boolean {
  const subject = parseSubjectWords(group.message.split("\n")[0] ?? "");
  return (
    subject.type === "test" &&
    group.files.length > 1 &&
    group.files.every((file) => isSupportLikePath(file.path))
  );
}

function appendDirectSupportAttachment(
  components: number[][],
  supportIndex: number,
  directAttachment: number,
): void {
  if (directAttachment === -1) {
    components.push([supportIndex]);
    return;
  }

  components[directAttachment].push(supportIndex);
}

function appendTrailingStandaloneComponents(
  components: number[][],
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index++) {
    components.push([index]);
  }
}

function attachOriginalSupportGroupToSplitTarget(
  groups: PlannedCommit[],
  supportIndex: number,
  components: number[][],
  split: SupportSplitPlan,
): void {
  const target = split.firstTarget;
  if (target === undefined) {
    appendTrailingStandaloneComponents(components, split.start, groups.length);
    return;
  }

  groups.splice(split.start);
  components[target].push(supportIndex);
}

function attachSingleSupportGroup(
  groups: PlannedCommit[],
  supportIndex: number,
  components: number[][],
  fileSignals: Map<string, FileChangeSignals>,
  attachmentComponentCount: number,
): void {
  const attachmentComponents = components.slice(0, attachmentComponentCount);
  const supportGroup = groups[supportIndex];
  const directAttachment = chooseSupportAttachment(
    supportGroup,
    groups,
    attachmentComponents,
    fileSignals,
  );

  const split = shouldSplitSupportGroupForAttachment(supportGroup)
    ? buildPerFileSplits(
        groups,
        supportGroup,
        attachmentComponents,
        fileSignals,
      )
    : null;

  const plan = resolveSupportAttachmentPlan(
    supportGroup,
    directAttachment,
    split,
    components.length,
  );

  if (plan.kind === "append-direct") {
    appendDirectSupportAttachment(components, supportIndex, plan.target);
    return;
  }

  if (plan.kind === "append-standalone") {
    components.push([supportIndex]);
    return;
  }

  if (plan.kind === "materialize-split") {
    materializeSplitAttachments(components, plan.split);
    return;
  }

  if (plan.kind === "append-original-to-split-target") {
    attachOriginalSupportGroupToSplitTarget(
      groups,
      supportIndex,
      components,
      plan.split,
    );
    return;
  }

  appendTrailingStandaloneComponents(
    components,
    plan.split.start,
    groups.length,
  );
}

function buildPerFileSplits(
  groups: PlannedCommit[],
  supportGroup: PlannedCommit,
  components: number[][],
  fileSignals: Map<string, FileChangeSignals>,
): SupportSplitPlan {
  const start = groups.length;
  for (const file of supportGroup.files) {
    groups.push({
      files: [file],
      message: buildSplitSupportMessage(supportGroup, file.path),
    });
  }

  const splitTargets = groups
    .slice(start)
    .map((_, offset) =>
      chooseSupportAttachment(
        groups[start + offset],
        groups,
        components,
        fileSignals,
      ),
    );
  const attachableTargets = splitTargets.filter((target) => target !== -1);

  return {
    allFilesAttach: attachableTargets.length === splitTargets.length,
    attachableTargetCount: attachableTargets.length,
    firstTarget: attachableTargets[0],
    splitTargets,
    start,
    uniqueTargets: new Set(attachableTargets),
  };
}

function extractSubjectDescription(subjectLine: string): string {
  const colonIndex = subjectLine.indexOf(":");
  return colonIndex >= 0 ? subjectLine.slice(colonIndex + 1).trim() : "";
}

function hasSharedStandaloneSupportSubtree(group: PlannedCommit): boolean {
  if (group.files.length < 2) {
    return false;
  }

  const directorySegments = group.files.map((file) =>
    file.path.split("/").slice(0, -1),
  );
  const minimumDepth = Math.min(
    ...directorySegments.map((parts) => parts.length),
  );
  let sharedDepth = 0;

  for (let depth = 0; depth < minimumDepth; depth++) {
    const segment = directorySegments[0][depth];
    if (directorySegments.some((parts) => parts[depth] !== segment)) {
      break;
    }
    sharedDepth++;
  }

  return sharedDepth >= 2;
}

function materializeSplitAttachments(
  components: number[][],
  split: Pick<SupportSplitPlan, "splitTargets" | "start">,
): void {
  split.splitTargets.forEach((target, offset) => {
    const splitGroupIndex = split.start + offset;
    if (target === -1) {
      components.push([splitGroupIndex]);
      return;
    }

    components[target].push(splitGroupIndex);
  });
}

function resolveNoAttachableSplitPlan(
  supportGroup: PlannedCommit,
  directAttachment: number,
  split: SupportSplitPlan,
): SupportAttachmentPlan {
  if (directAttachment !== -1) {
    return { kind: "append-direct", target: directAttachment };
  }

  if (hasSharedStandaloneSupportSubtree(supportGroup)) {
    return { kind: "append-standalone" };
  }

  return { kind: "materialize-split", split };
}

function resolveSupportAttachmentPlan(
  supportGroup: PlannedCommit,
  directAttachment: number,
  split: null | SupportSplitPlan,
  componentCount: number,
): SupportAttachmentPlan {
  if (split === null) {
    return directAttachment !== -1
      ? { kind: "append-direct", target: directAttachment }
      : { kind: "append-standalone" };
  }

  if (split.uniqueTargets.size > 1) {
    return { kind: "append-trailing-standalone", split };
  }

  if (split.attachableTargetCount === 0) {
    return resolveNoAttachableSplitPlan(supportGroup, directAttachment, split);
  }

  if (!split.allFilesAttach) {
    return { kind: "materialize-split", split };
  }

  if (directAttachment !== -1) {
    return { kind: "append-direct", target: directAttachment };
  }

  if (componentCount <= 1) {
    return { kind: "append-standalone" };
  }

  return { kind: "append-original-to-split-target", split };
}
