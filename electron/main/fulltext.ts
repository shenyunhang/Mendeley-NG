import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { Doc, FtHit, FtStatus } from '../../shared/types'

/**
 * pdf.js loads its worker with a runtime `import()` relative to the module that
 * asks for it.  Once everything is bundled into out/main/index.js that resolves
 * to `out/main/pdf.worker.mjs`, which does not exist unless the build puts it
 * there — `scripts/copy-worker.mjs` does.  Without this every document fails
 * with "Setting up fake worker failed", which looks like a library-wide
 * problem rather than a missing file.
 */
function workerSrc(): string {
  const candidates = [
    path.join(__dirname, 'pdf.worker.mjs'),
    path.join(app.getAppPath(), 'out', 'main', 'pdf.worker.mjs'),
    path.join(app.getAppPath(), 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs')
  ]
  for (const c of candidates) {
    let found = ''
    try {
      if (fs.existsSync(c)) found = c
    } catch {
      /* app.getAppPath throws before the app is ready */
    }
    if (!found) continue
    // In the packaged app the worker sits inside app.asar, and a runtime
    // import() out of an archive is not something to rely on.  A real file
    // next to it is, so copy it once into the temp directory.
    if (!found.includes('.asar')) return pathToFileURL(found).href
    try {
      const out = path.join(app.getPath('temp'), 'mendeley-ng-pdf.worker.mjs')
      fs.copyFileSync(found, out)
      return pathToFileURL(out).href
    } catch {
      return pathToFileURL(found).href
    }
  }
  return ''
}

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc()

/**
 * Full-text search over the local PDFs.
 *
 * The shape of this is dictated by one measurement: the library has 5245
 * local PDFs, and pulling every page of every one of them yields about
 * 293 MB of text.  Indexing the first three pages yields about 60 MB, which
 * is small enough to keep in memory and to scan synchronously — 130 ms per
 * PDF for the whole document versus 39 ms for three pages.
 *
 * Three pages is title, authors, abstract and the start of the introduction
 * for most papers, which is where the terms someone searches for actually
 * are.  It is a real limit, so it is stated in the UI rather than hidden.
 *
 * The extracted text is kept in one flat file and the index is only an
 * offset table.  There is no inverted index: a scan of 60 MB with
 * `indexOf` costs tens of milliseconds, and an inverted index over this
 * corpus would be larger than the text it describes.
 */

/**
 * How many leading pages of each PDF to index.  It used to be a constant,
 * which quietly decided for the user how big the index gets and how much of
 * each paper is searchable.  It is a setting now, and changing it drops the
 * index, because one built with a different budget does not describe the
 * same thing as the one about to be searched.
 */
let pages = 3

export const fullTextPages = () => pages

export function setFullTextPages(n: number): boolean {
  const next = Math.max(1, Math.min(50, Math.floor(Number(n)) || 3))
  if (next === pages) return false
  pages = next
  meta = null
  blob = null
  return true
}

/** How much context to show either side of a hit. */
const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 140

/** Stop after this many hits; nobody scrolls past it. */
const MAX_HITS = 300

interface Entry {
  /** offset into the text file */
  start: number
  len: number
  /** absolute offsets of the end of each indexed page, for hit -> page */
  bounds: number[]
  mtime: number
  size: number
}

interface Meta {
  version: 1
  pages: number
  entries: Record<string, Entry>
}

let dir: string = ''
let meta: Meta | null = null
let blob: string | null = null
let building = false
/** Set by `ftCancel`.  The build loop checks it between batches, which is
 *  often enough: a batch is one PDF per lane, not the whole library. */
let cancelled = false
let progress: { done: number; total: number; current: string } = {
  done: 0,
  total: 0,
  current: ''
}

/**
 * How many PDFs to read at once.
 *
 * One at a time was the obvious choice and it is the reason building felt
 * like a hang: 5245 documents at ~90 ms each is eight minutes of watching a
 * bar that only moves every couple of seconds.  Reading a few in parallel
 * cuts that by the number of lanes.
 *
 * It is deliberately not "as many as there are cores".  The point of the
 * whole exercise is a text index, and a build that maximises throughput at
 * the cost of the app becoming unresponsive has solved the wrong problem.
 */
const lanes = () => Math.max(1, Math.min(4, (os.cpus()?.length ?? 4) - 1))

export function initFullText(baseDir: string) {
  dir = baseDir
  fs.mkdirSync(dir, { recursive: true })
}

const metaFile = () => path.join(dir, 'fulltext.json')
const dataFile = () => path.join(dir, 'fulltext.dat')

function loadMeta(): Meta {
  if (meta) return meta
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(), 'utf8')) as Meta
    // an index built with a different page budget does not describe the same
    // thing as the one the user is about to search, so it is discarded
    if (m?.version === 1 && m.pages === pages) {
      meta = m
      return meta
    }
  } catch {
    /* no index yet */
  }
  meta = { version: 1, pages: pages, entries: {} }
  return meta
}

