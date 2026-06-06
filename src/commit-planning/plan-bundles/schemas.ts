import { z } from "zod";

export const PLAN_BUNDLE_SCHEMA_VERSION = 4;
export const SHA256_HASH_PATTERN = /^[a-f0-9]{64}$/u;

const Sha256HashSchema = z.string().regex(SHA256_HASH_PATTERN);

const PlannedCommitFileSchema = z.object({
  hunks: z.array(z.number().int().nonnegative()).optional(),
  path: z.string().min(1),
});

const PlannedCommitSchema = z.object({
  files: z.array(PlannedCommitFileSchema).min(1),
  message: z.string().min(1),
});

const PersistedBundleFileHashesSchema = z.object({
  fileHash: Sha256HashSchema,
  hunkHashes: z.array(Sha256HashSchema),
  path: z.string().min(1),
});

const PersistedBundleContentHashesSchema = z.object({
  bundleHash: Sha256HashSchema,
  files: z.array(PersistedBundleFileHashesSchema).min(1),
});

const PersistedPlanCommitFileHashesSchema = z.object({
  fileHash: Sha256HashSchema,
  hunkHashes: z.array(Sha256HashSchema),
  hunkIndexes: z.array(z.number().int().nonnegative()),
  path: z.string().min(1),
  wholeFile: z.boolean(),
});

const PersistedPlanCommitHashesSchema = z.object({
  files: z.array(PersistedPlanCommitFileHashesSchema).min(1),
  hash: Sha256HashSchema,
});

const PersistedPlanCommitPatchSchema = z.string();

const HeadCommitSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .nullable();

const SharedPersistedPlanBundleFields = {
  createdAt: z.iso.datetime({ offset: true }),
  hash: Sha256HashSchema,
  headCommit: HeadCommitSchema,
  plan: z.array(PlannedCommitSchema).min(1),
  repoRoot: z.string().min(1),
  stagedPatch: z.string().min(1),
  stagedPatchHash: Sha256HashSchema,
} as const;

export const PersistedPlanBundleSchema = z.object({
  contentHashes: PersistedBundleContentHashesSchema,
  planCommitHashes: z.array(PersistedPlanCommitHashesSchema).min(1),
  planCommitPatches: z.array(PersistedPlanCommitPatchSchema).min(1),
  ...SharedPersistedPlanBundleFields,
  schemaVersion: z.literal(PLAN_BUNDLE_SCHEMA_VERSION),
});

export type PersistedPlanBundle = z.infer<typeof PersistedPlanBundleSchema>;
