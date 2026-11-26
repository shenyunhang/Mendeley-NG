/**
 * Everything one keystroke in the library search box needs, from one pass
 * over the documents.
 *
 * This used to be three separate `useMemo`s in App.tsx: the visible list, the
 * counts beside each filter switch, and the words a near-match card marks.
 * Each walked the same several thousand papers, called the same predicates
 * on the same haystacks, and decided the typo gate again from its own
 * population. The answer is unchanged; a paper's hay is now read and compared
 * once per key instead of three times, and the intermediate arrays that the
 * collector had to account for are gone.
 *
 * The two typo gates are deliberately kept separate. The list has the filter
 * switches applied and the counts must not, so `allowNearFor` can answer
 * "there was no exact hit" differently for them. Merging the gates would
 * change which papers a mistyped word returns.
 */
import type { Doc } from '../../shared/types'
import { FILTER_TEST, LIST_FILTERS, type ListFilter } from './filters'
import { allowNearFor, matchQuery, type QueryMatch } from './searchMatch'
import { normaliseQuery } from './searchScope'

export interface LibrarySearchInput {
  docs: Doc[]
  query: string
  filters: readonly ListFilter[]
  /** null when no folder is selected; the caller owns the subtree lookup. */
  folderIds: ReadonlySet<string> | null
  haystack: Map<string, string>
  foldedHay: Map<string, string>
  compactFoldedHay: Map<string, string>
  corpusWords: ReadonlySet<string>
  /** Whether card marking applies to this search scope. */
  metadataScope: boolean
}

export interface LibrarySearchResult {
  /** Survives folder, filters and query. Still unsorted; the caller sorts. */
  matched: Doc[]
  /** How many papers each switch would leave, on the unfiltered base. */
  counts: Record<ListFilter, number>
  /** Words that really occur in the paper, for marking a near-match card. */
  nearTerms: Map<string, string[]>
}

interface SearchRecord {
  doc: Doc
  hay: string
  exact: boolean
  passFilters: boolean
}

/** The hays of one population, yielded so `allowNearFor` can stop at its
 *  first exact hit without a second full-size array being built. */
function* populationHays(records: SearchRecord[], withFilters: boolean) {
  for (const r of records) {
    if (!withFilters || r.passFilters) yield r.hay
  }
}

export function computeLibrarySearch(input: LibrarySearchInput): LibrarySearchResult {
  const {
    docs,
    filters,
    folderIds,
    haystack,
    foldedHay,
    compactFoldedHay,
    corpusWords,
    metadataScope
  } = input
  const q = normaliseQuery(input.query)

  // Pass one: folder membership, the filter switches, and the exact-hit
  // answer. Both populations are drawn from these records, so the folder
  // subtree is walked once rather than once per consumer.
  const records: SearchRecord[] = []
  for (const d of docs) {
    if (folderIds && !(d.folder_uuids ?? []).some((f) => folderIds.has(f))) continue
    const hay = haystack.get(d.id) ?? ''
    records.push({
      doc: d,
      hay,
      exact: !q || hay.includes(q),
      passFilters: filters.every((k) => FILTER_TEST[k](d))
    })
  }

  // `allowNearFor` stays the single rule for the gate. It stops at the first
  // exact hit, so the generator rarely walks the whole population.
  const listAllowNear = allowNearFor(populationHays(records, true), q)
  const countsAllowNear = allowNearFor(populationHays(records, false), q)

  const matched: Doc[] = []
  const counts = {} as Record<ListFilter, number>
  for (const k of LIST_FILTERS) counts[k] = 0
  const nearTerms = new Map<string, string[]>()

  // Pass two: decide both memberships from one near answer.
  for (const r of records) {
    // `queryMatches` short-circuits when both gates are shut, so walking the
    // words of every paper here would be work the old predicate never did.
    // An exact hit anywhere in the library is the common case: keep that
    // short-circuit rather than paying for a corpus-wide near match.
    const wantsNear = !r.exact && q && (listAllowNear || countsAllowNear)
    const near: QueryMatch | null = wantsNear
      ? matchQuery(
          r.hay,
          q,
          foldedHay.get(r.doc.id),
          corpusWords,
          compactFoldedHay.get(r.doc.id)
        )
      : null
    const nearOk = near?.kind === 'near'
    const inList = r.passFilters && (r.exact || (listAllowNear && nearOk))
    const inCounts = r.exact || (countsAllowNear && nearOk)

    if (inList) matched.push(r.doc)
    if (inCounts) {
      for (const k of LIST_FILTERS) if (FILTER_TEST[k](r.doc)) counts[k]++
    }
    // Marking follows `matchQuery`, not the typo gate: a folded or compact
    // near answer still marks a card. A paper without an exact hit can only
    // be in the list through `near`, so that answer is already in hand.
    if (inList && metadataScope && nearOk && near) {
      nearTerms.set(r.doc.id, near.terms)
    }
  }

  return { matched, counts, nearTerms }
}