function saveMeta() {
  if (!meta || !dir) return
  fs.writeFileSync(metaFile(), JSON.stringify(meta))
}

/** The whole corpus, lower-cased, loaded once and kept. */
function text(): string {
  if (blob != null) return blob
  try {
    blob = fs.readFileSync(dataFile(), 'utf8')
  } catch {
    blob = ''
  }
  return blob
}

/** Which document an offset into the text file belongs to, by binary search. */
function docAt(sorted: [string, Entry][], off: number): [string, Entry] | null {
  let lo = 0
  let hi = sorted.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const e = sorted[mid][1]
    if (off < e.start) hi = mid - 1
    else if (off >= e.start + e.len) lo = mid + 1
    else return sorted[mid]
  }
  return null
}

export function ftStatus(docs: Doc[]): FtStatus {
  const m = loadMeta()
  const withPdf = docs.filter((d) => d.localPdf)
  let bytes = 0
  try {
    bytes = fs.statSync(dataFile()).size
  } catch {
    /* nothing written yet */
  }
  return {
    indexed: Object.keys(m.entries).length,
    total: withPdf.length,
    building,
    done: progress.done,
    pages: pages,
    bytes,
    current: progress.current
  }
}

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>

/**
 * How long one document is allowed to take before it is abandoned.
 *
 * pdf.js will spend unbounded time on a malformed file — a broken xref
 * table, a stream that never terminates.  With the queue read one document
 * at a time, a single such file stops the whole build: everything behind it
 * waits forever and the progress bar never moves again, which is exactly
 * what "creating the index hangs" looks like from the outside.  A finite
 * budget turns an infinite wait into one skipped paper.
 */
const DOC_TIMEOUT_MS = 20_000

let failures = 0

/** Pull the text of the first `n` pages, or null if the PDF will not open. */
async function extract(file: string, n: number): Promise<{ text: string; bounds: number[] } | null> {
  // held in a box rather than a plain `let`, because the only assignment is
  // inside `parse` and TypeScript would otherwise narrow it to null in the
  // timer callback, where it is the whole point
  const box: { doc: PdfDoc | null } = { doc: null }
  let stopped = false
  let timer: NodeJS.Timeout | undefined

  const parse = async (): Promise<{ text: string; bounds: number[] }> => {
    // asynchronous read: a synchronous one blocks the main process for as
    // long as the file takes, and the largest PDFs here are 35 MB
    const raw = await fsp.readFile(file)
    const data = new Uint8Array(raw)
    const d = await pdfjs.getDocument({ data, useSystemFonts: false }).promise
    box.doc = d
    // the timer may have fired while getDocument was still resolving; nothing
    // would be left to destroy it, so check before parsing pages
    if (stopped) throw new Error('timed out')
    const count = Math.min(n, d.numPages)
    let out = ''
    const bounds: number[] = []
    for (let i = 1; i <= count; i++) {
      const p = await d.getPage(i)
      const tc = await p.getTextContent()
      for (const it of tc.items as unknown as { str?: string }[]) {
        if (it.str) out += it.str + ' '
      }
      bounds.push(out.length)
      p.cleanup()
    }
    return { text: out, bounds }
  }

  try {
    return await Promise.race([
      parse(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          stopped = true
          // destroying the document is what actually stops the worker thread.
          // Only resolving the race would abandon the promise and leave the
          // parse burning a core for as long as it liked.
          void box.doc?.destroy().catch(() => {})
          if (failures++ < 3) console.warn('[fulltext] timed out', file)
          resolve(null)
        }, DOC_TIMEOUT_MS)
      })
    ])
  } catch (e) {
    // the first few failures are worth seeing: a library-wide problem, such as
    // a worker that will not start, shows up as every document failing.  A
    // timeout already reported itself.
    if (!stopped && failures++ < 3) console.warn('[fulltext] cannot read', file, String(e))
    return null
  } finally {
    if (timer) clearTimeout(timer)
    await box.doc?.destroy().catch(() => {})
  }
}

