import { describe, it, expect, vi } from 'vitest'
import type { Annotation, Author, CloudAnnotation, Doc, Folder, PdfPos } from '../shared/types'
import type { OutlineNode } from '../src/lib/pdfgeom'
import type { ColKey } from '../src/lib/columns'

import { devicePixelRatioOrOne, bitmapPixelSize } from '../src/lib/bitmapPixelSize'
import { citationKeyStem } from '../src/lib/citeKey'
import {
  SORT_KEYS,
  DEFAULT_SORT,
  SORT_LABEL,
  SORT_DIR_TEXT,
  SORT_DEFAULT_DIR,
  TITLE_ORDER,
  normaliseSort,
  sortValue,
  compareDocs,
  COLUMNS,
  COL_BY_KEY,
  DEFAULT_COLS,
  normaliseCols,
  migrateCols,
  clampColWidth,
  gridTemplate
} from '../src/lib/columns'
import { continuousPageTop } from '../src/lib/continuousScroll'
import {
  valueForDocument,
  createDocumentScope,
  createDocumentLoad
} from '../src/lib/documentScope'
import { pickKeeper, findDuplicates } from '../src/lib/dupes'
import { bibtexType, risType, hasJournalField } from '../src/lib/exportTypes'
import { LIST_FILTERS, FILTER_LABEL, FILTER_TEST } from '../src/lib/filters'
import { answerHits, answerBusy, createFindScan } from '../src/lib/findScan'
import { createFlashMessage } from '../src/lib/flash'
import { folderForOpenedDoc } from '../src/lib/folderForDoc'
import { answerFor, createLatestSearch } from '../src/lib/latestSearch'
import { createLazyPages } from '../src/lib/lazyPages'
import { isListBlank } from '../src/lib/listBlank'
import { markAll, snippet, authorParts, matchDoc } from '../src/lib/match'
import { commitPageBudget } from '../src/lib/pageBudgetCommit'
import { createPageWalk, PAGE_BATCH_SIZE } from '../src/lib/pageWalk'
import { clampNum, clampLeft, clampRight, DEFAULT_LEFT_W, LEFT_MIN, LEFT_MAX } from '../src/lib/panes'
import {
  PALETTE,
  MIN_SCALE,
  MAX_SCALE,
  clampScale,
  flattenOutline,
  fromCloudPositions,
  posToRect,
  rectToPos,
  bitmapKey
} from '../src/lib/pdfgeom'
import { mergeRectsIntoLines } from '../src/lib/rectLines'
import {
  isRefHead,
  entryNo,
  looksLikeRef,
  citeNums,
  markersIn,
  parseRefEntries,
  linesOf,
  refIds,
  idIndex,
  docByIds,
  docForRef,
  docForUrl
} from '../src/lib/refly'
import { savedSearchMatches } from '../src/lib/savedSearch'
import { splitPersonName } from '../src/lib/splitPersonName'
import { byName, buildTree, isSelfOrDescendant } from '../src/lib/tree'
import { createViewGeneration } from '../src/lib/viewGeneration'
import { docsWithAllWords } from '../shared/wordCoverage'
import { createBatchGate } from '../src/lib/batchGate'
import { noteForSelection } from '../src/lib/annotationNote'
import { GAP, spotFor, createCardSpotter } from '../src/lib/cardSpot'
import {
  CITE_STYLES,
  DEFAULT_CITE_STYLE,
  isCiteStyle,
  formatCitation
} from '../src/lib/cite'
import { describeSyncFailure } from '../src/lib/offline'
import {
  FIND_QUERY_DEBOUNCE_MS,
  FULL_TEXT_QUERY_DEBOUNCE_MS,
  COLUMN_WIDTH_PERSIST_DEBOUNCE_MS,
  PANE_WIDTH_PERSIST_DEBOUNCE_MS,
  EXPORT_LIBRARY_MESSAGE_VISIBLE_MS,
  UPDATE_INSTALL_DELAY_MS,
  HIGHLIGHT_UNDO_WINDOW_MS
} from '../src/lib/timing'
import { PrefetchCache, StaleFlight } from '../src/lib/pdfcache'
import {
  mergeCloudAnnotations,
  applyMergedAnnotations,
  markPushed
} from '../src/lib/annotationMerge'

/* ---------- small deterministic helpers (no real time, no globals) ---------- */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flush every queued microtask without depending on setImmediate. */
const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0))

/** Injected clock: timers only fire when the test says so. */
class ManualClock {
  private next = 0
  private jobs = new Map<number, () => void>()

  set(fn: () => void, _ms: number): number {
    const handle = ++this.next
    this.jobs.set(handle, fn)
    return handle
  }

  clear(handle: unknown): void {
    this.jobs.delete(handle as number)
  }

  pending(): number {
    return this.jobs.size
  }

  fireAll(): void {
    const jobs = [...this.jobs.values()]
    this.jobs.clear()
    for (const fn of jobs) fn()
  }

  fireNext(): boolean {
    const first = this.jobs.keys().next()
    if (first.done) return false
    const fn = this.jobs.get(first.value)!
    this.jobs.delete(first.value)
    fn()
    return true
  }
}

const doc = (o: Partial<Doc> = {}): Doc => ({ id: 'd', ...o })
const folder = (o: Partial<Folder> = {}): Folder => ({ id: 'f', name: 'F', ...o })
const pos = (o: Partial<PdfPos> = {}): PdfPos => ({ page: 1, x: 0, y: 0, w: 1, h: 1, ...o })
const ann = (o: Partial<Annotation> = {}): Annotation => ({
  id: 'a',
  docId: 'd',
  page: 1,
  type: 'highlight',
  color: '#ffe066',
  rects: [],
  created: '2020',
  ...o
})
const cloud = (o: Partial<CloudAnnotation> = {}): CloudAnnotation => ({
  id: 'c',
  document_id: 'd',
  type: 'highlight',
  ...o
})
const author = (o: Partial<Author> = {}): Author => o
const outlineNode = (title: string, items: OutlineNode[] = []): OutlineNode =>
  ({ title, items } as unknown as OutlineNode)

/* ==================================================================== */

describe('bitmapPixelSize: device-pixel sizing is one shared rule', () => {
  it('devicePixelRatioOrOne falls back to 1 for 0, NaN and missing-ish values', () => {
    expect(devicePixelRatioOrOne(0)).toBe(1)
    expect(devicePixelRatioOrOne(NaN)).toBe(1)
    expect(devicePixelRatioOrOne(Number(undefined))).toBe(1)
  })

  it('devicePixelRatioOrOne passes a finite ratio through unchanged', () => {
    expect(devicePixelRatioOrOne(2)).toBe(2)
    expect(devicePixelRatioOrOne(1.5)).toBe(1.5)
  })

  it('bitmapPixelSize truncates both dimensions down', () => {
    expect(bitmapPixelSize({ width: 100.9, height: 50.5 }, 2)).toEqual({ width: 201, height: 101 })
  })

  it('bitmapPixelSize propagates a non-finite viewport rather than inventing a size', () => {
    const r = bitmapPixelSize({ width: NaN, height: 10 }, 2)
    expect(Number.isNaN(r.width)).toBe(true)
    expect(r.height).toBe(20)
  })
})

describe('citeKey: the citation-key stem is shared by paste and export', () => {
  it('lowercases an ASCII surname and appends a finite year', () => {
    expect(citationKeyStem('Smith', 2023)).toBe('smith2023')
  })

  it('keeps CJK surname characters so both callers agree', () => {
    expect(citationKeyStem('张三', 2023)).toBe('张三2023')
  })

  it('drops punctuation and digits and falls back to anon', () => {
    expect(citationKeyStem("O'Brien", 2001)).toBe('obrien2001')
    expect(citationKeyStem('123', 2001)).toBe('anon2001')
  })

  it('omits the year when it is NaN, Infinity or absent', () => {
    expect(citationKeyStem('Smith', NaN)).toBe('smith')
    expect(citationKeyStem('Smith', Infinity)).toBe('smith')
    expect(citationKeyStem('Smith', undefined)).toBe('smith')
  })

  it('uses anon for an empty or non-letter surname', () => {
    expect(citationKeyStem('', undefined)).toBe('anon')
    expect(citationKeyStem('!!!', 1999)).toBe('anon1999')
  })
})

