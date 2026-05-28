import { isSupportLikePath } from "../../path/index.js";
import {
  type FileChangeSignals,
  type PlannedCommit,
} from "../grouping-types.js";
import { getPathOwnerDescriptor } from "../ownership.js";
import {
  countSharedSubjectWords,
  isSupportLikeType,
  parseSubjectWords,
} from "../subject/analysis.js";
import {
  getSupportAttachmentBreadthPenalty,
  getSupportAttachmentScore,
  type SupportAttachmentEvaluation,
} from "./scoring.js";
import { hasSingleOwnerAttachmentAnchor } from "./single-owner-anchor.js";

/** Attach a support-only group to the most specific implementation component when the signal is decisive. */
export function chooseSupportAttachment(
  supportGroup: PlannedCommit,
  groups: PlannedCommit[],
  components: number[][],
  fileSignals: Map<string, FileChangeSignals>,
): number {
  const bestAttachment = findBestSupportAttachment(
    supportGroup,
    groups,
    components,
    fileSignals,
  );

  if (
    !isDecisiveSupportAttachment(
      bestAttachment,
      supportGroup,
      groups,
      components,
    )
  ) {
    return -1;
  }

  return bestAttachment.bestComponentIndex;
}

function findBestSupportAttachment(
  supportGroup: PlannedCommit,
  groups: PlannedCommit[],
  components: number[][],
  fileSignals: Map<string, FileChangeSignals>,
): {
  bestComponentIndex: number;
  bestScore: number;
  bestSignals: null | SupportAttachmentEvaluation["signals"];
  secondBestScore: number;
} {
  let bestComponentIndex = -1;
  let bestSignals: null | SupportAttachmentEvaluation["signals"] = null;
  let bestScore = 0;
  let secondBestScore = 0;

  for (
    let componentIndex = 0;
    componentIndex < components.length;
    componentIndex++
  ) {
    const componentScore = getComponentSupportAttachmentScore(
      supportGroup,
      components[componentIndex],
      groups,
      fileSignals,
    );

    if (componentScore.score > bestScore) {
      secondBestScore = bestScore;
      bestScore = componentScore.score;
      bestComponentIndex = componentIndex;
      bestSignals = componentScore.signals;
      continue;
    }

    if (componentScore.score > secondBestScore) {
      secondBestScore = componentScore.score;
    }
  }

  return { bestComponentIndex, bestScore, bestSignals, secondBestScore };
}

function getComponentSupportAttachmentScore(
  supportGroup: PlannedCommit,
  component: number[],
  groups: PlannedCommit[],
  fileSignals: Map<string, FileChangeSignals>,
): { score: number; signals: null | SupportAttachmentEvaluation["signals"] } {
  let score = 0;
  let signals: null | SupportAttachmentEvaluation["signals"] = null;

  for (const index of component) {
    const targetSubject = parseSubjectWords(
      groups[index].message.split("\n")[0] ?? "",
    );
    if (
      isSupportLikeType(targetSubject.type) &&
      !shouldEvaluateSupportTarget(supportGroup, groups[index], targetSubject)
    ) {
      continue;
    }

    const evaluation = getSupportAttachmentScore(
      supportGroup,
      groups[index],
      fileSignals,
    );

    if (evaluation.score > score) {
      score = evaluation.score;
      signals = evaluation.signals;
    }
  }

  return {
    score:
      score -
      getSupportAttachmentBreadthPenalty(
        supportGroup,
        component,
        groups,
        fileSignals,
      ),
    signals,
  };
}

function hasUnambiguousSingleOwnerLexicalAttachment(
  supportGroup: PlannedCommit,
  groups: PlannedCommit[],
  signals: SupportAttachmentEvaluation["signals"],
): boolean {
  if (
    signals.supportSubject.type === "test" ||
    signals.isBroadSupportGroup ||
    signals.hasCoverageSignal ||
    signals.hasDependencySignal ||
    signals.hasExactScopeSignal ||
    signals.hasScopeSignal ||
    signals.sharedPathScore > 0 ||
    signals.sharedSubjectWordCount < 3
  ) {
    return false;
  }

  const supportSubject = parseSubjectWords(
    supportGroup.message.split("\n")[0] ?? "",
  );

  return !groups.some((group) => {
    if (group === supportGroup) {
      return false;
    }

    const siblingSubject = parseSubjectWords(
      group.message.split("\n")[0] ?? "",
    );
    if (
      !isSupportLikeType(siblingSubject.type) ||
      siblingSubject.type !== supportSubject.type
    ) {
      return false;
    }

    return (
      countSharedSubjectWords(supportSubject.words, siblingSubject.words) >=
      signals.sharedSubjectWordCount
    );
  });
}

