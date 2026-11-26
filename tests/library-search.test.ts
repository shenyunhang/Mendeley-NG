/**
 * The three `useMemo`s that used to answer one keystroke in App.tsx are now
 * one pure function. This file keeps the old expressions verbatim and compares
 * the two, value by value, over a large set of queries, filter combinations,
 * folder selections and scopes.
 *
 * It also reports (but never gates on) the CPU cost of the two shapes on a
 * library-sized input, because the GUI perf run measures a window that can be
 * throttled by whatever else is on the desktop.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Doc } from '../shared/types'
import { FILTER_TEST, LIST_FILTERS, type ListFilter } from '../src/lib/filters'
import { compareSortKeys, sortKeyFor } from '../src/lib/columns'
import {
  compactForComparison,
  foldSeparators,
  allowNearFor,
  matchQuery,
  queryMatches
} from '../src/lib/searchMatch'
import { normaliseQuery } from '../src/lib/searchScope'
import {
  computeLibrarySearch,
  type LibrarySearchInput,
  type LibrarySearchResult
} from '../src/lib/librarySearch'

function rootUp(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}
const read = (p: string): string =>
  fs.readFileSync(path.join(rootUp(), p), 'utf-8').replace(/\r\n/g, '\n')

type Hay = { id: string; text: string }
const HAYS: Hay[] = [
  { id: 'd01', text: 'Attention Is All You Need 2017 Vaswani network' },
  { id: 'd02', text: 'Qwen-CUA: Scaling Verifiable Training Environments qwen cua' },
  { id: 'd03', text: 'qwen cud exact paper' },
  { id: 'd04', text: 'Deep Residual Learning for Image Recognition He Zhang' },
  { id: 'd05', text: 'BERT Pre-training of Deep Bidirectional Transformers' },
  { id: 'd06', text: '中文文献 标题 摘要 神经网络 模型 训练' },
  { id: 'd07', text: 'Language Models are Few-Shot Learners' },
  { id: 'd08', text: 'Scaling Laws for Neural Language Models' },
  { id: 'd09', text: 'a b c d e f g h i j' },
  { id: 'd10', text: 'zzzz unrelated words sitting in an abstract' },
  { id: 'd11', text: '' },
  { id: 'd12', text: '   ' },
  { id: 'd13', text: 'One single word network' },
  { id: 'd14', text: 'technical te attention transformer' },
  { id: 'd15', text: 'Qwen3.5 Technical Report qwen cua agents' },
  { id: 'd16', text: 'network network network' },
  { id: 'd17', text: 'GUI Grounding for computer use agents' },
  { id: 'd18', text: 'A Survey of Computer-Use Agents' }
]

/** The shape App passes to the pure rule. */
function makeInput(
  query: string,
  filters: readonly ListFilter[],
  folderIds: ReadonlySet<string> | null,
  metadataScope: boolean,
  rows: Hay[] = HAYS
): { input: LibrarySearchInput; docs: Doc[] } {
  const haystack = new Map<string, string>()
  const foldedHay = new Map<string, string>()
  const compactFoldedHay = new Map<string, string>()
  const corpusWords = new Set<string>()
  const docs: Doc[] = []
  for (const [index, row] of rows.entries()) {
    const folded = foldSeparators(row.text)
    haystack.set(row.id, row.text)
    foldedHay.set(row.id, folded)
    compactFoldedHay.set(row.id, compactForComparison(folded))
    for (const word of folded.split(' ')) if (word) corpusWords.add(word)
    // A spread of filter answers and folder memberships, so the counts and
    // the list see genuinely different populations.
    docs.push({
      id: row.id,
      title: row.text,
      starred: index % 3 === 0,
      read: index % 4 === 0,
      localPdf: index % 2 === 0 ? `C:/pdf/${row.id}.pdf` : undefined,
      file_attached: index % 5 === 0,
      folder_uuids: index % 3 === 0 ? ['f1'] : index % 3 === 1 ? ['f2', 'f3'] : []
    } as Doc)
  }
  return {
    docs,
    input: {
      docs,
      query,
      filters,
      folderIds,
      haystack,
      foldedHay,
      compactFoldedHay,
      corpusWords,
      metadataScope
    }
  }
}