describe('columns: sort, columns and widths are normalised by one registry', () => {
  it('SORT_KEYS lists exactly the seven sortable keys and the default is year descending', () => {
    expect(SORT_KEYS).toHaveLength(7)
    expect(DEFAULT_SORT).toEqual({ key: 'year', dir: -1 })
  })

  it('SORT_LABEL, SORT_DIR_TEXT and SORT_DEFAULT_DIR cover every sort key', () => {
    for (const k of SORT_KEYS) {
      expect(typeof SORT_LABEL[k]).toBe('string')
      expect(SORT_DIR_TEXT[k]).toHaveLength(2)
      expect(SORT_DEFAULT_DIR[k] === 1 || SORT_DEFAULT_DIR[k] === -1).toBe(true)
    }
    expect(SORT_DEFAULT_DIR.year).toBe(-1)
    expect(SORT_DEFAULT_DIR.title).toBe(1)
  })

  it('normaliseSort keeps a known key and its direction', () => {
    expect(normaliseSort({ key: 'title', dir: -1 })).toEqual({ key: 'title', dir: -1 })
    expect(normaliseSort({ key: 'year', dir: 1 })).toEqual({ key: 'year', dir: 1 })
  })

  it('normaliseSort coerces any direction other than -1 to ascending', () => {
    expect(normaliseSort({ key: 'authors', dir: 0 })).toEqual({ key: 'authors', dir: 1 })
    expect(normaliseSort({ key: 'authors', dir: undefined })).toEqual({ key: 'authors', dir: 1 })
    expect(normaliseSort({ key: 'authors', dir: 'x' })).toEqual({ key: 'authors', dir: 1 })
  })

  it('normaliseSort rejects unknown keys and non-objects with the default', () => {
    expect(normaliseSort({ key: 'bogus', dir: -1 })).toEqual(DEFAULT_SORT)
    expect(normaliseSort(null)).toEqual(DEFAULT_SORT)
    expect(normaliseSort(undefined)).toEqual(DEFAULT_SORT)
    expect(normaliseSort('title')).toEqual(DEFAULT_SORT)
  })

  it('sortValue lowercases text fields and returns numbers/dates unchanged', () => {
    const d = doc({
      title: 'Deep LEARNING',
      authors: [author({ last_name: 'Zhuang', first_name: 'Ming' })],
      source: 'Nature',
      citation_key: 'KEY2020',
      year: 2020,
      starred: true,
      created: '2020-05-01T00:00:00Z'
    })
    expect(sortValue(d, 'title')).toBe('deep learning')
    expect(sortValue(d, 'authors')).toBe('zhuang ming')
    expect(sortValue(d, 'source')).toBe('nature')
    expect(sortValue(d, 'citation_key')).toBe('key2020')
    expect(sortValue(d, 'starred')).toBe(1)
    expect(sortValue(d, 'created')).toBe('2020-05-01T00:00:00Z')
    expect(sortValue(d, 'year')).toBe(2020)
    expect(sortValue(doc({}), 'year')).toBe(0)
  })

  it('compareDocs honours the direction for numeric keys', () => {
    const a = doc({ id: 'a', title: 'A', year: 2000 })
    const b = doc({ id: 'b', title: 'B', year: 2010 })
    expect(compareDocs(a, b, 'year', 1)).toBeLessThan(0)
    expect(compareDocs(a, b, 'year', -1)).toBeGreaterThan(0)
  })

  it('compareDocs falls back to the title collator when sort values tie', () => {
    const zebra = doc({ id: 'a', title: 'Zebra', year: 2000 })
    const apple = doc({ id: 'b', title: 'Apple', year: 2000 })
    expect(compareDocs(zebra, apple, 'year', 1)).toBe(TITLE_ORDER.compare('Zebra', 'Apple'))
    expect(compareDocs(zebra, apple, 'year', 1)).toBeGreaterThan(0)
  })

  it('COLUMNS and COL_BY_KEY expose every column with its label and track', () => {
    expect(COLUMNS.length).toBeGreaterThanOrEqual(10)
    for (const c of COLUMNS) {
      expect(COL_BY_KEY.get(c.key)).toBe(c)
      expect(typeof c.label).toBe('string')
      expect(typeof c.track).toBe('string')
      expect(typeof c.text).toBe('function')
    }
  })

  it('normaliseCols returns the eight defaults for undefined or empty input', () => {
    expect(DEFAULT_COLS).toHaveLength(8)
    expect(normaliseCols(undefined)).toEqual(DEFAULT_COLS)
    expect(normaliseCols([])).toEqual(DEFAULT_COLS)
  })

  it('normaliseCols drops unknown keys, de-duplicates and enforces registry order', () => {
    expect(normaliseCols(['tags', 'tags', 'bogus', 'title'])).toEqual(['title', 'tags'])
    expect(normaliseCols(['bogus'])).toEqual(DEFAULT_COLS)
  })

  it('migrateCols upgrades a layout equal to the previous default', () => {
    const prev = ['star', 'pdf', 'authors', 'title', 'year', 'source', 'citation_key']
    expect(migrateCols(prev)).toEqual(DEFAULT_COLS)
    expect(migrateCols(prev)).toContain('created')
  })

  it('migrateCols leaves a customised layout alone', () => {
    expect(migrateCols(['title', 'tags'])).toEqual(['title', 'tags'])
    expect(migrateCols(['star', 'title'])).toEqual(['star', 'title'])
  })

  it('clampColWidth uses the per-column floor and the shared max', () => {
    const title = COL_BY_KEY.get('title')!
    const star = COL_BY_KEY.get('star')!
    expect(clampColWidth(title, 10)).toBe(48)
    expect(clampColWidth(title, 9999)).toBe(1000)
    expect(clampColWidth(star, 9999)).toBe(1000)
  })

  it('clampColWidth falls back to the floor for NaN and Infinity', () => {
    const title = COL_BY_KEY.get('title')!
    expect(clampColWidth(title, NaN)).toBe(48)
    expect(clampColWidth(title, Infinity)).toBe(48)
  })

  it('gridTemplate uses dragged widths and keeps a flexible track', () => {
    expect(gridTemplate(['title', 'authors'], { title: 300 })).toBe('300px 1.5fr')
    expect(gridTemplate(['star', 'pdf'])).toBe('24px 26px 1fr')
  })

  it('gridTemplate ignores unknown column keys with a 1fr track', () => {
    const cols: ColKey[] = ['title']
    expect(gridTemplate(cols)).toBe('3.2fr')
  })
})

describe('continuousScroll: page offsets are only answered when every height is known', () => {
  it('page 1 starts at zero regardless of the height table', () => {
    expect(continuousPageTop(1, {}, 1, 10)).toBe(0)
    expect(continuousPageTop(1, {}, 2, 99)).toBe(0)
  })

  it('page n is the sum of h*scale+gap for every page above it', () => {
    expect(continuousPageTop(3, { 1: { h: 100 }, 2: { h: 200 } }, 2, 10)).toBe(620)
    expect(continuousPageTop(2, { 1: { h: 100 } }, 1, 10)).toBe(110)
  })

  it('returns null for a missing or non-finite height', () => {
    expect(continuousPageTop(3, { 1: { h: 100 } }, 1, 10)).toBeNull()
    expect(continuousPageTop(2, { 1: { h: NaN } }, 1, 10)).toBeNull()
    expect(continuousPageTop(2, { 1: undefined }, 1, 10)).toBeNull()
  })

  it('a NaN, zero or negative page number is treated as page 1', () => {
    expect(continuousPageTop(NaN, {}, 1, 10)).toBe(0)
    expect(continuousPageTop(0, {}, 1, 10)).toBe(0)
    expect(continuousPageTop(-3, {}, 1, 10)).toBe(0)
  })
})

