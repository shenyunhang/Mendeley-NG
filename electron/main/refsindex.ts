import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { atomicWriteJson } from '../../shared/atomicJson'
import { progressAllowed, sameIndexedFile, snippetAround } from '../../shared/indexedFileRules'
import { isRefHead } from '../../src/lib/refly'
import { normaliseQuery } from '../../src/lib/searchScope'
import {
  MAX_NEAR_WORDS,
  fullTextQueryWords,
  nearSpans,
  spanBounds,
  wordSpans
} from '../../src/lib/searchMatch'
import type { Doc, RefHit } from '../../shared/types'
import { pdfFontOptions } from './pdfFonts'
import { dataDir, loadLibrary } from './store'

/**
 * A small index of the trailing References section of every local PDF.
 *
 * It answers "search the references" from the main process: one JSON table on
 * disk, keyed by document id, holding the text after the References heading
 * plus the file's mtime/size so a build only re-reads papers that changed.
 * Nothing here runs in the renderer, so pdf.js is the legacy Node build and
 * the same worker the full-text index uses.
 */

/** How many pages at the end of a PDF may carry the reference list. */
const TAIL_PAGES = 20
/** How long one PDF may take before it is abandoned (and its worker stopped). */
const DOC_TIMEOUT_MS = 20_000
/** Characters of context on either side of a hit in a snippet (~160 total). */
const SNIPPET_HALF = 80
/** Nobody reads more than this many hits, or this many from one paper. */
const MAX_HITS = 200
const MAX_HITS_PER_DOC = 8

/** A build reads every local PDF and can take minutes; only one may run. */
let building = false
/** Checkpoint this often: a killed process then keeps most of its work. */
const CHECKPOINT_EVERY = 20
/** Progress is a UI hint, not a per-paper event. Thousands of sends freeze
 *  both the main process and the renderer that has to render each one. */
const PROGRESS_MIN_MS = 200
/** A one-character query is a normal Chinese search, not a typo. */
const MIN_QUERY = 1
/** One uninterrupted slice of a reference-index scan. */
const CHUNK_DOCS = 32

interface RefEntry {
  mtime: number
  size: number
  text: string
  /** 1-based page the References heading was found on; 0 when there is none. */
  page: number
  /** Normalised copy of `text` used for matching and for cutting snippets.
   *  Optional so caches written before this field existed still load. */
  hay?: string
}

interface RefsCache {
  version: 1
  entries: Record<string, RefEntry>
}

const cacheFile = () => path.join(dataDir(), 'references.json')
const emptyCache = (): RefsCache => ({ version: 1, entries: {} })

/**
 * The parsed table is held in memory: searchRefs runs on every keystroke and
 * re-reading / re-parsing the whole file for each letter is exactly the cost
 * the full-text index avoids with its cached blob.  A fresh import (app start,
 * a test module) loads it from disk once; a build refreshes it in place.
 */
let cache: RefsCache | null = null

function isEntry(x: unknown): x is RefEntry {
  if (!x || typeof x !== 'object') return false
  const e = x as RefEntry
  return (
    typeof e.mtime === 'number' && Number.isFinite(e.mtime) &&
    typeof e.size === 'number' && Number.isFinite(e.size) &&
    typeof e.text === 'string' &&
    typeof e.page === 'number' && Number.isFinite(e.page) &&
    (e.hay === undefined || typeof e.hay === 'string')
  )
}

/** A broken, half-written or wrong-version cache is treated as empty, never
 *  partly trusted: one bad entry must not poison the whole search. */
function parseCache(raw: string): RefsCache {
  try {
    const x = JSON.parse(raw) as unknown
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('shape')
    const c = x as RefsCache
    if (c.version !== 1 || !c.entries || typeof c.entries !== 'object' || Array.isArray(c.entries)) {
      throw new Error('shape')
    }
    const entries: Record<string, RefEntry> = {}
    for (const [id, e] of Object.entries(c.entries)) {
      if (isEntry(e)) entries[id] = e
    }
    return { version: 1, entries }
  } catch {
    return emptyCache()
  }
}

function loadCache(): RefsCache {
  if (cache) return cache
  try {
    cache = parseCache(fs.readFileSync(cacheFile(), 'utf-8'))
  } catch {
    cache = emptyCache()
  }
  return cache
}

