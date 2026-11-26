import { describe, expect, it } from 'vitest'
import type { Doc } from '../shared/types'
import {
  SORT_KEYS,
  compareSortKeys,
  sortKeyFor,
  type SortKey
} from '../src/lib/columns'
import { filterSortedLibrary, sortedLibrary } from '../src/lib/libraryOrder'

/**
 * Sorting the matched rows on every keystroke used to be the largest piece of
 * work left in a keystroke. The new shape sorts the whole library once and
 * filters that order. This is only legal because the comparator never looks
 * at which other rows are present, so the check below walks both shapes over
 * many keys, directions and subsets and compares every id in order.
 */
function makeDocs(n: number): Doc[] {
  let seed = 20261126
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed
  }
  const out: Doc[] = []
  for (let i = 0; i < n; i++) {
    const r = next()
    out.push({
      id: `doc-${i}`,
      // Repeated titles and shared prefixes are what make the collator
      // tie-break decide an order rather than the input array doing it.
      title: ['Alpha', 'alpha', 'Beta', 'Qwen-CUA', '网络'] [r % 5] + ` ${r % 17}`,
      year: r % 9 === 0 ? undefined : 1990 + (r % 35),
      source: ['CVPR', 'NeurIPS', 'arXiv', 'cvpr'][r % 4],
      citation_key: `key${r % 23}`,
      starred: r % 3 === 0,
      created: r % 11 === 0 ? undefined : `2026-0${1 + (r % 9)}-1${r % 9}`,
      authors: [{ last_name: ['Zhang', 'zhang', 'Hou'][r % 3], first_name: 'A' }]
    } as Doc)
  }
  return out
}

/** The expression App used to run on every keystroke, copied verbatim. */
function oldOrder(matched: Doc[], key: SortKey, dir: 1 | -1): string[] {
  const rows = matched.map((d) => ({ d, k: sortKeyFor(d, key) }))
  rows.sort((a, b) =>
    compareSortKeys(a.k, b.k, dir, a.d.title ?? '', b.d.title ?? '')
  )
  return rows.map((r) => r.d.id)
}

const docs = makeDocs(420)

function subset(n: number): Doc[] {
  const out: Doc[] = []
  for (let i = 0; i < docs.length; i++) if ((i * 7 + n * 13) % 11 < 3 + (n % 3)) out.push(docs[i]!)
  return out
}

describe('sorted library order', () => {
  it('finds a difference when the order is deliberately wrong', () => {
    // A detector that cannot fail proves nothing. Reversing a sorted list
    // must break the comparison for a real key and a real subset.
    const key: SortKey = 'title'
    const dir: 1 | -1 = 1
    const picked = subset(3)
    const right = sortedLibrary(docs, { key, dir })
    expect(oldOrder(picked, key, dir)).toEqual(
      filterSortedLibrary(right, picked).map((d) => d.id)
    )
    expect(oldOrder(picked, key, dir)).not.toEqual(
      filterSortedLibrary([...right].reverse(), picked).map((d) => d.id)
    )
    // And sorting is not a no-op: the input order itself must fail somewhere.
    expect(oldOrder(picked, key, dir)).not.toEqual(picked.map((d) => d.id))
  })

  it('matches sorting the subset directly for every key, direction and subset', () => {
    for (const key of SORT_KEYS) {
      for (const dir of [1, -1] as const) {
        const sortedAll = sortedLibrary(docs, { key, dir })
        for (let n = 0; n < 24; n++) {
          const picked = subset(n)
          expect(
            filterSortedLibrary(sortedAll, picked).map((d) => d.id),
            `${key} dir=${dir} subset=${n}`
          ).toEqual(oldOrder(picked, key, dir))
        }
        expect(filterSortedLibrary(sortedAll, []).map((d) => d.id)).toEqual([])
        expect(filterSortedLibrary(sortedAll, docs).map((d) => d.id)).toEqual(
          oldOrder(docs, key, dir)
        )
      }
    }
  })

  it('keeps equal keys in library order in both directions', () => {
    const twins = [
      { id: 'a', title: 'Same', year: 2000 },
      { id: 'b', title: 'Same', year: 2000 },
      { id: 'c', title: 'Same', year: 2000 }
    ] as Doc[]
    // `computeLibrarySearch` walks `docs` in order, so a subset is always in
    // library order. Equal keys then stay in that order in both directions.
    const ordered = [twins[0]!, twins[2]!]
    for (const dir of [1, -1] as const) {
      const sorted = sortedLibrary(twins, { key: 'title', dir })
      expect(filterSortedLibrary(sorted, ordered).map((d) => d.id)).toEqual(['a', 'c'])
      expect(oldOrder(ordered, 'title', dir)).toEqual(['a', 'c'])
    }
  })
})