describe('documentScope: values are tagged by doc and reads by generation', () => {
  it('valueForDocument returns the value only when the docId matches', () => {
    expect(valueForDocument({ docId: 'a', value: 5 }, 'a')).toBe(5)
    expect(valueForDocument({ docId: 'a', value: 5 }, 'b')).toBeUndefined()
    expect(valueForDocument(null, 'a')).toBeUndefined()
  })

  it('valueForDocument treats an empty array as a real answer', () => {
    expect(valueForDocument({ docId: 'a', value: [] as number[] }, 'a')).toEqual([])
  })

  it('createDocumentScope tracks the current document synchronously', () => {
    const s = createDocumentScope('a')
    expect(s.current()).toBe('a')
    expect(s.isCurrent('a')).toBe(true)
    s.switchTo('b')
    expect(s.current()).toBe('b')
    expect(s.isCurrent('a')).toBe(false)
    expect(s.isCurrent('b')).toBe(true)
  })

  it('createDocumentLoad renders a successful read tagged with its docId', async () => {
    const d = deferred<number>()
    const spy = vi.fn()
    const load = createDocumentLoad<number>(() => d.promise, (s) => spy(s), 0)
    load.start('paper-1')
    d.resolve(42)
    await tick()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ docId: 'paper-1', value: 42 })
  })

  it('createDocumentLoad answers a rejected read with the injected empty value', async () => {
    const d = deferred<number>()
    const spy = vi.fn()
    const load = createDocumentLoad<number>(() => d.promise, (s) => spy(s), -1)
    load.start('p')
    d.reject(new Error('io'))
    await tick()
    expect(spy).toHaveBeenCalledWith({ docId: 'p', value: -1 })
  })

  it('a superseded read cannot render even if it resolves first', async () => {
    const a = deferred<number>()
    const b = deferred<number>()
    const spy = vi.fn()
    const load = createDocumentLoad<number>(
      (id) => (id === 'a' ? a.promise : b.promise),
      (s) => spy(s),
      0
    )
    load.start('a')
    load.start('b')
    a.resolve(1)
    b.resolve(2)
    await tick()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ docId: 'b', value: 2 })
  })

  it('cancel invalidates an in-flight read without rendering', async () => {
    const d = deferred<number>()
    const spy = vi.fn()
    const load = createDocumentLoad<number>(() => d.promise, (s) => spy(s), 0)
    load.start('a')
    load.cancel()
    d.resolve(9)
    await tick()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('dupes: exact ids first, then fuzzy titles within one year', () => {
  it('pickKeeper selects the most complete record', () => {
    const sparse = doc({ id: 'a', title: 'T' })
    const rich = doc({ id: 'b', title: 'T', abstract: 'A', source: 'S', year: 2020 })
    expect(pickKeeper([sparse, rich])?.id).toBe('b')
  })

  it('pickKeeper breaks a completeness tie with the local PDF', () => {
    const a = doc({ id: 'a', title: 'T' })
    const b = doc({ id: 'b', title: 'T', localPdf: 'file.pdf' })
    expect(pickKeeper([a, b])?.id).toBe('b')
  })

  it('pickKeeper returns undefined for an empty list', () => {
    expect(pickKeeper([])).toBeUndefined()
  })

  it('findDuplicates groups by DOI case-insensitively after trimming', () => {
    const groups = findDuplicates([
      doc({ id: 'a', doi: ' 10.1/X ' }),
      doc({ id: 'b', doi: '10.1/x' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].reason).toBe('doi')
    expect(groups[0].key).toBe('doi:10.1/x')
    expect(groups[0].docs.map((d) => d.id)).toEqual(['a', 'b'])
  })

  it('findDuplicates ranks DOI over arXiv over title', () => {
    const groups = findDuplicates([
      doc({ id: 'a', doi: 'D', arxiv: 'A', title: 'T' }),
      doc({ id: 'b', doi: 'd', arxiv: 'A2', title: 'T2' })
    ])
    expect(groups.map((g) => g.reason)).toEqual(['doi'])
  })

  it('findDuplicates groups by arXiv id and by normalised title', () => {
    const groups = findDuplicates([
      doc({ id: 'a', arxiv: '2103.14030' }),
      doc({ id: 'b', arxiv: '2103.14030' }),
      doc({ id: 'c', title: 'Exact Same Title' }),
      doc({ id: 'd', title: 'Exact Same Title' })
    ])
    expect(groups.map((g) => g.reason).sort()).toEqual(['arxiv', 'title'])
  })

  it('findDuplicates fuzzy-clusters near-identical titles in the same year', () => {
    const groups = findDuplicates([
      doc({ id: 'a', title: 'On the Origin of Species by Means', year: 1859 }),
      doc({ id: 'b', title: 'On the Origin of Species by Mean', year: 1859 })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].key.startsWith('fuzzy:')).toBe(true)
  })

  it('findDuplicates does not fuzzy-cluster titles from different years', () => {
    const groups = findDuplicates([
      doc({ id: 'a', title: 'On the Origin of Species by Means', year: 1859 }),
      doc({ id: 'b', title: 'On the Origin of Species by Mean', year: 1860 })
    ])
    expect(groups).toHaveLength(0)
  })

  it('findDuplicates returns nothing for an empty library', () => {
    expect(findDuplicates([])).toEqual([])
  })

  it('findDuplicates sorts groups by size descending', () => {
    const groups = findDuplicates([
      doc({ id: 'a', doi: 'X' }),
      doc({ id: 'b', doi: 'X' }),
      doc({ id: 'c', doi: 'X' }),
      doc({ id: 'd', doi: 'Y' }),
      doc({ id: 'e', doi: 'Y' })
    ])
    expect(groups.map((g) => g.docs.length)).toEqual([3, 2])
  })
})

describe('exportTypes: one Mendeley-to-BibTeX/RIS table', () => {
  it('maps a journal article to article/JOUR', () => {
    expect(bibtexType(doc({ type: 'journal' }))).toBe('article')
    expect(risType(doc({ type: 'journal' }))).toBe('JOUR')
  })

  it('maps book and patent to their own names', () => {
    expect(bibtexType(doc({ type: 'book' }))).toBe('book')
    expect(risType(doc({ type: 'book' }))).toBe('BOOK')
    expect(bibtexType(doc({ type: 'patent' }))).toBe('misc')
    expect(risType(doc({ type: 'patent' }))).toBe('PAT')
  })

  it('an unknown or missing type falls back to misc/GEN', () => {
    expect(bibtexType(doc({ type: 'weird' }))).toBe('misc')
    expect(risType(doc({}))).toBe('GEN')
  })

  it('hasJournalField is true only for journal-like types', () => {
    expect(hasJournalField(doc({ type: 'journal' }))).toBe(true)
    expect(hasJournalField(doc({ type: 'magazine_article' }))).toBe(true)
    expect(hasJournalField(doc({ type: 'newspaper_article' }))).toBe(true)
    expect(hasJournalField(doc({ type: 'book' }))).toBe(false)
    expect(hasJournalField(doc({}))).toBe(false)
  })
})

describe('filters: the five list switches are ANDed together', () => {
  it('LIST_FILTERS and FILTER_LABEL cover exactly the five switches', () => {
    expect(LIST_FILTERS).toEqual(['star', 'unread', 'nopdf', 'cloud', 'unfiled'])
    for (const k of LIST_FILTERS) expect(typeof FILTER_LABEL[k]).toBe('string')
  })

  it('each filter passes the document it is meant to isolate', () => {
    expect(FILTER_TEST.star(doc({ starred: true }))).toBe(true)
    expect(FILTER_TEST.unread(doc({ read: false }))).toBe(true)
    expect(FILTER_TEST.unread(doc({}))).toBe(true)
    expect(FILTER_TEST.nopdf(doc({}))).toBe(true)
    expect(FILTER_TEST.cloud(doc({ file_attached: true }))).toBe(true)
    expect(FILTER_TEST.unfiled(doc({}))).toBe(true)
    expect(FILTER_TEST.unfiled(doc({ folder_uuids: [] }))).toBe(true)
  })

  it('each filter rejects a document that does not qualify', () => {
    expect(FILTER_TEST.star(doc({}))).toBe(false)
    expect(FILTER_TEST.unread(doc({ read: true }))).toBe(false)
    expect(FILTER_TEST.nopdf(doc({ localPdf: 'p' }))).toBe(false)
    expect(FILTER_TEST.cloud(doc({}))).toBe(false)
    expect(FILTER_TEST.cloud(doc({ file_attached: true, localPdf: 'p' }))).toBe(false)
    expect(FILTER_TEST.unfiled(doc({ folder_uuids: ['f'] }))).toBe(false)
  })
})

describe('findScan: answers and the spinner belong to the word being scanned', () => {
  it('answerHits returns hits only for the matching question', () => {
    const ans = { question: 'a', hits: [1, 2], done: true }
    expect(answerHits(ans, 'a')).toEqual([1, 2])
    expect(answerHits(ans, 'b')).toBeNull()
    expect(answerHits(null, 'a')).toBeNull()
  })

  it('answerHits treats an empty hit list as a real answer', () => {
    expect(answerHits({ question: 'a', hits: [], done: true }, 'a')).toEqual([])
  })

  it('answerBusy is true only for a matching, unfinished question', () => {
    expect(answerBusy({ question: 'a', hits: [], done: false }, 'a')).toBe(true)
    expect(answerBusy({ question: 'a', hits: [], done: true }, 'a')).toBe(false)
    expect(answerBusy({ question: 'a', hits: [], done: false }, 'b')).toBe(false)
    expect(answerBusy(null, 'a')).toBe(false)
  })

  it('createFindScan publishes an empty busy answer, incremental hits and a finish', () => {
    const spy = vi.fn()
    const onFinish = vi.fn()
    const fs = createFindScan<string, number>((a) => spy(a), (q, h) => onFinish(q, h))
    const s = fs.start('word')
    s.publish([1])
    s.finish([1, 2])
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy).toHaveBeenNthCalledWith(1, { question: 'word', hits: [], done: false })
    expect(spy).toHaveBeenNthCalledWith(3, { question: 'word', hits: [1, 2], done: true })
    expect(onFinish).toHaveBeenCalledWith('word', [1, 2])
  })

  it('a superseded scan cannot publish, finish or keep the spinner alive', () => {
    const spy = vi.fn()
    const fs = createFindScan<string, number>((a) => spy(a), () => undefined)
    const old = fs.start('a')
    const fresh = fs.start('b')
    old.publish([9])
    old.finish([9])
    expect(old.alive()).toBe(false)
    expect(fresh.alive()).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenLastCalledWith({ question: 'b', hits: [], done: false })
  })

  it('cancel invalidates the current scan without writing anything', () => {
    const spy = vi.fn()
    const fs = createFindScan<string, number>((a) => spy(a), () => undefined)
    const s = fs.start('a')
    fs.cancel()
    s.finish([1])
    expect(s.alive()).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('flash: one value and one pending clear at a time', () => {
  it('flash shows the value and clears it when the injected clock fires', () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const fm = createFlashMessage<string>((v) => spy(v), clock)
    fm.flash('copied', 100)
    expect(fm.hasPending()).toBe(true)
    clock.fireAll()
    expect(spy).toHaveBeenNthCalledWith(1, 'copied')
    expect(spy).toHaveBeenNthCalledWith(2, null)
    expect(fm.hasPending()).toBe(false)
  })

  it('showing a second value cancels the earlier clear', () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const fm = createFlashMessage<string>((v) => spy(v), clock)
    fm.flash('a', 100)
    fm.flash('b', 100)
    expect(clock.pending()).toBe(1)
    clock.fireAll()
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy).toHaveBeenNthCalledWith(3, null)
  })

  it('show cancels a pending clear and leaves the value up', () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const fm = createFlashMessage<string>((v) => spy(v), clock)
    fm.flash('a', 100)
    fm.show('progress')
    expect(clock.pending()).toBe(0)
    clock.fireAll()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenLastCalledWith('progress')
  })

  it('keep cancels the pending clear without rendering', () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const fm = createFlashMessage<string>((v) => spy(v), clock)
    fm.flash('a', 100)
    fm.keep()
    expect(fm.hasPending()).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('hold schedules a clear of whatever is already on screen', () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const fm = createFlashMessage<string>((v) => spy(v), clock)
    fm.show('card')
    fm.hold(50)
    expect(fm.hasPending()).toBe(true)
    clock.fireAll()
    expect(spy).toHaveBeenLastCalledWith(null)
  })

  it('clear takes the value down now and cancels its pending clear', () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const fm = createFlashMessage<string>((v) => spy(v), clock)
    fm.flash('a', 100)
    fm.clear()
    expect(fm.hasPending()).toBe(false)
    expect(spy).toHaveBeenLastCalledWith(null)
    clock.fireAll()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('dispose cancels the pending clear without rendering', () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const fm = createFlashMessage<string>((v) => spy(v), clock)
    fm.flash('a', 100)
    fm.dispose()
    expect(fm.hasPending()).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('folderForDoc: pick the folder a paper was opened from', () => {
  it('a paper in no folder clears the folder', () => {
    expect(folderForOpenedDoc(doc({ folder_uuids: [] }), 'f', [folder()])).toBeNull()
    expect(folderForOpenedDoc(undefined, 'f', [])).toBeNull()
  })

  it('a paper already inside the current folder leaves the folder alone', () => {
    expect(folderForOpenedDoc(doc({ folder_uuids: ['f', 'g'] }), 'g', [folder({ id: 'g' })])).toBe('g')
  })

  it('picks the first folder id that still exists', () => {
    expect(
      folderForOpenedDoc(doc({ folder_uuids: ['gone', 'f', 'g'] }), null, [
        folder({ id: 'f' }),
        folder({ id: 'g', name: 'G' })
      ])
    ).toBe('f')
  })

  it('a folder id the library no longer has is skipped', () => {
    expect(folderForOpenedDoc(doc({ folder_uuids: ['gone'] }), 'f', [folder()])).toBeNull()
  })
})

describe('latestSearch: debounce plus generation guards against stale answers', () => {
  it('answerFor returns the result only for the matching question', () => {
    const ans = { question: 'a', result: ['x'] as string[] }
    expect(answerFor(ans, 'a')).toEqual(['x'])
    expect(answerFor(ans, 'b')).toBeNull()
    expect(answerFor(null, 'a')).toBeNull()
  })

  it('answerFor distinguishes an empty result from no answer', () => {
    expect(answerFor({ question: 'a', result: [] as string[] }, 'a')).toEqual([])
    expect(answerFor({ question: 'a', result: [] as string[] }, 'b')).toBeNull()
  })

  it('ask waits for the injected clock and exposes the pending timer', () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const ls = createLatestSearch<string, string>(() => Promise.resolve('r'), (a) => spy(a), 'E', clock)
    expect(ls.hasPendingTimer()).toBe(false)
    ls.ask('q', 250)
    expect(ls.hasPendingTimer()).toBe(true)
    expect(clock.pending()).toBe(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a second ask supersedes the first and drops its timer', () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    let runCount = 0
    const ls = createLatestSearch<string, string>(
      () => {
        runCount++
        return Promise.resolve('r' + runCount)
      },
      (a) => spy(a),
      'E',
      clock
    )
    ls.ask('one', 250)
    ls.ask('two', 250)
    expect(clock.pending()).toBe(1)
    clock.fireAll()
    return tick().then(async () => {
      expect(runCount).toBe(1)
      expect(spy).toHaveBeenCalledWith({ question: 'two', result: 'r1' })
      await tick()
    })
  })

  it('only the current generation may deliver an answer', async () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const first = deferred<string>()
    const second = deferred<string>()
    let n = 0
    const ls = createLatestSearch<string, string>(
      () => (n++ === 0 ? first.promise : second.promise),
      (a) => spy(a),
      'E',
      clock
    )
    ls.ask('one', 250)
    clock.fireAll()
    ls.ask('two', 250)
    clock.fireAll()
    first.resolve('OLD')
    second.resolve('NEW')
    await tick()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ question: 'two', result: 'NEW' })
  })

  it('cancel drops the timer and renders nothing', async () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const d = deferred<string>()
    const ls = createLatestSearch<string, string>(() => d.promise, (a) => spy(a), 'E', clock)
    ls.ask('q', 250)
    clock.fireAll()
    ls.cancel()
    d.resolve('late')
    await tick()
    expect(ls.hasPendingTimer()).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a rejected lookup still renders the injected empty answer', async () => {
    const clock = new ManualClock()
    const spy = vi.fn()
    const d = deferred<string>()
    const ls = createLatestSearch<string, string>(() => d.promise, (a) => spy(a), 'FALLBACK', clock)
    ls.ask('q', 10)
    clock.fireAll()
    d.reject(new Error('network'))
    await tick()
    expect(spy).toHaveBeenCalledWith({ question: 'q', result: 'FALLBACK' })
  })
})

describe('lazyPages: one read per page per document generation', () => {
  it('read renders the loaded value tagged with doc and page', async () => {
    const d = deferred<number>()
    const spy = vi.fn()
    const lp = createLazyPages<string, number>((a) => spy(a), -1)
    lp.read('doc', 1, () => d.promise)
    expect(lp.isBusy(1)).toBe(true)
    d.resolve(10)
    await tick()
    expect(spy).toHaveBeenCalledWith({ doc: 'doc', page: 1, value: 10 })
    expect(lp.isBusy(1)).toBe(false)
  })

  it('a second read of a busy page starts no second load', async () => {
    const d = deferred<number>()
    const second = deferred<number>()
    const spy = vi.fn()
    const lp = createLazyPages<string, number>((a) => spy(a), -1)
    lp.read('doc', 1, () => d.promise)
    lp.read('doc', 1, () => second.promise)
    d.resolve(1)
    second.resolve(2)
    await tick()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a rejected read renders the fallback value', async () => {
    const d = deferred<number>()
    const spy = vi.fn()
    const lp = createLazyPages<string, number>((a) => spy(a), -1)
    lp.read('doc', 2, () => d.promise)
    d.reject(new Error('io'))
    await tick()
    expect(spy).toHaveBeenCalledWith({ doc: 'doc', page: 2, value: -1 })
  })

  it('invalidate bumps the generation and clears every busy slot', () => {
    const d = deferred<number>()
    const lp = createLazyPages<string, number>(() => undefined, -1)
    lp.read('doc', 1, () => d.promise)
    expect(lp.isBusy(1)).toBe(true)
    lp.invalidate()
    expect(lp.isBusy(1)).toBe(false)
  })

  it('a read that settles after invalidate cannot render', async () => {
    const d = deferred<number>()
    const spy = vi.fn()
    const lp = createLazyPages<string, number>((a) => spy(a), -1)
    lp.read('doc', 1, () => d.promise)
    lp.invalidate()
    d.resolve(5)
    await tick()
    expect(spy).not.toHaveBeenCalled()
  })

  it('after invalidate a fresh read of the same page is allowed again', async () => {
    const d1 = deferred<number>()
    const d2 = deferred<number>()
    const spy = vi.fn()
    const lp = createLazyPages<string, number>((a) => spy(a), -1)
    lp.read('doc', 1, () => d1.promise)
    lp.invalidate()
    lp.read('doc2', 1, () => d2.promise)
    d2.resolve(7)
    await tick()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ doc: 'doc2', page: 1, value: 7 })
  })
})

describe('listBlank: a click outside every row drops the selection', () => {
  it('a null or non-element target is blank', () => {
    expect(isListBlank(null, 'row')).toBe(true)
    expect(isListBlank(undefined, 'row')).toBe(true)
    expect(isListBlank(42, 'row')).toBe(true)
  })

  it('an object without closest is blank', () => {
    expect(isListBlank({}, 'row')).toBe(true)
    expect(isListBlank({ closest: 1 }, 'row')).toBe(true)
  })

  it('closest returning an element means the click is on a row', () => {
    expect(isListBlank({ closest: () => ({ tag: 'div' }) }, 'row')).toBe(false)
  })

  it('closest returning null means the click is in blank space', () => {
    expect(isListBlank({ closest: () => null }, 'row')).toBe(true)
  })
})

describe('match: every occurrence is marked and only matching fields are shown', () => {
  it('markAll marks every occurrence of the query', () => {
    expect(markAll('aXaXa', 'x')).toEqual([
      { t: 'a', hit: false },
      { t: 'X', hit: true },
      { t: 'a', hit: false },
      { t: 'X', hit: true },
      { t: 'a', hit: false }
    ])
  })

  it('markAll returns one non-hit part when nothing matches', () => {
    expect(markAll('abc', 'z')).toEqual([{ t: 'abc', hit: false }])
  })

  it('markAll with an empty query returns the whole text unmarked', () => {
    expect(markAll('abc', '')).toEqual([{ t: 'abc', hit: false }])
  })

  it('markAll folds Unicode case back onto a single source character', () => {
    expect(markAll('İstanbul', 'i')).toEqual([
      { t: 'İ', hit: true },
      { t: 'stanbul', hit: false }
    ])
  })

  it('snippet returns null for an empty field or a missing query', () => {
    expect(snippet('', 'q')).toBeNull()
    expect(snippet('hello world', '')).toBeNull()
    expect(snippet('hello world', 'zzz')).toBeNull()
  })

  it('snippet cuts a window around the match with ellipses', () => {
    expect(snippet('the quick brown fox jumps', 'quick', 3, 5)).toEqual([
      { t: '…', hit: false },
      { t: 'he ', hit: false },
      { t: 'quick', hit: true },
      { t: ' brow', hit: false },
      { t: '…', hit: false }
    ])
  })

  it('snippet keeps Unicode case folding when slicing the window', () => {
    expect(snippet('İstanbul is nice', 'i', 2, 3)).toEqual([
      { t: 'İ', hit: true },
      { t: 'sta', hit: false },
      { t: '…', hit: false }
    ])
  })

  it('authorParts draws a window around the matched author using the full name', () => {
    const d = doc({
      authors: [
        author({ first_name: 'John', last_name: 'Smith' }),
        author({ first_name: 'Anna', last_name: 'Jones' }),
        author({ first_name: 'Wei', last_name: 'Zhang' }),
        author({ first_name: 'Chun', last_name: 'Li' })
      ]
    })
    expect(authorParts(d, 'Chun')).toEqual([
      { t: '… ', hit: false },
      { t: 'Zhang W, ', hit: false },
      { t: 'Chun', hit: true },
      { t: ' Li', hit: false }
    ])
  })

  it('authorParts shows the first three authors when none matched', () => {
    const d = doc({
      authors: [
        author({ first_name: 'John', last_name: 'Smith' }),
        author({ first_name: 'Anna', last_name: 'Jones' }),
        author({ first_name: 'Wei', last_name: 'Zhang' }),
        author({ first_name: 'Bo', last_name: 'Wang' })
      ]
    })
    const parts = authorParts(d, 'zzz')
    expect(parts.map((p) => p.t).join('')).toContain('等 4 人')
    expect(parts.every((p) => !p.hit)).toBe(true)
  })

  it('matchDoc always marks the title and lists only fields containing the query', () => {
    const d = doc({
      title: 'T',
      source: 'Nature 2020',
      citation_key: 'k2020',
      abstract: 'A nature abstract',
      keywords: ['nature'],
      tags: ['x'],
      type: 'journal',
      doi: '10.1234/abc'
    })
    const m = matchDoc(d, 'nature')
    expect(m.title).toEqual([{ t: 'T', hit: false }])
    expect(m.fields.map((f) => f.label)).toEqual(['出处', '摘要', '关键词'])
    expect(m.source).toBe('Nature 2020')
    expect(m.year).toBe('')
  })

  it('matchDoc with an empty query exposes no matched fields', () => {
    expect(matchDoc(doc({ title: 'T', abstract: 'A' }), '').fields).toHaveLength(0)
  })
})

describe('pageBudgetCommit: the shown number is always the applied number', () => {
  it('a valid value within the range is applied unchanged', () => {
    expect(commitPageBudget('7')).toEqual({ shown: '7', applied: 7 })
  })

  it('a value above the max is clamped to 50', () => {
    expect(commitPageBudget('100')).toEqual({ shown: '50', applied: 50 })
  })

  it('a value below the minimum falls back to the default 3', () => {
    expect(commitPageBudget('0')).toEqual({ shown: '3', applied: 3 })
  })

  it('empty, NaN, non-numeric and Infinity inputs fall back to the default', () => {
    for (const raw of ['', 'abc', 'Infinity', 'NaN', '-5']) {
      expect(commitPageBudget(raw)).toEqual({ shown: '3', applied: 3 })
    }
  })

  it('shown always equals String(applied) for every input', () => {
    for (const raw of ['', '1', '50.9', '999', 'abc']) {
      const r = commitPageBudget(raw)
      expect(r.shown).toBe(String(r.applied))
    }
  })
})

describe('pageWalk: ordered reads published in bounded batches', () => {
  const host = () => {
    const claimed = new Set<number>()
    const published: Record<number, number[]>[] = []
    let dead = false
    return {
      claimed,
      published,
      setDead: (v: boolean) => {
        dead = v
      },
      api: {
        isDead: () => dead,
        isClaimed: (n: number) => claimed.has(n),
        claim: (n: number) => claimed.add(n),
        release: (n: number) => claimed.delete(n),
        publish: (b: Record<number, number[]>) => published.push(b)
      }
    }
  }

  it('publishes one batch of eight and one short leftover batch for ten pages', async () => {
    const h = host()
    const pw = createPageWalk<number>(h.api)
    await pw.walk(10, (n) => Promise.resolve([n]))
    expect(PAGE_BATCH_SIZE).toBe(8)
    expect(h.published).toHaveLength(2)
    expect(Object.keys(h.published[0])).toHaveLength(8)
    expect(Object.keys(h.published[1])).toEqual(['9', '10'])
  })

  it('a walk of zero pages publishes nothing', async () => {
    const h = host()
    await createPageWalk<number>(h.api).walk(0, () => Promise.resolve([1]))
    expect(h.published).toHaveLength(0)
  })

  it('claimed pages are skipped and their short batch still flushes at the end', async () => {
    const h = host()
    h.claimed.add(1)
    h.claimed.add(2)
    const pw = createPageWalk<number>(h.api)
    await pw.walk(3, (n) => Promise.resolve([n]))
    expect(h.published).toHaveLength(1)
    expect(Object.keys(h.published[0])).toEqual(['3'])
  })

  it('a failed page read becomes an empty result instead of aborting', async () => {
    const h = host()
    const pw = createPageWalk<number>(h.api)
    await pw.walk(2, (n) => (n === 1 ? Promise.reject(new Error('x')) : Promise.resolve([n])))
    expect(h.published[0]).toEqual({ 1: [], 2: [2] })
  })

  it('a dead host stops the walk before publishing anything', async () => {
    const h = host()
    const d = deferred<number[]>()
    const pw = createPageWalk<number>(h.api)
    const p = pw.walk(3, () => d.promise)
    h.setDead(true)
    d.resolve([1])
    await p
    expect(h.published).toHaveLength(0)
  })

  it('claimed pages stay claimed by the caller and are released after a read', async () => {
    const h = host()
    const pw = createPageWalk<number>(h.api)
    await pw.walk(2, (n) => Promise.resolve([n]))
    expect(h.claimed.size).toBe(0)
  })
})

describe('panes: dragged widths are clamped and rounded', () => {
  it('clampNum keeps finite values and uses the lower bound for NaN', () => {
    expect(clampNum(5, 1, 10)).toBe(5)
    expect(clampNum(-1, 1, 10)).toBe(1)
    expect(clampNum(99, 1, 10)).toBe(10)
    expect(clampNum(NaN, 1, 10)).toBe(1)
  })

  it('clampLeft rounds to an integer within LEFT_MIN..LEFT_MAX', () => {
    expect(clampLeft(10)).toBe(LEFT_MIN)
    expect(clampLeft(999)).toBe(LEFT_MAX)
    expect(clampLeft(240.6)).toBe(241)
    expect(DEFAULT_LEFT_W).toBe(240)
  })

  it('clampRight keeps one decimal place', () => {
    expect(clampRight(33.36)).toBe(33.4)
    expect(clampRight(10)).toBe(22)
    expect(clampRight(99)).toBe(70)
  })

  it('clampRight treats NaN as the lower bound', () => {
    expect(clampRight(NaN)).toBe(22)
  })
})

describe('pdfgeom: conversions between PDF points, page rects and bitmap keys', () => {
  it('the palette and scale bounds are exported as shared constants', () => {
    expect(PALETTE).toHaveLength(5)
    expect(MIN_SCALE).toBe(0.2)
    expect(MAX_SCALE).toBe(6)
  })

  it('clampScale bounds both ends and maps NaN to the minimum', () => {
    expect(clampScale(10)).toBe(MAX_SCALE)
    expect(clampScale(0.1)).toBe(MIN_SCALE)
    expect(clampScale(NaN)).toBe(MIN_SCALE)
    expect(clampScale(1.5)).toBe(1.5)
  })

  it('fromCloudPositions uses min/abs so a reversed corner still measures correctly', () => {
    const c = cloud({
      positions: [
        { top_left: { x: 10, y: 20 }, bottom_right: { x: 5, y: 50 }, page: 2 }
      ]
    })
    expect(fromCloudPositions(c)).toEqual([pos({ page: 2, x: 5, y: 20, w: 5, h: 30 })])
  })

  it('fromCloudPositions returns an empty list for missing positions', () => {
    expect(fromCloudPositions(cloud({}))).toEqual([])
  })

  it('posToRect returns a zero rect for a non-finite or non-positive page size', () => {
    expect(posToRect(pos(), { w: NaN, h: 10 })).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(posToRect(pos(), { w: 0, h: 10 })).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(posToRect(pos(), { w: 100, h: -1 })).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('posToRect flips y to a top-origin normalised rect', () => {
    expect(posToRect(pos({ x: 100, y: 200, w: 50, h: 20 }), { w: 200, h: 400 })).toEqual({
      x: 0.5,
      y: 0.45,
      w: 0.25,
      h: 0.05
    })
  })

  it('rectToPos is the inverse of posToRect', () => {
    const p = rectToPos({ x: 0.5, y: 0.5, w: 0.25, h: 0.05 }, 2, { w: 200, h: 400 })
    expect(p.page).toBe(2)
    expect(p.x).toBe(100)
    expect(p.w).toBe(50)
    expect(p.h).toBe(20)
    expect(p.y).toBeCloseTo(180)
    const back = posToRect(p, { w: 200, h: 400 })
    expect(back.x).toBeCloseTo(0.5)
    expect(back.y).toBeCloseTo(0.5)
  })

  it('bitmapKey formats the scale to three decimals', () => {
    expect(bitmapKey(3, 1.23456, 2)).toBe('3:1.235:2')
  })

  it('flattenOutline walks depth-first recording the depth', () => {
    const rows = flattenOutline([
      outlineNode('A', [outlineNode('A1')]),
      outlineNode('B')
    ])
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0])
    expect(rows.map((r) => (r.node as unknown as { title: string }).title)).toEqual(['A', 'A1', 'B'])
  })

  it('flattenOutline accepts a missing item list', () => {
    expect(flattenOutline([])).toEqual([])
    expect(flattenOutline([outlineNode('X')])).toHaveLength(1)
  })
})

describe('rectLines: one rectangle per line, decided by an injected predicate', () => {
  it('merges fragments on the same line into a single bounding box', () => {
    const rects = [
      { x: 0, y: 0, w: 10, h: 5 },
      { x: 12, y: 0, w: 10, h: 7 },
      { x: 30, y: 0, w: 5, h: 5 }
    ]
    expect(mergeRectsIntoLines(rects, () => true)).toEqual([{ x: 0, y: 0, w: 35, h: 7 }])
  })

  it('keeps fragments on different lines separate', () => {
    const rects = [
      { x: 0, y: 0, w: 10, h: 5 },
      { x: 0, y: 20, w: 10, h: 5 }
    ]
    expect(mergeRectsIntoLines(rects, (l, r) => Math.abs(l.y - r.y) < 3)).toHaveLength(2)
  })

  it('an empty input produces no lines', () => {
    expect(mergeRectsIntoLines([], () => true)).toEqual([])
  })

  it('does not mutate the caller rects', () => {
    const rects = [{ x: 5, y: 0, w: 10, h: 5 }]
    mergeRectsIntoLines(rects, () => true)
    expect(rects[0]).toEqual({ x: 5, y: 0, w: 10, h: 5 })
  })
})

describe('refly: only a consecutive, dated [n] list is believed', () => {
  it('isRefHead recognises the standard headings', () => {
    expect(isRefHead('References')).toBe(true)
    expect(isRefHead('  BIBLIOGRAPHY: ')).toBe(true)
    expect(isRefHead('works cited')).toBe(true)
  })

  it('isRefHead rejects prose and a full-width colon it does not know', () => {
    expect(isRefHead('References: extra text')).toBe(false)
    expect(isRefHead(' 参考文献：')).toBe(false)
    expect(isRefHead('Chapter 1')).toBe(false)
  })

  it('entryNo reads bracketed and dotted numbers but not decimals', () => {
    expect(entryNo('[1] Smith 2020')).toBe(1)
    expect(entryNo('12. Smith 2020')).toBe(12)
    expect(entryNo('1.5 is a decimal')).toBeNull()
    expect(entryNo('plain text')).toBeNull()
  })

  it('looksLikeRef needs a year or a citation marker', () => {
    expect(looksLikeRef('Smith 2020')).toBe(true)
    expect(looksLikeRef('In Proc. CVPR 2019')).toBe(true)
    expect(looksLikeRef('no date at all')).toBe(false)
  })

  it('citeNums expands a range into more than two entries', () => {
    expect(citeNums('[1-3]')).toEqual([1, 2, 3])
    expect(citeNums('(1-3)')).toEqual([1, 2, 3])
  })

  it('citeNums refuses a range longer than twelve', () => {
    expect(citeNums('[1-14]')).toBeNull()
    expect(citeNums('[1-13]')).toHaveLength(13)
  })

  it('citeNums handles a reversed range, de-duplicates and reads lists', () => {
    expect(citeNums('[3-1]')).toEqual([3])
    expect(citeNums('[1,1,2]')).toEqual([1, 2])
    expect(citeNums('[2, 5]')).toEqual([2, 5])
    expect(citeNums('(4)')).toEqual([4])
  })

  it('citeNums returns null for malformed or non-positive markers', () => {
    expect(citeNums('no marker')).toBeNull()
    expect(citeNums('[0]')).toBeNull()
    expect(citeNums('[1,a]')).toBeNull()
  })

  it('markersIn finds every marker with its span and cited numbers', () => {
    expect(markersIn('as shown in [3] and [2, 5] and (1-3)')).toEqual([
      { at: 12, end: 15, nums: [3] },
      { at: 20, end: 26, nums: [2, 5] },
      { at: 31, end: 36, nums: [1, 2, 3] }
    ])
  })

  it('markersIn returns nothing when a line has no marker', () => {
    expect(markersIn('plain prose')).toEqual([])
  })

  it('parseRefEntries needs at least three consecutive entries', () => {
    expect([...parseRefEntries(['[1] A. Nature 2020.', '[2] B. CVPR 2021.'])]).toEqual([])
    expect([...parseRefEntries(['[1] A. Nature 2020.', '[3] C. ACL 2019.', '[4] D. ICCV 2018.'])]).toEqual([])
  })

  it('parseRefEntries refuses a numbered appendix with no years', () => {
    const lines = ['[1] step one do this', '[2] step two do that', '[3] step three finish']
    expect([...parseRefEntries(lines)]).toEqual([])
  })

  it('parseRefEntries joins a hyphen-split word without inserting a space', () => {
    const lines = [
      '[1] A very long inter-',
      'disciplinary study of things. Nature, 2020.',
      '[2] Second entry about vision. CVPR, 2021.',
      '[3] Third entry on language. ACL, 2019.'
    ]
    const entries = parseRefEntries(lines)
    expect(entries.get(1)).toBe('A very long inter-disciplinary study of things. Nature, 2020.')
    expect(entries.size).toBe(3)
  })

  it('linesOf groups runs by baseline and sorts them left to right', () => {
    const rows = linesOf([
      { str: 'B', transform: [0, 0, 0, 0, 200, 100] },
      { str: 'A', transform: [0, 0, 0, 0, 0, 100] }
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('A B')
  })

  it('linesOf inserts a space between words but not before a marker', () => {
    const rows = linesOf([
      { str: 'Back', transform: [0, 0, 0, 0, 0, 100] },
      { str: 'propagation', transform: [0, 0, 0, 0, 50, 100] },
      { str: '[3]', transform: [0, 0, 0, 0, 200, 100] }
    ])
    expect(rows[0].text).toBe('Back propagation[3]')
  })

  it('refIds extracts a trimmed DOI and an explicitly-labelled arXiv id', () => {
    expect(refIds('doi 10.1234/abc, and arXiv:2103.14030 end')).toEqual({
      doi: '10.1234/abc',
      arxiv: '2103.14030'
    })
    expect(refIds('nothing here')).toEqual({ doi: undefined, arxiv: undefined })
  })

  it('idIndex normalises DOIs and lets the first paper win', () => {
    const first = doc({ id: 'first', doi: 'https://doi.org/10.1000/X' })
    const second = doc({ id: 'second', doi: '10.1000/x' })
    const ix = idIndex([first, second])
    expect(ix.doi.get('10.1000/x')).toBe(first)
    expect(docByIds(ix, { doi: '10.1000/X' })).toBe(first)
  })

  it('docByIds matches arXiv ids and returns null for unknown ids', () => {
    const d = doc({ id: 'x', arxiv: '2103.14030' })
    const ix = idIndex([d])
    expect(docByIds(ix, { arxiv: '2103.14030' })).toBe(d)
    expect(docByIds(ix, { doi: '10.1/nope' })).toBeNull()
    expect(docByIds(ix, {})).toBeNull()
  })

  it('docForRef resolves a library paper by the DOI in the entry text', () => {
    const d = doc({ id: 'x', doi: '10.1234/abc' })
    expect(docForRef(idIndex([d]), 'Smith J. A title. 10.1234/abc, 2020.')).toBe(d)
  })

  it('docForUrl cuts query and fragment before reading the identifier', () => {
    const d = doc({ id: 'x', doi: '10.1000/xyz' })
    expect(docForUrl(idIndex([d]), 'https://doi.org/10.1000/xyz/?ref=1#top')).toBe(d)
    expect(docForUrl(idIndex([d]), 'https://example.com/no-id')).toBeNull()
  })
})

describe('savedSearchMatches: one rule drives the name, the count and the list', () => {
  const testFor = (key: string): ((d: { id: string; read?: boolean }) => boolean) | undefined =>
    key === 'unread' ? (d) => !d.read : undefined

  it('rejects a document that is not starred when the search is starred', () => {
    expect(
      savedSearchMatches({ id: 'x' }, { query: '', starred: true }, testFor, new Map(), null)
    ).toBe(false)
  })

  it('ANDs every checked filter through testFor', () => {
    const d = { id: 'x', starred: true, read: false }
    expect(
      savedSearchMatches(d, { query: '', starred: true, filters: ['unread'] }, testFor, new Map(), null)
    ).toBe(true)
    expect(
      savedSearchMatches(
        { ...d, read: true },
        { query: '', starred: true, filters: ['unread'] },
        testFor,
        new Map(),
        null
      )
    ).toBe(false)
  })

  it('restricts to the given folderIds when they are supplied', () => {
    const d = { id: 'x', folder_uuids: ['f'] }
    expect(savedSearchMatches(d, { query: '', starred: false }, testFor, new Map(), new Set(['f']))).toBe(true)
    expect(savedSearchMatches(d, { query: '', starred: false }, testFor, new Map(), new Set(['g']))).toBe(false)
    expect(
      savedSearchMatches({ id: 'x', folder_uuids: null }, { query: '', starred: false }, testFor, new Map(), new Set(['f']))
    ).toBe(false)
  })

  it('trims and lowercases the query before matching a pre-lowercased haystack', () => {
    const hay = new Map([['x', 'deep learning']])
    expect(savedSearchMatches({ id: 'x' }, { query: '  DEEP  ', starred: false }, testFor, hay, null)).toBe(true)
    expect(savedSearchMatches({ id: 'x' }, { query: 'deep', starred: false }, testFor, new Map([['x', 'Deep Learning']]), null)).toBe(false)
  })

  it('a missing haystack entry fails a non-empty query', () => {
    expect(savedSearchMatches({ id: 'x' }, { query: 'word', starred: false }, testFor, new Map(), null)).toBe(false)
  })

  it('an unknown filter key is ignored and an empty search matches everything', () => {
    expect(
      savedSearchMatches({ id: 'x' }, { query: '  ', starred: false, filters: ['nope'] }, testFor, new Map(), null)
    ).toBe(true)
  })
})

describe('splitPersonName: comma means surname-first', () => {
  it('a comma keeps the surname first', () => {
    expect(splitPersonName('Doe, Jane')).toEqual({ last_name: 'Doe', first_name: 'Jane' })
  })

  it('extra commas stay in the given name', () => {
    expect(splitPersonName('Doe, Jane, Q')).toEqual({ last_name: 'Doe', first_name: 'Jane, Q' })
  })

  it('a name without a comma is read surname-last', () => {
    expect(splitPersonName('Jane Doe')).toEqual({ last_name: 'Doe', first_name: 'Jane' })
  })

  it('a single name becomes the surname', () => {
    expect(splitPersonName('Plato')).toEqual({ last_name: 'Plato', first_name: '' })
  })
})

describe('tree: nesting, display order and descendant checks', () => {
  it('byName sorts chapter numbers numerically', () => {
    const names = [folder({ name: '第 10 章' }), folder({ name: '第 2 章' })].sort(byName)
    expect(names.map((f) => f.name)).toEqual(['第 2 章', '第 10 章'])
  })

  it('byName ignores case differences (base sensitivity)', () => {
    expect(byName(folder({ name: 'alpha' }), folder({ name: 'Alpha' }))).toBe(0)
  })

  it('buildTree sorts roots and records children', () => {
    const t = buildTree([
      folder({ id: 'z', name: 'Zulu' }),
      folder({ id: 'a', name: 'Alpha' }),
      folder({ id: 'c', name: 'Child', parent_id: 'a' })
    ])
    expect(t.roots.map((f) => f.id)).toEqual(['a', 'z'])
    expect(t.children.get('a')?.map((f) => f.id)).toEqual(['c'])
    expect(t.orphans).toHaveLength(0)
  })

  it('buildTree lifts folders with a missing parent into roots and orphans', () => {
    const t = buildTree([folder({ id: 'o', name: 'Orphan', parent_id: 'gone' })])
    expect(t.roots.map((f) => f.id)).toEqual(['o'])
    expect(t.orphans.map((f) => f.id)).toEqual(['o'])
  })

  it('buildTree records depth and the self-plus-descendants subtree', () => {
    const t = buildTree([
      folder({ id: 'r', name: 'Root' }),
      folder({ id: 'c1', name: 'Child', parent_id: 'r' }),
      folder({ id: 'c2', name: 'Grand', parent_id: 'c1' })
    ])
    expect(t.depth.get('c2')).toBe(2)
    expect(t.subtree.get('r')).toEqual(['r', 'c1', 'c2'])
    expect(t.subtree.get('c1')).toEqual(['c1', 'c2'])
  })

  it('buildTree does not hang when a folder is its own ancestor', () => {
    const t = buildTree([
      folder({ id: 's', name: 'S' }),
      folder({ id: 's', name: 'S again', parent_id: 's' })
    ])
    expect(t.subtree.get('s')).toEqual(['s'])
    expect(t.depth.get('s')).toBe(0)
  })

  it('isSelfOrDescendant includes the id itself and its descendants only', () => {
    const t = buildTree([
      folder({ id: 'r', name: 'Root' }),
      folder({ id: 'c1', name: 'Child', parent_id: 'r' }),
      folder({ id: 'c2', name: 'Grand', parent_id: 'c1' })
    ])
    expect(isSelfOrDescendant(t, 'r', 'r')).toBe(true)
    expect(isSelfOrDescendant(t, 'r', 'c2')).toBe(true)
    expect(isSelfOrDescendant(t, 'c1', 'r')).toBe(false)
    expect(isSelfOrDescendant(t, 'unknown', 'unknown')).toBe(true)
  })
})

describe('viewGeneration: leaving and coming back still invalidates an old answer', () => {
  it('starts at generation zero with the initial view', () => {
    const vg = createViewGeneration<string>('lib')
    expect(vg.read()).toBe(0)
    expect(vg.view()).toBe('lib')
    expect(vg.still(0)).toBe(true)
  })

  it('setting the same value is idempotent and does not advance the generation', () => {
    const vg = createViewGeneration<string>('lib')
    vg.set('lib')
    expect(vg.read()).toBe(0)
  })

  it('changing the view advances the generation', () => {
    const vg = createViewGeneration<string>('lib')
    const from = vg.read()
    vg.set('reader')
    expect(vg.read()).toBe(1)
    expect(vg.still(from)).toBe(false)
    expect(vg.view()).toBe('reader')
  })

  it('returning to the same value still refuses the answer started before departure', () => {
    const vg = createViewGeneration<string>('lib')
    const from = vg.read()
    vg.set('reader')
    vg.set('lib')
    expect(vg.view()).toBe('lib')
    expect(vg.read()).toBe(2)
    expect(vg.still(from)).toBe(false)
  })

  it('an answer started after the last change is still accepted', () => {
    const vg = createViewGeneration<string>('lib')
    vg.set('reader')
    const from = vg.read()
    expect(vg.still(from)).toBe(true)
  })
})

describe('docsWithAllWords: a set, not a 32-bit mask', () => {
  it('an empty occurrence list yields an empty map', () => {
    expect(docsWithAllWords([], 3).size).toBe(0)
  })

  it('returns a document only when every word is present, with its earliest position', () => {
    const m = docsWithAllWords(
      [
        { docId: 'd1', word: 0, at: 5 },
        { docId: 'd1', word: 1, at: 2 },
        { docId: 'd2', word: 0, at: 9 }
      ],
      2
    )
    expect([...m]).toEqual([['d1', 2]])
  })

  it('de-duplicates repeated words and keeps the smallest at', () => {
    const m = docsWithAllWords(
      [
        { docId: 'd', word: 0, at: 9 },
        { docId: 'd', word: 0, at: 4 },
        { docId: 'd', word: 1, at: 7 }
      ],
      2
    )
    expect(m.get('d')).toBe(4)
  })

  it('a 32-word query can still match (old bitmask boundary)', () => {
    const occ = Array.from({ length: 32 }, (_, w) => ({ docId: 'd', word: w, at: w }))
    expect(docsWithAllWords(occ, 32).get('d')).toBe(0)
  })

  it('a 33-word query matches too, unlike the old 32-bit mask', () => {
    const occ = Array.from({ length: 33 }, (_, w) => ({ docId: 'd', word: w, at: w }))
    expect(docsWithAllWords(occ, 33).get('d')).toBe(0)
  })

  it('a missing word excludes the document', () => {
    const occ = Array.from({ length: 5 }, (_, w) => ({ docId: 'd', word: w, at: w }))
    expect(docsWithAllWords(occ, 6).size).toBe(0)
  })
})

describe('batchGate: only one batch download at a time', () => {
  it('tryStart is true once and false while running', () => {
    const g = createBatchGate()
    expect(g.isRunning()).toBe(false)
    expect(g.tryStart()).toBe(true)
    expect(g.tryStart()).toBe(false)
  })

  it('finish resets the gate so a new batch may start', () => {
    const g = createBatchGate()
    g.tryStart()
    g.finish()
    expect(g.isRunning()).toBe(false)
    expect(g.tryStart()).toBe(true)
  })

  it('finish is safe to call when nothing is running', () => {
    const g = createBatchGate()
    g.finish()
    expect(g.tryStart()).toBe(true)
  })
})

describe('annotationNote: the shown note is derived from the selection', () => {
  it('no selection shows an empty string', () => {
    expect(noteForSelection(null, null)).toBe('')
    expect(noteForSelection(null, { id: 'a', text: 'draft' })).toBe('')
  })

  it('a draft for the selected annotation overrides its saved note', () => {
    expect(noteForSelection({ id: 'a', note: 'saved' }, { id: 'a', text: 'typed' })).toBe('typed')
  })

  it('a draft for another annotation is ignored', () => {
    expect(noteForSelection({ id: 'a', note: 'saved' }, { id: 'b', text: 'typed' })).toBe('saved')
  })

  it('a null note falls back to the empty string', () => {
    expect(noteForSelection({ id: 'a', note: null }, null)).toBe('')
    expect(noteForSelection({ id: 'a' }, null)).toBe('')
  })
})

describe('cardSpot: a fixed card is placed from injected boxes only', () => {
  const anchor = { top: 10, bottom: 50, left: 10, width: 80, height: 40 }
  const card = { top: 0, bottom: 0, left: 0, width: 200, height: 30 }
  const view = { width: 800, height: 600 }

  it('places the card below the anchor with the shared gap', () => {
    expect(GAP).toBe(4)
    expect(spotFor(anchor, card, view)).toEqual({ top: 54, left: 10 })
  })

  it('flips the card above the anchor when there is no room below', () => {
    const low = { ...anchor, top: 560, bottom: 590 }
    const tall = { ...card, height: 100 }
    expect(spotFor(low, tall, view)).toEqual({ top: 456, left: 10 })
  })

  it('clamps the left edge so the card stays inside the viewport', () => {
    const right = { ...anchor, left: 700 }
    expect(spotFor(right, card, view).left).toBe(596)
  })

  it('rounds the computed coordinates', () => {
    const odd = { ...anchor, bottom: 50.6, left: 10.6 }
    expect(spotFor(odd, card, view)).toEqual({ top: 55, left: 11 })
  })

  it('createCardSpotter renders a spot on measure and resize', () => {
    const spy = vi.fn()
    const spotter = createCardSpotter(
      () => ({ anchor, card, view }),
      (s) => spy(s),
      () => undefined
    )
    spotter.measure()
    spotter.resize()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenLastCalledWith({ top: 54, left: 10 })
  })

  it('a missing anchor on first measure renders null, on resize it closes the card', () => {
    const spy = vi.fn()
    const gone = vi.fn()
    const reading = { anchor: null as typeof anchor | null, card: null as typeof card | null, view }
    const spotter = createCardSpotter(() => reading, (s) => spy(s), () => gone())
    spotter.measure()
    expect(spy).toHaveBeenLastCalledWith(null)
    expect(gone).not.toHaveBeenCalled()
    spotter.resize()
    expect(gone).toHaveBeenCalledTimes(1)
  })

  it('a missing card box renders null', () => {
    const spy = vi.fn()
    const spotter = createCardSpotter(
      () => ({ anchor, card: null, view }),
      (s) => spy(s),
      () => undefined
    )
    spotter.measure()
    expect(spy).toHaveBeenLastCalledWith(null)
  })

  it('dispose stops any later measurement from writing', () => {
    const spy = vi.fn()
    const spotter = createCardSpotter(
      () => ({ anchor, card, view }),
      (s) => spy(s),
      () => undefined
    )
    spotter.dispose()
    spotter.measure()
    spotter.resize()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('cite: formatted citations for pasting', () => {
  const d = doc({
    title: 'Deep Learning',
    authors: [
      author({ first_name: 'John', last_name: 'Smith' }),
      author({ first_name: 'Anna', last_name: 'Jones' }),
      author({ first_name: 'Wei', last_name: 'Zhang' }),
      author({ first_name: 'Chun', last_name: 'Li' })
    ],
    year: 2023,
    source: 'Nature'
  })

  it('CITE_STYLES has six entries and the default is author-year', () => {
    expect(CITE_STYLES).toHaveLength(6)
    expect(DEFAULT_CITE_STYLE).toBe('author-year')
  })

  it('isCiteStyle accepts only known style keys', () => {
    expect(isCiteStyle('key')).toBe(true)
    expect(isCiteStyle('bibtex')).toBe(true)
    expect(isCiteStyle('bogus')).toBe(false)
    expect(isCiteStyle(undefined)).toBe(false)
  })

  it('an empty document list produces an empty string', () => {
    expect(formatCitation([], 'author-year')).toBe('')
  })

  it('numeric style numbers documents by their position', () => {
    expect(formatCitation([d, d, d], 'numeric')).toBe('[1], [2], [3]')
  })

  it('author-year, authors, full and key styles are derived from one document', () => {
    expect(formatCitation([d], 'author-year')).toBe('Smith et al. (2023)')
    expect(formatCitation([d], 'authors')).toBe('Smith J., Jones A., Zhang W., Li C.')
    expect(formatCitation([d], 'full')).toContain('Deep Learning')
    expect(formatCitation([d], 'key')).toBe('\\cite{smith2023}')
  })

  it('the default style equals an explicit author-year', () => {
    expect(formatCitation([d])).toBe(formatCitation([d], 'author-year'))
  })

  it('a missing year falls back to n.d.', () => {
    expect(formatCitation([doc({ authors: [] })], 'author-year')).toBe('Anon (n.d.)')
  })

  it('a CJK two-author phrase uses 和 rather than and', () => {
    const cjk = doc({
      authors: [author({ last_name: '张' }), author({ last_name: '李' })],
      year: 2020
    })
    expect(formatCitation([cjk], 'author-year')).toBe('张 和 李 (2020)')
  })

  it('multiple non-BibTeX documents are joined by newlines', () => {
    expect(formatCitation([d, d], 'key').split('\n')).toHaveLength(2)
  })

  it('the BibTeX style renders one @entry per document', () => {
    expect(formatCitation([d], 'bibtex')).toContain('@misc{smith2023a')
    expect(formatCitation([d, d], 'bibtex').split('\n\n')).toHaveLength(2)
  })
})

describe('describeSyncFailure: classify the failure and reassure about the local library', () => {
  it('an auth failure asks the reader to re-authorise and counts the local docs', () => {
    const r = describeSyncFailure('401 no_token', 5)
    expect(r.kind).toBe('auth')
    expect(r.text).toContain('重新授权')
    expect(r.text).toContain('本地这 5 篇照常能用')
  })

  it('a network failure is reported as the network, not the library', () => {
    const r = describeSyncFailure('getaddrinfo ENOTFOUND', 0)
    expect(r.kind).toBe('network')
    expect(r.text).toContain('连不上 Mendeley')
    expect(r.text).toContain('本地那份照常能用')
  })

  it('an unclassified failure is reported plainly', () => {
    const r = describeSyncFailure('weird', 2)
    expect(r.kind).toBe('other')
    expect(r.text).toContain('同步失败：weird')
  })

  it('a null-ish message is coerced to a string', () => {
    expect(describeSyncFailure('', 1).kind).toBe('other')
  })

  it('auth keywords take precedence over network keywords', () => {
    expect(describeSyncFailure('403 network refresh', 1).kind).toBe('auth')
  })
})

describe('timing: named UI delays stay consistent', () => {
  it('the two query debounces are deliberately equal', () => {
    expect(FIND_QUERY_DEBOUNCE_MS).toBe(250)
    expect(FULL_TEXT_QUERY_DEBOUNCE_MS).toBe(250)
  })

  it('the two persistence debounces are deliberately equal', () => {
    expect(COLUMN_WIDTH_PERSIST_DEBOUNCE_MS).toBe(400)
    expect(PANE_WIDTH_PERSIST_DEBOUNCE_MS).toBe(400)
  })

  it('all exported delays are finite positive numbers', () => {
    const values = [
      FIND_QUERY_DEBOUNCE_MS,
      FULL_TEXT_QUERY_DEBOUNCE_MS,
      COLUMN_WIDTH_PERSIST_DEBOUNCE_MS,
      PANE_WIDTH_PERSIST_DEBOUNCE_MS,
      EXPORT_LIBRARY_MESSAGE_VISIBLE_MS,
      UPDATE_INSTALL_DELAY_MS,
      HIGHLIGHT_UNDO_WINDOW_MS
    ]
    for (const v of values) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
    expect(EXPORT_LIBRARY_MESSAGE_VISIBLE_MS).toBe(12000)
  })
})

describe('PrefetchCache: LRU eviction and stale-flight invalidation', () => {
  it('peek returns undefined for a key that was never warmed', () => {
    const c = new PrefetchCache<number>(2)
    expect(c.peek('missing')).toBeUndefined()
  })

  it('warm stores the drawn bitmap so a later peek hits', async () => {
    const c = new PrefetchCache<number>(2)
    await c.warm('a', () => Promise.resolve(1))
    expect(c.peek('a')).toBe(1)
  })

  it('warming a key that is already done does not draw again', async () => {
    const c = new PrefetchCache<number>(2)
    const draw = vi.fn(() => Promise.resolve(1))
    await c.warm('a', draw)
    await c.warm('a', draw)
    expect(draw).toHaveBeenCalledTimes(1)
  })

  it('two concurrent warms of one key share a single draw', async () => {
    const c = new PrefetchCache<number>(2)
    const d = deferred<number>()
    const draw = vi.fn(() => d.promise)
    const first = c.warm('a', draw)
    expect(c.flight('a')).toBeDefined()
    const second = c.warm('a', draw)
    expect(draw).toHaveBeenCalledTimes(1)
    d.resolve(5)
    await Promise.all([first, second])
    expect(c.peek('a')).toBe(5)
    expect(c.flight('a')).toBeUndefined()
  })

  it('evicts the least recently used entry when the cache exceeds its max', async () => {
    const c = new PrefetchCache<number>(2)
    await c.warm('a', () => Promise.resolve(1))
    await c.warm('b', () => Promise.resolve(2))
    await c.warm('c', () => Promise.resolve(3))
    expect(c.peek('a')).toBeUndefined()
    expect(c.peek('b')).toBe(2)
    expect(c.peek('c')).toBe(3)
  })

  it('touch keeps a recently used entry alive across eviction', async () => {
    const c = new PrefetchCache<number>(2)
    await c.warm('a', () => Promise.resolve(1))
    await c.warm('b', () => Promise.resolve(2))
    c.touch('b')
    await c.warm('d', () => Promise.resolve(4))
    expect(c.peek('b')).toBe(2)
    expect(c.peek('a')).toBeUndefined()
    expect(c.peek('d')).toBe(4)
  })

  it('clear bumps the generation so an in-flight warm fails with StaleFlight', async () => {
    const c = new PrefetchCache<number>(2)
    const d = deferred<number>()
    const warming = c.warm('z', () => d.promise)
    c.clear()
    d.resolve(9)
    let error: unknown = null
    try {
      await warming
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(StaleFlight)
    expect(c.peek('z')).toBeUndefined()
    expect(c.flight('z')).toBeUndefined()
  })

  it('stamp reports the current size, keys and warm flights', async () => {
    const snapshots: { size: number; keys: string[]; warm: string[] }[] = []
    const c = new PrefetchCache<number>(2, (s) => snapshots.push(s))
    const d = deferred<number>()
    const warming = c.warm('a', () => d.promise)
    expect(snapshots[snapshots.length - 1].warm).toEqual(['a'])
    d.resolve(1)
    await warming
    expect(snapshots[snapshots.length - 1]).toEqual({ size: 1, keys: ['a'], warm: [] })
  })
})

describe('annotationMerge: additive cloud merge without losing local marks', () => {
  const positioned = cloud({
    positions: [{ top_left: { x: 10, y: 20 }, bottom_right: { x: 5, y: 50 }, page: 2 }]
  })

  it('a known remote id keeps local fields but takes the authoritative cloud pos', () => {
    const local = [
      ann({
        id: 'L',
        remoteId: 'C1',
        color: 'red',
        text: 'local words',
        note: 'local note',
        rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
        pos: [pos({ page: 9 })]
      })
    ]
    const r = mergeCloudAnnotations('d', local, [cloud({ id: 'C1', ...{ positions: positioned.positions } })], 'now')
    expect(r.merged[0].id).toBe('L')
    expect(r.merged[0].color).toBe('red')
    expect(r.merged[0].text).toBe('local words')
    expect(r.merged[0].rects).toHaveLength(1)
    expect(r.merged[0].pos?.[0].page).toBe(2)
    expect(r.merged[0].remoteId).toBe('C1')
  })

  it('a new cloud id becomes a mark with the cloud text, default colour and page from pos', () => {
    const r = mergeCloudAnnotations('d', [], [cloud({ id: 'C1', text: 'hello', ...{ positions: positioned.positions } })], 'TODAY')
    expect(r.merged[0]).toMatchObject({
      id: 'cloud-C1',
      docId: 'd',
      page: 2,
      type: 'highlight',
      color: '#ffe066',
      text: 'hello',
      note: 'hello',
      created: 'TODAY',
      remoteId: 'C1'
    })
  })

  it('a cloud highlight with no positions is skipped, a sticky note is kept as a note', () => {
    const r = mergeCloudAnnotations(
      'd',
      [],
      [cloud({ id: 'X', type: 'highlight' }), cloud({ id: 'S', type: 'sticky_note', text: 'note' })],
      'now'
    )
    expect(r.merged).toHaveLength(1)
    expect(r.merged[0].type).toBe('note')
    expect(r.merged[0].pos).toEqual([])
  })

  it('local-only marks with positions are queued toPush, remote marks absent from cloud stay', () => {
    const local = [
      ann({ id: 'L1', pos: [pos()] }),
      ann({ id: 'L2', remoteId: 'GONE' })
    ]
    const r = mergeCloudAnnotations('d', local, [], 'now')
    expect(r.toPush).toEqual([{ id: 'L1', pos: [pos()] }])
    expect(r.merged.map((a) => a.id)).toEqual(['L1', 'L2'])
  })

  it('applyMergedAnnotations keeps other papers untouched and appends new ids', () => {
    const other = ann({ id: 'other', docId: 'other' })
    const mine = ann({ id: 'L', remoteId: undefined })
    const added = ann({ id: 'cloud-new', remoteId: 'C9', pos: [pos({ page: 3 })] })
    const out = applyMergedAnnotations([other, mine], 'd', [
      { ...mine, remoteId: 'C1', pos: [pos({ page: 1 })] },
      added
    ])
    expect(out.find((a) => a.id === 'other')).toBe(other)
    expect(out.find((a) => a.id === 'L')?.remoteId).toBe('C1')
    expect(out.find((a) => a.id === 'cloud-new')?.pos?.[0].page).toBe(3)
  })

  it('markPushed records the remote id and positions against a fresh read', () => {
    const current = [ann({ id: 'L' }), ann({ id: 'K' })]
    const out = markPushed(current, 'L', 'R1', [pos({ page: 4 })])
    expect(out[0].remoteId).toBe('R1')
    expect(out[0].pos?.[0].page).toBe(4)
    expect(out[1].remoteId).toBeUndefined()
  })
})