/** The same table, read off the event loop for the async IPC path. */
let readingCache: Promise<RefsCache> | null = null
async function loadCacheAsync(): Promise<RefsCache> {
  if (cache) return cache
  if (!readingCache) {
    readingCache = fsp.readFile(cacheFile(), 'utf-8')
      .then((raw) => (cache ??= parseCache(raw)))
      .catch(() => (cache ??= emptyCache()))
      .finally(() => {
        readingCache = null
      })
  }
  return readingCache
}

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>

/**
 * pdf.js in the main process needs a real worker file next to the bundle (see
 * HANDOFF 8.1 / 4 and scripts/copy-worker.mjs).  fulltext.ts configures the
 * same shared `GlobalWorkerOptions` singleton on start-up, so in the app this
 * is a no-op; the guarded fallback keeps this module able to run on its own
 * (and harmless under a mocked Electron in the unit tests).
 */
function ensureWorker() {
  try {
    if (pdfjs.GlobalWorkerOptions?.workerSrc) return
    const candidates = [
      path.join(__dirname, 'pdf.worker.mjs'),
      path.join(app.getAppPath(), 'out', 'main', 'pdf.worker.mjs'),
      path.join(app.getAppPath(), 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs')
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(c).href
        return
      }
    }
  } catch {
    /* no app yet / mocked pdf.js: the app's start-up config covers it */
  }
}

/** Destroying a pdf.js document is what actually stops its worker.  One door
 *  for the normal exit and for a document abandoned by the timeout, so neither
 *  path can leave a worker behind. */
function cleanupDoc(doc: PdfDoc | null): Promise<void> | undefined {
  return doc?.destroy().catch(() => undefined)
}

interface TextItem {
  str?: string
  hasEOL?: boolean
}

/**
 * pdf.js hands a line over as several runs and marks its end with `hasEOL`.
 * Words split across runs are put back together with a space only where one
 * is needed, so "Back" + "propagation" stays two searchable words instead of
 * becoming "Backpropagation", and a heading is still one line for isRefHead.
 */
function linesOfPage(items: TextItem[]): string[] {
  const out: string[] = []
  let cur = ''
  for (const it of items) {
    const s = typeof it.str === 'string' ? it.str : ''
    if (s) {
      if (cur && !/\s$/.test(cur) && !/^\s/.test(s) && /\w$/.test(cur) && /^\w/.test(s)) cur += ' '
      cur += s
    }
    if (it.hasEOL) {
      const t = cur.trim()
      if (t) out.push(t)
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

interface Extracted {
  text: string
  page: number
  /** whether a References heading was located at all */
  found: boolean
}

/**
 * Read at most the last TAIL_PAGES pages and take everything after the FIRST
 * References heading found scanning forwards.  Nothing is invented: a paper
 * with no heading yields an empty string and the caller records it as skipped.
 * The text is stored whitespace-collapsed, so searchRefs' offsets stay aligned
 * with a lower-cased `includes` scan.
 */
async function extract(file: string): Promise<Extracted> {
  ensureWorker()
  // held in a box so TypeScript does not narrow it to null inside the timer.
  const box: { doc: PdfDoc | null } = { doc: null }
  let stopped = false
  let timer: NodeJS.Timeout | undefined

  const parse = async (): Promise<Extracted> => {
    // pdf.js's Node stream reads a file:// URL straight off disk (PDFNodeStream),
    // so no whole-file read into memory is needed here.
    const d = await pdfjs.getDocument({
      url: pathToFileURL(file).href,
      useSystemFonts: false,
      ...pdfFontOptions()
    }).promise
    // The timer may have fired while getDocument was still resolving.  By then
    // finally has run against an empty box, so this document has to be
    // destroyed here or a PDF that times out during open leaks its worker.
    if (stopped) {
      await cleanupDoc(d)
      throw new Error('timed out')
    }
    box.doc = d
    const first = Math.max(1, d.numPages - TAIL_PAGES + 1)
    let page = 0
    const lines: string[] = []
    let collecting = false
    for (let n = first; n <= d.numPages; n++) {
      let rows: string[] = []
      try {
        const p = await d.getPage(n)
        const tc = await p.getTextContent()
        rows = linesOfPage(tc.items as unknown as TextItem[])
        p.cleanup?.()
      } catch {
        // one unreadable page is not carrying the list; the rest still count
        rows = []
      }
      if (!collecting) {
        const k = rows.findIndex(isRefHead)
        if (k >= 0) {
          collecting = true
          page = n
          lines.push(...rows.slice(k + 1))
        }
      } else {
        lines.push(...rows)
      }
    }
    return { text: lines.join(' ').replace(/\s+/g, ' ').trim(), page, found: collecting }
  }

  try {
    const got = await Promise.race([
      parse(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          stopped = true
          void box.doc?.destroy().catch(() => undefined)
          box.doc = null // the normal exit must not destroy it a second time
          resolve(null)
        }, DOC_TIMEOUT_MS)
      })
    ])
    return got ?? { text: '', page: 0, found: false }
  } finally {
    if (timer) clearTimeout(timer)
    await cleanupDoc(box.doc)
  }
}

