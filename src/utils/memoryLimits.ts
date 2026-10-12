/**
 * Valid ranges for the memory preferences (Preferences → Memory). Shared by
 * the dialog (input validation) and the consumers that apply the values, so a
 * bad persisted or typed value (0, negative, NaN) can't wipe the undo history
 * or block every allocation.
 */

export const GB = 1024 * 1024 * 1024;

/** Smallest history / buffer limit, in GB. */
export const MIN_MEMORY_LIMIT_GB = 0.5;
/** Largest history limit, in GB. */
export const MAX_HISTORY_LIMIT_GB = 64;

/** Defaults (match `DEFAULT_PREFERENCES`). */
export const DEFAULT_HISTORY_BYTES = 4 * GB;
export const DEFAULT_BUFFER_BYTES = 8 * GB;

/** Clamp a history-memory cap (bytes) into the valid range; non-finite values
 *  fall back to the default. */
export function sanitizeHistoryMemoryBytes(bytes: number): number {
  if (!Number.isFinite(bytes)) return DEFAULT_HISTORY_BYTES;
  return Math.min(MAX_HISTORY_LIMIT_GB * GB, Math.max(MIN_MEMORY_LIMIT_GB * GB, bytes));
}

/** Parse a GB value typed into a memory field and clamp it to
 *  `[MIN_MEMORY_LIMIT_GB, maxGB]`. Returns null for an empty or unparsable
 *  field (the user is still typing): the caller keeps the current value. */
export function parseMemoryLimitGB(text: string, maxGB: number): number | null {
  if (text.trim() === "") return null;
  const gb = Number(text);
  if (!Number.isFinite(gb)) return null;
  return Math.min(maxGB, Math.max(MIN_MEMORY_LIMIT_GB, gb));
}

/** Clamp a buffer-memory cap (bytes) to at least `MIN_MEMORY_LIMIT_GB`;
 *  non-finite values fall back to the default. (The upper bound is the
 *  installed RAM, which only the Preferences dialog knows.) */
export function sanitizeBufferMemoryBytes(bytes: number): number {
  if (!Number.isFinite(bytes)) return DEFAULT_BUFFER_BYTES;
  return Math.max(MIN_MEMORY_LIMIT_GB * GB, bytes);
}

/**
 * Store-level guard for a memory cap set programmatically: a non-number,
 * NaN, infinite, zero or negative cap is corrupt and replaced by `fallback`
 * (a zero history cap would evict every document's undo history; a zero
 * buffer cap would refuse every allocation). Positive values pass through
 * unclamped — the UI range is applied where user input enters (the dialog,
 * the persisted file on load).
 */
export function validMemoryCapBytes(bytes: unknown, fallback: number): number {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0
    ? bytes
    : fallback;
}
