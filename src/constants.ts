/**
 * Shared constants used across the application
 * Extracting magic numbers improves maintainability and documentation
 */

// ============================================================================
// AI Analysis Configuration
// ============================================================================

/** Hard cap on files to analyze in a single grouping batch */
export const MAX_FILES_PER_BATCH = 24;

/** Maximum approximate prompt lines before grouping is split into batches */
export const MAX_GROUPING_PROMPT_LINES = 1200;

/**
 * Reason: Small-to-medium changesets should stay in a single planning pass so the
 * model can keep related source, tests, scripts, and tooling together. We still
 * retain a hard cap and a prompt-size cap to avoid oversized requests.
 */

// ============================================================================
// Cache Configuration
// ============================================================================

/** Maximum number of cache entries to prevent unbounded memory growth */
export const CACHE_MAX_SIZE = 1000;

/** Reason: Balance between memory usage (~50KB per entry = 50MB max) and hit rate */

// ============================================================================
// AI Token Configuration
// ============================================================================

/** Minimum viable tokens for generating a single commit message */
export const MIN_COMMIT_MESSAGE_TOKENS = 512;

/** Base tokens for grouping prompt overhead (instructions, formatting) */
export const GROUPING_BASE_TOKENS = 512;

/** Additional tokens per file when generating commit groups */
export const TOKENS_PER_FILE = 256;

/** Minimum tokens for grouping responses (ensures complete JSON) */
export const MIN_GROUPING_TOKENS = 2048;

/**
 * Reason: Grouping requires JSON array output with multiple commit objects.
 * Need enough tokens for:
 * - System prompt (instructions) ~800 tokens
 * - User prompt (file diffs) varies
 * - Response (JSON array) ~500-2000 tokens depending on file count
 */

// ============================================================================
// Timeout Configuration
// ============================================================================

/** Extended timeout for grouping operations (more complex than single commit) */
export const GROUPING_TIMEOUT_MS = 30_000;

/**
 * Reason: Grouping analyzes multiple files and generates structured output,
 * typically takes 2-3x longer than single commit message generation.
 * 30s provides headroom for larger diffs without timing out prematurely.
 */

// ============================================================================
// Validation Limits
// ============================================================================

/** Maximum reasonable number of commit groups to prevent malformed responses */
export const MAX_COMMIT_GROUPS = 100;

/** Maximum commit message length to prevent excessive output */
export const MAX_COMMIT_MESSAGE_LENGTH = 10_000;

/** Maximum file path length (typical filesystem limit) */
export const MAX_PATH_LENGTH = 4096;

/**
 * Reason: Prevents malformed AI responses or malicious input from
 * causing resource exhaustion or processing errors
 */

// ============================================================================
// Git Configuration
// ============================================================================

/** Maximum buffer size for git command output (10MB) */
export const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Reason: Large repos with many files can produce multi-MB diffs.
 * 10MB handles most cases while preventing memory exhaustion.
 */

// ============================================================================
// CLI Configuration
// ============================================================================

/** Number of context lines before/after changes in git diff */
export const DIFF_CONTEXT_LINES = 3;

/**
 * Reason: Standard git default. Provides enough context for AI to
 * understand changes without bloating diff size.
 */

// ============================================================================
// Default Messages
// ============================================================================

/** Default commit message for empty diffs */
export const DEFAULT_EMPTY_COMMIT_MESSAGE = "chore: empty commit";

/** Reason: Conventional Commits format for edge case handling */
