/** Public entrypoint for the submodule trace accumulation module. */

export {
  accumulateSubmoduleEntry,
  buildDecisionTitle,
  createSubmoduleAccumulator,
  extractSubmoduleEntry,
  formatSubmoduleReportLines,
} from "./report.js";

export type { SubmoduleAccumulator, SubmoduleReportEntry } from "./types.js";
