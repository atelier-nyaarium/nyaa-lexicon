/**
 * How many literals a regex search will read before giving up.
 *
 * SQLite has no REGEXP here, so a regex is matched in application code and the read is what
 * costs. Stopping is fine; stopping SILENTLY is not, which is why the result carries a flag saying
 * the scan did not finish.
 */
export const REGEX_SCAN_LIMIT = 20_000;

/** Default page for a reference list. A hub symbol would otherwise flood a caller's context. */
export const DEFAULT_REFERENCE_LIMIT = 50;

/** Page for a literal search. Literals outnumber symbols by a lot, so this is the tighter cap. */
export const DEFAULT_LITERAL_LIMIT = 50;

/** Page for a comment search, matching literals. */
export const DEFAULT_COMMENT_LIMIT = 50;

/** Clamped here rather than only at the surfaces, so no entry point can ask for more. */
export const MAX_COMMENT_LIMIT = 200;
