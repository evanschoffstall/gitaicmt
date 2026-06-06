import type { SubjectWords } from "../grouping-types.js";

/** Signals used to evaluate whether a support group should attach to an implementation group. */
export interface SupportAttachmentSignals {
  hasCoverageSignal: boolean;
  hasDependencySignal: boolean;
  hasExactDescriptionSignal: boolean;
  hasExactScopeSignal: boolean;
  hasHighWordOverlap: boolean;
  hasScopeSignal: boolean;
  isBroadSupportGroup: boolean;
  sharedIntentScore: number;
  sharedPaths: boolean;
  sharedPathScore: number;
  sharedSubjectWordCount: number;
  supportSubject: SubjectWords;
  targetFileCount: number;
  targetSubject: SubjectWords;
}