/** The three blocks before the extraction, copied line for line. */
function legacyLibrarySearch(input: LibrarySearchInput): LibrarySearchResult {
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

  let out = docs
  for (const k of filters) out = out.filter(FILTER_TEST[k])
  if (folderIds) {
    out = out.filter((d) => (d.folder_uuids ?? []).some((f) => folderIds.has(f)))
  }
  if (q) {
    const allowNear = allowNearFor(
      out.map((d) => haystack.get(d.id) ?? ''),
      q
    )
    out = out.filter((d) =>
      queryMatches(
        haystack.get(d.id) ?? '',
        q,
        allowNear,
        foldedHay.get(d.id),
        corpusWords,
        compactFoldedHay.get(d.id)
      )
    )
  }

  const nearTerms = new Map<string, string[]>()
  if (q && metadataScope) {
    for (const d of out) {
      const r = matchQuery(
        haystack.get(d.id) ?? '',
        q,
        foldedHay.get(d.id),
        corpusWords,
        compactFoldedHay.get(d.id)
      )
      if (r && r.kind === 'near') nearTerms.set(d.id, r.terms)
    }
  }

  let base = docs
  if (folderIds) {
    base = base.filter((d) => (d.folder_uuids ?? []).some((f) => folderIds.has(f)))
  }
  if (q) {
    const allowNear = allowNearFor(
      base.map((d) => haystack.get(d.id) ?? ''),
      q
    )
    base = base.filter((d) =>
      queryMatches(
        haystack.get(d.id) ?? '',
        q,
        allowNear,
        foldedHay.get(d.id),
        corpusWords,
        compactFoldedHay.get(d.id)
      )
    )
  }
  const counts = {} as Record<ListFilter, number>
  for (const k of LIST_FILTERS) counts[k] = 0
  for (const d of base) {
    for (const k of LIST_FILTERS) if (FILTER_TEST[k](d)) counts[k]++
  }
  return { matched: out, counts, nearTerms }
}

const serialise = (r: LibrarySearchResult): string =>
  JSON.stringify({
    matched: r.matched.map((d) => d.id),
    counts: LIST_FILTERS.map((k) => r.counts[k]),
    nearTerms: [...r.nearTerms.entries()].sort(([a], [b]) => a.localeCompare(b))
  })

const QUERIES = [
  '', 'network', 'zzzzqqq', 'qwen cud', 'qwen cua', 'qwen3.5',
  '中文', '神经网络 模型', 'e', 'a', 'doesnotexist words', 'cud',
  'QWEN CUA', '  network  ', 'grounding gui', 'zzzzqqq extra'
]
const FILTER_SETS: readonly ListFilter[][] = [
  [], ['star'], ['nopdf'], ['star', 'unread'], ['cloud', 'unfiled']
]
const FOLDERS: (ReadonlySet<string> | null)[] = [
  null, new Set(['f1']), new Set(['f2', 'f3']), new Set(['none'])
]

function allCases(): LibrarySearchInput[] {
  const out: LibrarySearchInput[] = []
  for (const query of QUERIES) {
    for (const filters of FILTER_SETS) {
      for (const folderIds of FOLDERS) {
        for (const metadataScope of [true, false]) {
          out.push(makeInput(query, filters, folderIds, metadataScope).input)
        }
      }
    }
  }
  return out
}

