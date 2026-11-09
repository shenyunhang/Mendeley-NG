import {
  clampFullTextPages,
  FULL_TEXT_MAX_PAGES,
  FULL_TEXT_MIN_PAGES,
  restoredPageBudget
} from '../../shared/fullTextPages'
import { DEFAULT_FT_PAGES } from '../../shared/types'

import type { SmokeCtx } from './smoke-ctx'

export function restoredBudget(ctx: SmokeCtx) {
    const oldRestore = (v: unknown): number =>
      typeof v === 'number' && v > 0 ? v : DEFAULT_FT_PAGES
    const indexUses = (v: unknown): number => clampFullTextPages(v)

    ctx.expect(
      'the old restore really could disagree with the index builder',
      oldRestore(999) === 999 &&
        indexUses(999) === FULL_TEXT_MAX_PAGES &&
        oldRestore(999) !== indexUses(999),
      { restored: oldRestore(999), indexed: indexUses(999) }
    )

    const values: unknown[] = [
      1, 2, 3, 4.9, 50, 51, 999, -1, -999, 0, NaN, Infinity, -Infinity,
      0.5, 49.9
    ]
    for (let n = -10; n <= 60; n++) values.push(n)
    const drift = values.filter(
      (v) =>
        restoredPageBudget(v) !==
        indexUses(typeof v === 'number' && v > 0 ? v : DEFAULT_FT_PAGES)
    )
    ctx.expect(
      'a restored budget agrees with the index rule for every valid value',
      drift.length === 0,
      { checked: values.length, drift }
    )

    const unusable: unknown[] = [undefined, null, 0, -1, NaN, '', '7', {}, []]
    ctx.expect(
      'a missing or unusable config value falls back to the shared default',
      unusable.every((v) => restoredPageBudget(v) === DEFAULT_FT_PAGES),
      {
        answers: unusable.map((v) => restoredPageBudget(v))
      }
    )

    ctx.expect(
      'a numeric string in a hand-edited config is not a page budget',
      restoredPageBudget('7') === DEFAULT_FT_PAGES &&
        restoredPageBudget('50') === DEFAULT_FT_PAGES &&
        oldRestore('7') === DEFAULT_FT_PAGES,
      { seven: restoredPageBudget('7'), fifty: restoredPageBudget('50') }
    )

    ctx.expect(
      'a fractional budget from a config file is floored before it is stored',
      restoredPageBudget(4.9) === 4 &&
        restoredPageBudget(2.1) === 2 &&
        restoredPageBudget(50.9) === FULL_TEXT_MAX_PAGES,
      {
        fourNine: restoredPageBudget(4.9),
        twoOne: restoredPageBudget(2.1),
        fiftyNine: restoredPageBudget(50.9)
      }
    )

    let outside = 0
    for (let n = -100; n <= 200; n++) {
      const v = restoredPageBudget(n + 0.5)
      if (
        v < FULL_TEXT_MIN_PAGES ||
        v > FULL_TEXT_MAX_PAGES ||
        !Number.isInteger(v)
      ) outside += 1
    }
    ctx.expect(
      'no restored budget can leave the index bounds',
      outside === 0 &&
        restoredPageBudget(DEFAULT_FT_PAGES) === DEFAULT_FT_PAGES,
      { outside, min: FULL_TEXT_MIN_PAGES, max: FULL_TEXT_MAX_PAGES }
    )
}
