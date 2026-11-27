import { clampToRange } from './clamp'
import { DEFAULT_FT_PAGES, FULL_TEXT_ALL_PAGES } from './types'

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
 * copying a literal, which is what the main process used to do.
 *
 * A budget is either a positive number of leading pages or the all-pages
 * sentinel. The sentinel is the default: a search that cannot answer for the
 * body of a paper is not a useful default for a full-text index.
 */
export const FULL_TEXT_MIN_PAGES = 1
export const FULL_TEXT_MAX_PAGES = 50

/** Whether a budget asks for every page rather than a leading slice. */
export function isFullTextAllPages(budget: number): boolean {
  return budget === FULL_TEXT_ALL_PAGES
}

/**
 * Hold any input within the budget, including what a config file can really
 * contain: a numeric string, `null`, `undefined`, `NaN`, either infinity.
 *
 * A value that is not a usable number -- zero, `NaN`, `null` -- falls back to
 * the shared default, which is now the all-pages budget. That is deliberate:
 * an empty or malformed field must not silently turn into a one-page index.
 * `Math.floor` comes before the clamp on purpose: a fractional budget is
 * floored first, so `50.9` is 50 and not a value that would be rounded up.
 */
export function clampFullTextPages(n: unknown): number {
  const whole = Math.floor(Number(n)) || DEFAULT_FT_PAGES
  // The all-pages sentinel has to leave before the clamp. It is not a number
  // below the lower bound: clamping it to 1 would make the default a
  // one-page index, which is the exact opposite of what was asked for.
  if (isFullTextAllPages(whole)) return FULL_TEXT_ALL_PAGES
  // The plain clamp is shared/clamp.ts's rule, not a second copy of it. The
  // bounds and the default stay here because only this module knows what a
  // page budget means; the "how to clamp" part belongs to the one rule.
  return clampToRange(whole, FULL_TEXT_MIN_PAGES, FULL_TEXT_MAX_PAGES)
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
 * into a silently different setting. A config that explicitly says 3 keeps
 * saying 3: changing the default is not a licence to overwrite a choice the
 * reader made.
 */
export function restoredPageBudget(value: unknown): number {
  return typeof value === 'number' && value >= FULL_TEXT_ALL_PAGES
    ? clampFullTextPages(value)
    : DEFAULT_FT_PAGES
}

/**
 * One label for a budget, so the field, the status line and the sentence
 * explaining a voided index cannot describe the same number differently.
 * The word for "every page" is passed in because translating it belongs to
 * the renderer, not to a shared rule.
 */
export function formatFullTextPageBudget(
  budget: number,
  allPagesLabel: string
): string {
  return isFullTextAllPages(budget) ? allPagesLabel : String(budget)
}
