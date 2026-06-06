/** Shared types for submodule trace accumulation and report rendering. */

export interface SubmoduleAccumulator {
  countSummary?: string;
  decision: string;
  entries: SubmoduleReportEntry[];
  metricSamples: Record<string, number[]>;
  noChangeCount: number;
  occurrenceCount: number;
  resolutionCounts: Record<string, number>;
  stage: string;
}

export interface SubmoduleReportEntry {
  after?: string;
  before: string;
  outcome: "attached" | "kept" | "merged" | "split" | "transformed";
  why?: string;
}
