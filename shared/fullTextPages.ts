import { DEFAULT_FT_PAGES } from './types'

/**
 * The one definition of a valid full-text page budget.
 *
 * The setting is written in the renderer and consumed by the index builder in
 * the main process, across an IPC boundary.  Keeping a clamp on both sides
 * gives the two halves two chances to disagree: the number the Settings panel
 * accepts and the number the index is actually built from would then be
 * different answers for the same config value.  So the bounds and the rule
 * live in `shared/`, and neither side writes its own `Math.min(...)` again.
 *
 * The default stays in `types.ts`, where the settings panel and the config
 * hook already import it from.  This module imports that constant instead of
 * copying `3`, which is what the main process used to do.
 */
export const FULL_TEXT_MIN_PAGES = 1
export const FULL_TEXT_MAX_PAGES = 50

/**
 * Hold any input within the budget, including what a config file can really
 * contain: a numeric string, `null`, `undefined`, `NaN`, either infinity.
 *
 * A value that is not a usable number -- zero, `NaN`, `null` -- falls back to
 * the shared default rather than quietly becoming the minimum page count.
 * `Math.floor` comes before the clamp on purpose: a fractional budget is
 * floored first, so `50.9` is 50 and not a value that would be rounded up.
 */
export function clampFullTextPages(n: unknown): number {
  const whole = Math.floor(Number(n)) || DEFAULT_FT_PAGES
  return Math.max(FULL_TEXT_MIN_PAGES, Math.min(FULL_TEXT_MAX_PAGES, whole))
}

/**
 * A page budget read back out of the config file.
 *
 * The config is plain JSON and can be hand edited, so what comes back is not
 * necessarily a value the Settings panel could have written. The renderer
 * used to accept any positive number while the index builder clamped it,
 * which left the panel and the index describing one config entry with two
 * different numbers. A missing or unusable value keeps the default -- that
 * is what the state starts at anyway.
 *
 * The type guard is deliberate. A numeric string in a hand-edited config is
 * not a number the app wrote, and accepting it would turn a malformed file
 * into a silently different setting.
 */
export function restoredPageBudget(value: unknown): number {
  return typeof value === 'number' && value > 0
    ? clampFullTextPages(value)
    : DEFAULT_FT_PAGES
}