describe('one pass answers exactly what three passes answered', () => {
  it('the comparison can see a changed answer before it is trusted', () => {
    // An empty query leaves every document in the list, so reversing it is a
    // difference the comparison must be able to see. A query with one hit
    // would make "reversed" and "original" the same array.
    const input = makeInput('', [], null, true).input
    const real = serialise(computeLibrarySearch(input))
    const wrongList: LibrarySearchResult = {
      ...computeLibrarySearch(input),
      matched: [...computeLibrarySearch(input).matched].reverse()
    }
    const wrongCount: LibrarySearchResult = {
      ...computeLibrarySearch(input),
      counts: { ...computeLibrarySearch(input).counts, star: 999 }
    }
    const wrongTerms: LibrarySearchResult = {
      ...computeLibrarySearch(input),
      nearTerms: new Map([['injected', ['wrong']]])
    }
    expect(serialise(wrongList)).not.toBe(real)
    expect(serialise(wrongCount)).not.toBe(real)
    expect(serialise(wrongTerms)).not.toBe(real)
  })

  it('matches the old list, counts and markings on every case', () => {
    let compared = 0
    let withNearTerms = 0
    let withMatches = 0
    for (const input of allCases()) {
      const oldAnswer = serialise(legacyLibrarySearch(input))
      const newAnswer = serialise(computeLibrarySearch(input))
      expect(newAnswer).toBe(oldAnswer)
      compared++
      if (computeLibrarySearch(input).nearTerms.size) withNearTerms++
      if (computeLibrarySearch(input).matched.length) withMatches++
    }
    // A comparison that only ever saw empty results would prove nothing.
    expect(compared).toBe(QUERIES.length * FILTER_SETS.length * FOLDERS.length * 2)
    expect(withNearTerms).toBeGreaterThan(0)
    expect(withMatches).toBeGreaterThan(0)
  })

  it('keeps the two typo gates separate when filters exclude the exact hit', () => {
    // Only d10 carries "zzzz", and it has no cloud attachment, so the cloud
    // filter removes the one exact hit from the list while the unfiltered
    // counts still have it. The list then allows a near fallback and the
    // counts do not. Merging the gates would change both answers here.
    const input = makeInput('zzzz', ['cloud'], null, true).input
    const listHays = input.docs
      .filter((d) => FILTER_TEST.cloud(d))
      .map((d) => input.haystack.get(d.id) ?? '')
    const listGate = allowNearFor(listHays, normaliseQuery('zzzz'))
    const countsGate = allowNearFor(input.haystack.values(), normaliseQuery('zzzz'))
    expect(listGate).toBe(true)
    expect(countsGate).toBe(false)
    expect(serialise(computeLibrarySearch(input)))
      .toBe(serialise(legacyLibrarySearch(input)))
  })

  it('reports the CPU cost of one pass versus three without gating on it', () => {
    // Library-sized input built from the same rows, so the number is about
    // the shape of the computation and not about this desktop's window focus.
    const big: Hay[] = []
    for (let n = 0; n < 320; n++) {
      for (const h of HAYS) big.push({ id: `${h.id}-${n}`, text: h.text })
    }
    const rounds = 6
    for (const query of ['network', 'zzzzqqq']) {
      const { input } = makeInput(query, ['star'], null, true, big)
      const oldStart = performance.now()
      for (let i = 0; i < rounds; i++) legacyLibrarySearch(input)
      const oldMs = (performance.now() - oldStart) / rounds
      const newStart = performance.now()
      for (let i = 0; i < rounds; i++) computeLibrarySearch(input)
      const newMs = (performance.now() - newStart) / rounds
      expect(serialise(computeLibrarySearch(input)))
        .toBe(serialise(legacyLibrarySearch(input)))
      console.log(
        `[library-search bench] ${big.length} docs, "${query}": ` +
          `three passes ${oldMs.toFixed(2)} ms, one pass ${newMs.toFixed(2)} ms`
      )
    }
  })

  it('keeps the wrapper sort, the shape that measured faster', () => {
    // A cached-key comparator looks cheaper: it skips 5760 sortKeyFor calls.
    // It measured about 40% slower across three runs, because two Map.get
    // calls per comparison cost more than reading `.k` off a row. The
    // rejected shape stays here so the next change can re-measure rather
    // than re-guess. Both shapes must still produce the same order.
    const docs: Doc[] = []
    for (let n = 0; n < 320; n++) {
      for (const h of HAYS) {
        docs.push({
          id: `${h.id}-${n}`,
          title: h.text,
          year: 2000 + (n % 25)
        } as Doc)
      }
    }
    const key = 'year' as const
    const dir: 1 | -1 = -1
    const sortKeys = new Map(docs.map((d) => [d.id, sortKeyFor(d, key)]))

    const oldSort = (): string[] => {
      const rows = docs.map((d) => ({ d, k: sortKeyFor(d, key) }))
      rows.sort((a, b) =>
        compareSortKeys(a.k, b.k, dir, a.d.title ?? '', b.d.title ?? '')
      )
      return rows.map((r) => r.d.id)
    }
    const newSort = (): string[] => {
      const out = [...docs]
      out.sort((a, b) =>
        compareSortKeys(
          sortKeys.get(a.id) ?? sortKeyFor(a, key),
          sortKeys.get(b.id) ?? sortKeyFor(b, key),
          dir,
          a.title ?? '',
          b.title ?? ''
        )
      )
      return out.map((d) => d.id)
    }
    expect(newSort()).toEqual(oldSort())

    const rounds = 6
    const oldStart = performance.now()
    for (let i = 0; i < rounds; i++) oldSort()
    const oldMs = (performance.now() - oldStart) / rounds
    const newStart = performance.now()
    for (let i = 0; i < rounds; i++) newSort()
    const newMs = (performance.now() - newStart) / rounds
    console.log(
      `[library-search bench] ${docs.length} docs sorted: ` +
        `wrapper objects ${oldMs.toFixed(2)} ms, cached keys ${newMs.toFixed(2)} ms`
    )
  })

  it('holds the wiring that keeps the two gates and the sort in place', () => {
    const source = read('src/lib/librarySearch.ts')
    expect(source).toContain('const listAllowNear = allowNearFor(populationHays(records, true), q)')
    expect(source).toContain('const countsAllowNear = allowNearFor(populationHays(records, false), q)')
    expect(source).toContain('if (inList) matched.push(r.doc)')
    const app = read('src/App.tsx')
    expect(app).toContain('computeLibrarySearch({')
    expect(app).toContain('const nearTerms = search.nearTerms')
    expect(app).toContain('const filterCounts = search.counts')
    expect(app).toContain('sortKeyFor(d, key)')
    expect(app).toContain('compareSortKeys(a.k, b.k, dir')
  })
})
