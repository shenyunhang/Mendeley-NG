import type { Doc } from '../../shared/types'
import { compareSortKeys, sortKeyFor, type SortKey } from './columns'

/**
 * The order of the library, and the order of a subset of it.
 *
 * The list used to be sorted on every keystroke: `search.matched` gets a new
 * identity for every letter, so a `useMemo` over it rebuilt and re-sorted
 * several thousand rows with a collator-backed comparator each time. The
 * comparison depends only on the document, the key and the direction — never
 * on which other documents are present — so the full library can be sorted
 * once per sort change, and a keystroke only has to walk that order and keep
 * the rows that matched. `Array.prototype.sort` is stable, so documents with
 * equal keys keep the same relative order in the subset as they do in the
 * whole library; the answer is identical, not merely similar.
 */
export interface SortSpec {
  key: SortKey
  dir: 1 | -1
}

export function sortedLibrary(docs: readonly Doc[], sort: SortSpec): Doc[] {
  const rows = docs.map((d) => ({ d, k: sortKeyFor(d, sort.key) }))
  rows.sort((a, b) =>
    compareSortKeys(a.k, b.k, sort.dir, a.d.title ?? '', b.d.title ?? '')
  )
  return rows.map((r) => r.d)
}

/** The matched rows, in the order they already have in the whole library. */
export function filterSortedLibrary(
  sorted: readonly Doc[],
  matched: readonly Doc[]
): Doc[] {
  if (matched.length === 0) return []
  const ids = new Set(matched.map((d) => d.id))
  return sorted.filter((d) => ids.has(d.id))
}
