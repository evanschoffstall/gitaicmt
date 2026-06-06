export {
  getFlattenedSubtreeOwnerId,
  getProjectPathAliases,
  getVirtualNestedPath,
  getVirtualPathAliases,
} from "./aliases.js";
export { buildFilePathResolver, resolveKnownPath } from "./resolver.js";
export type { FilePathResolver } from "./resolver.js";
export {
  getContainerFeatureFileInfo,
  getMeaningfulPathLabel,
  getMeaningfulPathWords,
  getPathArtifactLabel,
  getProjectAbsolutePath,
  getProjectRelativePath,
  getStructuralFeatureBoundary,
  getTopLevelAreaName,
  isBroadContainerRoot,
  isMeaningfulPathWord,
  isSupportLikePath,
  splitProjectPathSegments,
} from "./structure.js";
export type { StructuralFeatureBoundary } from "./structure.js";