/** Stop the run in progress.  Whatever has been indexed stays indexed. */
export function ftCancel() {
  if (building) cancelled = true
}

/**
 * Index everything that is not indexed yet.  Documents whose file has not
 * changed since the last run are skipped, so a second run after adding a few
 * papers is a matter of seconds; text for documents that disappeared stays
 * in the file until a rebuild, which is wasted space but never a wrong
 * answer.
 */
export async function ftBuild(
  docs: Doc[],
  onProgress: (s: FtStatus) => void,
  rebuild = false
): Promise<FtStatus> {
  if (building) return ftStatus(docs)
  building = true
  cancelled = false
  const m = loadMeta()
  if (rebuild) {
    meta = { version: 1, pages: pages, entries: {} }
  }
  const fresh = meta!
  const queue = docs.filter((d) => d.localPdf)
  progress = { done: 0, total: queue.length, current: '' }
  const out = fs.openSync(dataFile(), rebuild ? 'w' : 'a')
  // Offsets are counted in UTF-16 code units, because that is what the search
  // side indexes with once the file has been read back as a string.  Taking
  // the byte size here instead looks right and is not: one Chinese character
  // is three bytes but one code unit, so every offset after the first
  // non-ASCII document would be short and the hits would point into the
  // wrong paper.
  let at = 0
  if (!rebuild) {
    for (const e of Object.values(fresh.entries)) {
      if (e.start + e.len > at) at = e.start + e.len
    }
  }
  let lastPing = 0
  const ping = (cur: string) => {
    const now = Date.now()
    // throttled by time, not by count: a batch of slow PDFs and a batch of
    // fast ones should both move the bar about three times a second.  Only
    // count mattered before, which meant a re-run over cached documents —
    // every batch finishing in microseconds — sent hundreds of progress
    // messages a second, and that is its own kind of freeze.
    if (now - lastPing < 300) return
    lastPing = now
    progress.current = cur
    onProgress(ftStatus(docs))
  }
  try {
    const width = lanes()
    for (let i = 0; i < queue.length; i += width) {
      if (cancelled) break
      const batch = queue.slice(i, i + width)
      // the cheap checks stay serial: stat and "already indexed" cost a
      // fraction of a millisecond, and doing them up front is what keeps the
      // lane below filled with PDFs that actually need reading
      const todo: { d: Doc; st: fs.Stats }[] = []
      for (const d of batch) {
        let st: fs.Stats
        try {
          st = fs.statSync(d.localPdf as string)
        } catch {
          progress.done++
          continue
        }
        const prev = fresh.entries[d.id]
        if (
          prev &&
          prev.mtime === Math.floor(st.mtimeMs) &&
          prev.size === st.size &&
          prev.start + prev.len <= at
        ) {
          progress.done++
          continue
        }
        todo.push({ d, st })
      }
      ping(path.basename(todo[0]?.d.localPdf ?? ''))
      const got = await Promise.all(
        todo.map((t) => extract(t.d.localPdf as string, pages))
      )
      // written in queue order even though it was read in parallel, so the
      // offsets stay contiguous and the entry table stays monotonic
      for (let k = 0; k < todo.length; k++) {
        const { d, st } = todo[k]!
        const g = got[k]
        progress.done++
        if (!g || !g.text.trim()) continue
        fs.writeSync(out, Buffer.from(g.text.toLowerCase(), 'utf8'))
        fresh.entries[d.id] = {
          start: at,
          len: g.text.length,
          bounds: g.bounds.map((b) => at + b),
          mtime: Math.floor(st.mtimeMs),
          size: st.size
        }
        at += g.text.length
      }
      // the offset table is written as we go, so a run that is cancelled or
      // crashes is not wasted
      if (i % (width * 8) === 0) saveMeta()
      // give the event loop a turn between batches: this is the only chance
      // a queued IPC, including a cancel, has to be delivered
      await new Promise((r) => setImmediate(r))
    }
  } finally {
    fs.closeSync(out)
    building = false
    cancelled = false
    progress.current = ''
    blob = null
    saveMeta()
  }
  const s = ftStatus(docs)
  onProgress(s)
  return s
}