/** Which documents the cache is about: every one with a local PDF that is
 *  still on disk. */
function candidates(): Doc[] {
  const docs = loadLibrary()?.docs ?? []
  return docs.filter((d) => d.localPdf && fs.existsSync(d.localPdf))
}

function countIndexed(c: RefsCache): number {
  return Object.values(c.entries).filter((e) => e.text).length
}

export async function buildRefsIndex(
  onProgress?: (p: { done: number; total: number }) => void
): Promise<{ total: number; indexed: number; skipped: string[] }> {
  // A second invoke must not interleave writes into the same in-memory table,
  // push a second stream of progress, or let the first finisher clear the
  // renderer's "building" state while the other is still reading.
  if (building) {
    return {
      total: candidates().length,
      indexed: countIndexed(loadCache()),
      skipped: ['已有一次索引在跑']
    }
  }
  building = true
  const c = loadCache()
  const list = candidates()
  const total = list.length
  const skipped: string[] = []
  let done = 0
  let lastPing = 0

  /** Every write is atomic; a process killed mid-write leaves the old table. */
  const save = () => {
    try {
      atomicWriteJson(cacheFile(), c)
    } catch {
      // A full disk must not throw away the whole build; the in-memory table
      // still answers searches for this session and the next run retries.
    }
  }
  const step = (force = false) => {
    const now = Date.now()
    if (!progressAllowed(lastPing, now, PROGRESS_MIN_MS, force)) return
    lastPing = now
    try {
      onProgress?.({ done, total })
    } catch {
      // A window that closed mid-build must not abort the remaining papers.
    }
  }
  const advance = () => {
    done++
    if (done % CHECKPOINT_EVERY === 0) save()
    step()
  }

  try {
    for (const d of list) {
      const file = d.localPdf as string
      let st: fs.Stats
      try {
        st = fs.statSync(file)
      } catch {
        advance()
        skipped.push(`${d.id}: 文件不在原处`)
        continue
      }
      const mtime = Math.floor(st.mtimeMs)
      const prev = c.entries[d.id]
      // Same moment and same length: the cached section is this file's section.
      if (sameIndexedFile(prev, mtime, st.size)) {
        advance()
        continue
      }
      try {
        const got = await extract(file)
        if (!got.found || !got.text) {
          // Cache the empty result too, so a paper with no list is not re-read
          // on every run; the reason travels back in `skipped`.
          c.entries[d.id] = { mtime, size: st.size, text: '', hay: '', page: got.page }
          skipped.push(`${d.id}: 未找到 References`)
        } else {
          c.entries[d.id] = {
            mtime,
            size: st.size,
            text: got.text,
            hay: normaliseQuery(got.text),
            page: got.page
          }
        }
      } catch (e) {
        // One unreadable paper is recorded and left WITHOUT a cache entry, so the
        // next run retries it; the rest of the library still gets read.
        skipped.push(`${d.id}: ${String(e)}`)
      }
      advance()
    }

    // Papers trashed, deleted or detached since the last build must not keep
    // answering searches with text that no longer belongs to the library.
    const live = new Set(list.map((d) => d.id))
    for (const id of Object.keys(c.entries)) {
      if (!live.has(id)) delete c.entries[id]
    }
    step(true)
  } finally {
    // Whatever happened — an exception, a cancelled progress callback, a
    // window closed — the papers already read must reach disk.
    save()
    building = false
  }
  return { total, indexed: countIndexed(c), skipped }
}

