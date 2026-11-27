import {
  clampFullTextPages,
  formatFullTextPageBudget,
  FULL_TEXT_MIN_PAGES
} from '../../shared/fullTextPages'
import { DEFAULT_FT_PAGES, FULL_TEXT_ALL_PAGES } from '../../shared/types'

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
 * The field takes a word as well as a number now. Whole documents are the
 * default, and showing a bare 0 for them would read like a broken setting.
 * The word is handed in by the caller so this rule stays language free; the
 * `Number.isFinite` check is not a second bound, it is what this field
 * accepts. The bounds and the default still come from `shared/`.
 */
export interface PageBudgetCommit {
  shown: string
  applied: number
}

/** Words the field accepts for the all-pages budget, in either language.
 *  The English entries cover the label the English UI puts in the field. */
const ALL_PAGES_WORDS = new Set(['全部', 'all', 'whole', 'full', 'all pages'])

export function commitPageBudget(
  raw: string,
  allPagesLabel = '全部'
): PageBudgetCommit {
  const trimmed = raw.trim()
  const n = Number(trimmed)
  const asksForAll =
    trimmed === String(FULL_TEXT_ALL_PAGES) ||
    ALL_PAGES_WORDS.has(trimmed.toLowerCase())
  const applied =
    asksForAll || !Number.isFinite(n) || n < FULL_TEXT_MIN_PAGES
      ? DEFAULT_FT_PAGES
      : clampFullTextPages(n)
  return {
    shown: formatFullTextPageBudget(applied, allPagesLabel),
    applied
  }
}