export function ftClear() {
  meta = { version: 1, pages: pages, entries: {} }
  blob = null
  try {
    fs.writeFileSync(dataFile(), '')
  } catch {
    /* nothing to truncate */
  }
  saveMeta()
}

/** Documents matching `q`, most-recently-added shape preserved by the caller. */
export function ftSearch(q: string): FtHit[] {
  const needle = q.trim().toLowerCase().replace(/\s+/g, ' ')
  if (needle.length < 2) return []
  const m = loadMeta()
  const body = text()
  if (!body) return []
  const sorted = Object.entries(m.entries).sort((a, b) => a[1].start - b[1].start)
  const tokens = needle.split(' ')
  const hits: FtHit[] = []

  const snippetAt = (off: number, len: number) => {
    const from = Math.max(0, off - SNIPPET_BEFORE)
    const to = Math.min(body.length, off + len + SNIPPET_AFTER)
    return (
      (from > 0 ? '…' : '') +
      body.slice(from, to).replace(/\s+/g, ' ').trim() +
      (to < body.length ? '…' : '')
    )
  }

  const pageOf = (e: Entry, off: number) => {
    for (let i = 0; i < e.bounds.length; i++) {
      if (off < e.bounds[i]) return i + 1
    }
    return e.bounds.length
  }

  // one word: walk the whole corpus with indexOf and map each hit back to its
  // document.  This never slices, so it is one pass over the text.
  if (tokens.length === 1) {
    for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + 1)) {
      const found = docAt(sorted, at)
      if (!found) continue
      hits.push({
        docId: found[0],
        page: pageOf(found[1], at),
        snippet: snippetAt(at, needle.length)
      })
      if (hits.length >= MAX_HITS) break
      // skip the rest of this document's text
      at = found[1].start + found[1].len
    }
    return hits
  }

  // Several words.  The phrase comes first, as one pass over the whole
  // corpus; only if that finds nothing does it fall back to "every word
  // present in the same document".
  //
  // The fallback used to slice out each document and search the slices.
  // That is 5245 slices of a 60 MB string per keystroke, which is 60 MB of
  // copying and a few hundred million character comparisons — enough to
  // stall the main process for seconds on every letter typed.  Walking the
  // whole string once per word instead, and asking `docAt` which document
  // each offset belongs to, does the same job with no copying at all.
  const phrase: { docId: string; page: number; snippet: string }[] = []
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + 1)) {
    const found = docAt(sorted, at)
    if (!found) continue
    phrase.push({
      docId: found[0],
      page: pageOf(found[1], at),
      snippet: snippetAt(at, needle.length)
    })
    if (phrase.length >= MAX_HITS) break
    // the rest of this document cannot hold another hit worth listing
    at = found[1].start + found[1].len
  }
  if (phrase.length) return phrase

  const seen = new Map<string, { mask: number; at: number }>()
  for (let w = 0; w < tokens.length; w++) {
    const t = tokens[w]!
    for (let at = body.indexOf(t); at !== -1; ) {
      const found = docAt(sorted, at)
      if (!found) {
        at = body.indexOf(t, at + 1)
        continue
      }
      const rec = seen.get(found[0])
      if (rec) {
        rec.mask |= 1 << w
        if (at < rec.at) rec.at = at
      } else {
        seen.set(found[0], { mask: 1 << w, at })
      }
      at = body.indexOf(t, found[1].start + found[1].len)
    }
  }
  const want = (1 << tokens.length) - 1
  for (const [id, rec] of seen) {
    if (rec.mask !== want) continue
    const e = m.entries[id]!
    hits.push({
      docId: id,
      page: pageOf(e, rec.at),
      snippet: snippetAt(rec.at, tokens[0]!.length)
    })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}