export function* searchRefsSteps(query: string): Generator<void, RefHit[], void> {
  const needle = normaliseQuery(query)
  if (needle.length < MIN_QUERY) return []
  // Hand control back before the first read of the table.
  yield
  const c = loadCache()
  const hits: RefHit[] = []
  let scanned = 0
  for (const docId of Object.keys(c.entries).sort()) {
    if (++scanned % CHUNK_DOCS === 0) yield
    const e = c.entries[docId]!
    if (!e.text) continue
    // Matching and slicing both happen on a normalised copy. Taking the
    // offset from a lower-cased string and cutting the original breaks on
    // characters whose lower case is longer (U+0130); folding whitespace on
    // the fly would shift every hit after the first one. Entries written
    // before `hay` existed fall back to normalising their stored text.
    const hay = e.hay ?? normaliseQuery(e.text)
    let from = 0
    let perDoc = 0
    while (hits.length < MAX_HITS && perDoc < MAX_HITS_PER_DOC) {
      const at = hay.indexOf(needle, from)
      if (at < 0) break
      hits.push({ docId, page: e.page, snippet: snippetAround(hay, at, needle.length, SNIPPET_HALF, SNIPPET_HALF) })
      // Never advance by zero, or a one-character term would loop forever.
      from = at + Math.max(1, needle.length)
      perDoc++
    }
    if (hits.length >= MAX_HITS) break
  }
  if (hits.length) return hits

  // No exact hit anywhere. Try the same near rule the catalogue uses, but on
  // the stored `hay` itself: `nearSpans` returns offsets of words that really
  // occur in that string, so snippetAt still cuts the same text it matched.
  // Nothing is rewritten and the cache version stays 1, so old caches keep
  // loading without a rebuild.
  const wanted = fullTextQueryWords(needle).nearWords
  // A one-word typo has no exact word to anchor it, and the shared rule
  // rejects those anyway; a very long phrase costs more to scan than it
  // can return.
  if (wanted.length < 2 || wanted.length > MAX_NEAR_WORDS) return hits
  const anchors = wanted.filter((w) => w.length >= 2)
  let nearScanned = 0
  for (const docId of Object.keys(c.entries).sort()) {
    if (++nearScanned % CHUNK_DOCS === 0) yield
    const e = c.entries[docId]!
    if (!e.text) continue
    const hay = e.hay ?? normaliseQuery(e.text)
    if (!anchors.some((a) => hay.includes(a))) continue
    const near = nearSpans(wordSpans(hay), needle)
    if (!near || !near.length) continue
    // Both the match and the slice happen on `hay`, so its offsets are still
    // the ones snippetAt was written for. Cover every hit word, not just the
    // first one in query order.
    const bounds = spanBounds(near)
    hits.push({
      docId,
      page: e.page,
      snippet: snippetAround(hay, bounds.at, bounds.len, SNIPPET_HALF, SNIPPET_HALF),
      near: true,
      terms: [...new Set(near.map((s) => s.word))]
    })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}

/** Drive the same scan to completion without yielding. The index tests and
 *  the smoke suite call `searchRefs` synchronously, so that shape stays. */
export function searchRefs(query: string): RefHit[] {
  const it = searchRefsSteps(query)
  let r = it.next()
  while (!r.done) r = it.next()
  return r.done ? r.value : []
}

let searchGeneration = 0
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Drive the reference scan across event-loop turns. A newer query abandons
 *  the old one at the next slice; the renderer already drops stale answers. */
export async function searchRefsAsync(query: string): Promise<RefHit[]> {
  const needle = normaliseQuery(query)
  if (needle.length < MIN_QUERY) return []
  const mine = ++searchGeneration
  await loadCacheAsync()
  if (mine !== searchGeneration) return []
  const it = searchRefsSteps(query)
  let r = it.next()
  while (!r.done) {
    if (mine !== searchGeneration) return []
    await nextTurn()
    r = it.next()
  }
  return r.done ? r.value : []
}

export function refsStatus(): { indexed: number; total: number } {
  return { indexed: countIndexed(loadCache()), total: candidates().length }
}
