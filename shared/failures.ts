/**
 * Failures that are deliberately not fatal.
 *
 * An empty `catch(() => {})` says nothing: it cannot be told apart from a
 * mistake, nobody can say why the failure was acceptable, and there is no way
 * to ask later whether it ever happened. Every swallowed failure now goes
 * through one of two named doors, and both are counted so the choice stays
 * auditable.
 *
 * `ignoreFailure` is for cleanup and optional reads where a failure has no
 * consequence for the reader. `reportFailure` is for a side effect of
 * something the reader did: the local work already succeeded, but a cloud
 * write or a saved preference did not land. Those deserve a visible line.
 *
 * The reasons are named constants so a call site cannot invent a new silent
 * failure by accident, and so they can be checked as a set. They deliberately
 * avoid the word "error": the smoke run collects console lines matching it,
 * and a swallowed failure is not an uncaught one.
 *
 * Nothing here changes application state. Recording a failure is not handling
 * it; the call site has already decided what "handled" means.
 */

export const FAILURE = {
  notesOptional: 'notes are optional at startup',
  annotationCacheOptional: 'annotation cache is optional at startup',
  appVersionCosmetic: 'app version is cosmetic',
  workerCleanupTimedOut: 'worker cleanup after a timed-out parse',
  workerCleanup: 'worker cleanup after a parse',
  testPdfCleanup: 'test PDF cleanup',
  undoFolderRemove: 'undo could not take a paper out of its folder',
  undoFolderAdd: 'undo could not put a paper back in its folder',
  cloudHighlightRemoval: 'cloud highlight removal did not land',
  continuousPreference: 'continuous-mode preference was not saved',
  readingPosition: 'reading position was not saved'
} as const

export type FailureReason = (typeof FAILURE)[keyof typeof FAILURE]
export type FailureKind = 'ignored' | 'reported'
export type FailureSink = (reason: FailureReason, kind: FailureKind) => void

export interface FailureCount {
  ignored: number
  reported: number
}

const counts = new Map<string, FailureCount>()
let sink: FailureSink | null = null

/** Send reported failures somewhere else, or pass null for the default line. */
export function setFailureSink(next: FailureSink | null): void {
  sink = next
}

/** A snapshot for audits and tests; not a live view. */
export function failureCounts(): Record<string, FailureCount> {
  const out: Record<string, FailureCount> = {}
  for (const [reason, c] of counts) out[reason] = { ...c }
  return out
}

export function resetFailureCounts(): void {
  counts.clear()
}

function tally(reason: FailureReason, kind: FailureKind): void {
  const c = counts.get(reason) ?? { ignored: 0, reported: 0 }
  c[kind] += 1
  counts.set(reason, c)
}

/** A failure with no consequence for the reader, kept quiet on purpose. */
export function ignoreFailure(reason: FailureReason, _error?: unknown): void {
  tally(reason, 'ignored')
}

/** A side effect that did not land; the local work is still done. */
export function reportFailure(reason: FailureReason, _error?: unknown): void {
  tally(reason, 'reported')
  if (sink) sink(reason, 'reported')
  else console.warn('[mendeley-ng] ' + reason)
}
