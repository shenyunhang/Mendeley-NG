import {
  clampFullTextPages,
  FULL_TEXT_MIN_PAGES
} from '../../shared/fullTextPages'
import { DEFAULT_FT_PAGES } from '../../shared/types'

/**
 * What the Settings sheet does when the full-text page budget is committed.
 *
 * The field is applied on blur rather than per keystroke, because every
 * change drops the index. It used to clamp with literals of its own and to
 * write the field back only for an unusable value: typing `100` wrote `50`
 * into the config, rebuilt the index against 50, and left `100` on screen.
 * The panel and the index were then describing one setting with two
 * different numbers. 170 documented the page budget as a single shared rule;
 * this was the call site still carrying a second one.
 *
 * The number written is deliberately identical to the old form for every
 * input, including an empty field and `Infinity`. Only what the field shows
 * is fixed: it now always shows the value that actually took effect. The
 * `Number.isFinite` check is not a second bound, it is what this field
 * accepts; the bounds and the default still come from `shared/`.
 */
export interface PageBudgetCommit {
  shown: string
  applied: number
}

export function commitPageBudget(raw: string): PageBudgetCommit {
  const n = Number(raw)
  const applied =
    !Number.isFinite(n) || n < FULL_TEXT_MIN_PAGES
      ? DEFAULT_FT_PAGES
      : clampFullTextPages(n)
  return { shown: String(applied), applied }
}
