/**
 * Work budgets for actions that touch many papers at once.
 *
 * These are not timings. Each one bounds how much work or how many state
 * updates one bulk action may cause, and each used to be a literal sitting
 * inside the loop it controlled. Naming them makes the three call sites
 * comparable and lets a test prove that extracting them moved no number.
 */

/** Presigned download URLs are refused rather than queued when the concurrency is high. */
export const DOWNLOAD_LANES = 3

/** Local paths are accumulated and written back in batches, then flushed at the end. */
export const DOWNLOAD_FLUSH_EVERY = 10

/** A batch reports progress in at most this many steps, not once per document. */
export const BATCH_PROGRESS_STEPS = 20