function isDecisiveSupportAttachment(
  attachment: {
    bestComponentIndex: number;
    bestScore: number;
    bestSignals: null | SupportAttachmentEvaluation["signals"];
    secondBestScore: number;
  },
  supportGroup: PlannedCommit,
  groups: PlannedCommit[],
  components: number[][],
): boolean {
  if (lacksDecisiveAttachmentMargin(attachment)) {
    return false;
  }

  const signals = attachment.bestSignals;
  if (signals === null) {
    return false;
  }

  if (
    rejectsSingleOwnerBroadTestAttachment(
      components.length,
      supportGroup,
      signals,
    )
  ) {
    return false;
  }

  if (
    rejectsMixedSurfaceTestAttachment(
      components[attachment.bestComponentIndex] ?? [],
      groups,
      signals,
    )
  ) {
    return false;
  }

  if (lacksMultiFileTestAnchor(supportGroup, signals)) {
    return false;
  }

  return (
    components.length > 1 ||
    hasSingleOwnerAttachmentAnchor(signals) ||
    hasUnambiguousSingleOwnerLexicalAttachment(supportGroup, groups, signals)
  );
}

function lacksDecisiveAttachmentMargin(attachment: {
  bestComponentIndex: number;
  bestScore: number;
  bestSignals: null | SupportAttachmentEvaluation["signals"];
  secondBestScore: number;
}): boolean {
  return (
    attachment.bestSignals === null ||
    attachment.bestScore < 3 ||
    attachment.bestScore - attachment.secondBestScore <= 1
  );
}

function lacksMultiFileTestAnchor(
  supportGroup: PlannedCommit,
  signals: SupportAttachmentEvaluation["signals"],
): boolean {
  return (
    signals.supportSubject.type === "test" &&
    supportGroup.files.length > 1 &&
    !signals.hasCoverageSignal &&
    !signals.sharedPaths &&
    (!signals.hasScopeSignal || signals.sharedSubjectWordCount === 0)
  );
}

function rejectsMixedSurfaceTestAttachment(
  component: number[],
  groups: PlannedCommit[],
  signals: SupportAttachmentEvaluation["signals"],
): boolean {
  if (
    signals.supportSubject.type !== "test" ||
    signals.hasCoverageSignal ||
    signals.sharedPaths ||
    signals.hasExactScopeSignal
  ) {
    return false;
  }

  const distinctFeatureRoots = new Set(
    component.flatMap((index) =>
      groups[index].files
        .filter((file) => !isSupportLikePath(file.path))
        .map((file) => getPathOwnerDescriptor(file.path).featureRoot),
    ),
  );

  return distinctFeatureRoots.size > 1;
}

function rejectsSingleOwnerBroadTestAttachment(
  componentCount: number,
  supportGroup: PlannedCommit,
  signals: SupportAttachmentEvaluation["signals"],
): boolean {
  return (
    componentCount === 1 &&
    signals.supportSubject.type === "test" &&
    supportGroup.files.length > 1 &&
    !signals.hasCoverageSignal &&
    !signals.hasDependencySignal &&
    signals.sharedPathScore === 0
  );
}

function shouldEvaluateSupportTarget(
  supportGroup: PlannedCommit,
  targetGroup: PlannedCommit,
  targetSubject: ReturnType<typeof parseSubjectWords>,
): boolean {
  const supportSubject = parseSubjectWords(
    supportGroup.message.split("\n")[0] ?? "",
  );

  return (
    supportSubject.type === "test" &&
    targetSubject.type === "test" &&
    targetGroup.files.length > supportGroup.files.length
  );
}
