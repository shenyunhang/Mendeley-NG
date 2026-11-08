import type { AppConfig } from '../../shared/types'

/**
 * One door for every preference write.
 *
 * `setConfig` used to be called in twenty-odd places with no rejection
 * branch.  The in-memory state had already been updated by the time a failed
 * write came back, so the UI showed a setting that would be gone on the next
 * start with no explanation at all.  The callers still decide *which* keys a
 * change touches -- that part of the design is deliberate -- but the failure
 * is now reported once, from here.
 *
 * The reporter is registered by the app rather than imported from it, so this
 * module stays a plain utility that any hook can call without pulling the
 * component tree into it.
 */
type Reporter = (message: string) => void

let reporter: Reporter | null = null

export function setConfigWriteReporter(fn: Reporter | null): void {
  reporter = fn
}

/** Persist a partial config. Returns the config that landed, or null when
 *  the write failed; callers that only fire and forget may ignore both. */
export function writeConfig(patch: Partial<AppConfig>): Promise<AppConfig | null> {
  return window.api.setConfig(patch).catch((e: unknown) => {
    reporter?.('设置未能保存：' + String(e))
    return null
  })
}
