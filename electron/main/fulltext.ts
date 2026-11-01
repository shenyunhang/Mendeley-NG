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
  /**
   * Which file the text came from.  The text does not depend on it, so a
   * build never re-reads a paper just because the name changed, but an
   * append does: a paper that has been renamed or re-attached is read
   * again rather than left describing a path that is no longer there.
   * Older entries lack it, which counts as "not the same file".
   */
  file?: string
}

interface Meta {
  version: 2
  pages: number
  /**
   * How many bytes of the text file the entry table actually describes.
   *
   * Offsets in the table are counted in UTF-16 code units and the file is
   * measured in bytes, and the two are not convertible without reading the
   * whole thing — one Chinese character is three bytes but one code unit.
   * So the byte length is carried alongside the entries, and it is the one
   * place a build can pick up again from: everything after `bytes` is text
   * that was written but never recorded, which is what an interrupted run
   * leaves behind.
   */
  bytes: number
  entries: Record<string, Entry>
}

let dir: string = ''
let meta: Meta | null = null
let blob: string | null = null
let building = false
/** Either a build or an append is writing the text file.  They must not
 *  overlap: both compute the offset they start writing at from the entry
 *  table, so two of them at once would put two papers on the same offset
 *  and every hit in one of them would be reported under the other. */
let busy = false
/** Set by `ftCancel`.  The build loop checks it between batches, which is
 *  often enough: a batch is one PDF per lane, not the whole library. */
let cancelled = false
let progress: { done: number; total: number; current: string } = {
  done: 0,
  total: 0,
  current: ''
}
/**
 * Papers the last run could not index, and why.
 *
 * A scan with no text layer, a PDF that will not open and a file that took
 * longer than its budget all end the same way from the outside: the paper is
 * simply absent from the index, and every search for something that is only
 * in it comes back empty.  The counter on its own cannot tell the reader
 * whether that is normal — a 1994 scan — or whether pdf.js is broken across
 * the whole library, which is why the reason travels with the name.
 */
let skipped: { name: string; why: string }[] = []
/** Nobody reads a hundred names; the UI says how many more there were. */
const MAX_SKIPPED = 30

/**
 * Papers that arrived while the index was busy, waiting for their turn.
 *
 * An import that lands in the middle of a build used to be dropped: `ftAdd`
 * refuses to run while something else holds the text file, and the build had
 * already taken the list of papers it is going to read, so the new one was in
 * neither.  It then stayed invisible to search until the library was indexed
 * again — exactly what `ftAdd` exists to prevent, and the one moment it was
 * most likely to happen, because a build is when people are tidying up.
 * They wait here instead, and whichever run finishes takes them.
 */
let pending: Doc[] = []

/** How many papers are waiting.  The smoke run reads it straight off. */
export function ftPending(): number {
  return pending.length
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

/**
 * An index was found on disk but thrown away because a different version of
 * the app wrote it.
 *
 * Worth saying out loud rather than leaving the panel on "还没有索引":
 * from the outside an upgrade that quietly voids a six-minute build looks
 * like the build was lost, and the reader has no way to tell that from
 * never having done it.
 */
let legacy = false

function loadMeta(): Meta {
  if (meta) return meta
  legacy = false
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(), 'utf8')) as Meta
    // an index built with a different page budget does not describe the same
    // thing as the one the user is about to search, so it is discarded; so is
    // one written before the byte anchor existed, because there is no way to
    // tell where its text file can safely be appended to
    if (m?.version === 2 && m.pages === pages) {
      meta = m
      return meta
    }
    // A page budget that changed is the reader's own doing and the panel
    // already says why; an index written by an older version is not, and is
    // the one that needs explaining.
    if (m?.version) legacy = true
  } catch {
    /* no index yet */
  }
  meta = { version: 2, pages: pages, bytes: 0, entries: {} }
  return meta
}

/** The highest offset the entry table claims, in code units. */
function endOf(m: Meta): number {
  let at = 0
  for (const e of Object.values(m.entries)) {
    if (e.start + e.len > at) at = e.start + e.len
  }
  return at
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
    current: progress.current,
    skipped: skipped.slice(),
    legacy
  }
}

/**
 * Whether the index describes nothing that could be searched: it has never
 * been built, or a different version of the app wrote it and it has been
 * voided.
 *
 * Adding one paper to an index like that is not the job.  The paper becomes
 * findable and everything else in the library does not, which is a worse
 * answer than an empty one: a search that finds only the paper imported a
 * minute ago looks like a working search.
 */
export function ftVoid(): boolean {
  const m = loadMeta()
  return legacy || Object.keys(m.entries).length === 0
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

/** What came out of one PDF.  `why` is empty only when there is text. */
type Got = { text: string; bounds: number[]; why: string }

/** Pull the text of the first `n` pages, and say why if there is none. */
async function extract(file: string, n: number): Promise<Got> {
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
      let page = ''
      for (const it of tc.items as unknown as { str?: string }[]) {
        const s = it.str
        if (!s) continue
        // pdf.js hands a page over one run at a time in the order they sit on
        // it, so a word broken across two lines arrives as `genera-` then
        // `tive`.  Putting a space between them is what turns "generative"
        // into two words nobody can search for — the single most common way a
        // paper that is indexed still cannot be found.  A run ending in a
        // hyphen is that line break, so it is joined without one.  A real
        // compound such as "state-of-the-art" stays inside one run, and a
        // continuation starting with a capital is left alone, so names split
        // across lines keep their hyphen.
        if (page.endsWith('- ') && /^[a-z]/.test(s)) page = page.slice(0, -2) + s + ' '
        else page += s + ' '
      }
      // Lower-cased here, not at write time.  The entry table counts offsets
      // in code units of the text as stored, and a handful of characters are
      // longer once they have been lower-cased — U+0130 becomes i plus a
      // combining dot.  Measuring one text and writing another is how a whole
      // index ends up describing text that is not quite there.
      out += page.toLowerCase()
      bounds.push(out.length)
      p.cleanup()
    }
    return { text: out, bounds }
  }

  try {
    const got = await Promise.race([
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
    if (!got) return { text: '', bounds: [], why: '读超时' }
    // A PDF of scanned pages opens, reports its page count and yields no text
    // at all.  It is not a failure of the reader and it is not worth retrying,
    // but it has to be said: from the outside it looks exactly like a paper
    // that was indexed and then could not be found.
    if (!got.text.trim()) return { text: '', bounds: [], why: '没有文本层（扫描件）' }
    return { ...got, why: '' }
  } catch (e) {
    // the first few failures are worth seeing: a library-wide problem, such as
    // a worker that will not start, shows up as every document failing.  A
    // timeout already reported itself.
    if (!stopped && failures++ < 3) console.warn('[fulltext] cannot read', file, String(e))
    return { text: '', bounds: [], why: 'PDF 打不开' }
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
  if (busy) return ftStatus(docs)
  busy = true
  building = true
  cancelled = false
  skipped = []
  // whatever was on disk is being replaced from here on, so the note about
  // it being out of date has served its turn
  legacy = false
  const m = loadMeta()
  if (rebuild) {
    meta = { version: 2, pages: pages, bytes: 0, entries: {} }
  }
  const fresh = meta!
  const queue = docs.filter((d) => d.localPdf)
  progress = { done: 0, total: queue.length, current: '' }
  let out = -1
  // Offsets are counted in UTF-16 code units, because that is what the search
  // side indexes with once the file has been read back as a string.  Taking
  // the byte size here instead looks right and is not: one Chinese character
  // is three bytes but one code unit, so every offset after the first
  // non-ASCII document would be short and the hits would point into the
  // wrong paper.
  let at = 0
  let byteAt = 0
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
    // Opening the file used to happen before this `try`, which meant one
    // failure — a locked file, a directory that went away — left `busy` and
    // `building` set for the rest of the session.  Every later press of
    // "建索引" then returned immediately and did nothing, with the bar stuck
    // on "索引中", and the reader had no way to tell that from a long run.
    const had = fs.existsSync(dataFile())
    const size = had ? fs.statSync(dataFile()).size : 0
    // Cutting the file back to what the entry table can account for is what
    // makes a run that was interrupted survivable.  `saveMeta` runs every few
    // batches, so quitting during a six-minute build leaves text written past
    // the last recorded paper; appending after that records the new papers at
    // the offsets the table ended at while their text goes to the end of the
    // file, so the table is no longer sorted by offset and the binary search
    // that maps every hit back to its paper goes astray — an index that
    // reports itself complete and then finds nothing.  Truncating costs one
    // re-read of a handful of papers and removes the whole class of failure.
    if (!rebuild && had && fresh.bytes <= size) {
      out = fs.openSync(dataFile(), 'r+')
      fs.ftruncateSync(out, fresh.bytes)
      at = endOf(fresh)
    } else {
      // no file, or one whose table cannot be trusted: start again
      fresh.entries = {}
      fresh.bytes = 0
      out = fs.openSync(dataFile(), 'w')
    }
    byteAt = fresh.bytes

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
          // A file that is not there counts as unread, and has to be said:
          // if every path in the library is stale the run finishes having
          // read nothing, and "还没有索引" is the last thing that should
          // greet somebody who just watched it finish.
          if (skipped.length < MAX_SKIPPED) {
            skipped.push({ name: path.basename(d.localPdf ?? ''), why: '文件不在原处' })
          }
          continue
        }
        const prev = fresh.entries[d.id]
        if (
          prev &&
          prev.mtime === Math.floor(st.mtimeMs) &&
          prev.size === st.size
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
        const g = got[k]!
        progress.done++
        if (!g.text.trim()) {
          if (skipped.length < MAX_SKIPPED) {
            skipped.push({ name: path.basename(d.localPdf ?? ''), why: g.why })
          }
          continue
        }
        const buf = Buffer.from(g.text, 'utf8')
        // written at an explicit position rather than appended: append always
        // goes to the end of the file, and the byte anchor has just been
        // brought back to the end of the recorded text, which are not the
        // same thing after an interrupted run
        fs.writeSync(out, buf, 0, buf.length, byteAt)
        fresh.entries[d.id] = {
          start: at,
          len: g.text.length,
          bounds: g.bounds.map((b) => at + b),
          mtime: Math.floor(st.mtimeMs),
          size: st.size,
          file: d.localPdf
        }
        at += g.text.length
        byteAt += buf.length
        // kept in step with the entries, so that a meta written at any moment
        // describes exactly the bytes that are on disk for those papers
        fresh.bytes = byteAt
      }
      // the offset table is written as we go, so a run that is cancelled or
      // crashes is not wasted
      if (i % (width * 8) === 0) saveMeta()
      // give the event loop a turn between batches: this is the only chance
      // a queued IPC, including a cancel, has to be delivered
      await new Promise((r) => setImmediate(r))
    }
  } finally {
    if (out >= 0) {
      try {
        fs.closeSync(out)
      } catch {
        /* already gone */
      }
    }
    busy = false
    building = false
    cancelled = false
    progress.current = ''
    blob = null
    saveMeta()
  }
  // Papers that arrived while the run was going.  A build takes its list of
  // what to read before it starts reading, so without this they would wait
  // for the next build — the wait this whole module exists to avoid.  They
  // are indexed after a cancelled run too: cancelling stops the run, it does
  // not stop the paper from having been imported.
  const queued = pending.splice(0)
  if (queued.length) await ftAdd(queued, queued.map((d) => d.id))
  const s = ftStatus(docs)
  onProgress(s)
  return s
}

/**
 * Index just the documents that were added, appending their text after
 * everything already there.  Nothing has to be rewritten: the offsets of the
 * indexed papers stay where they were, so this costs one PDF of work rather
 * than a run over the library.
 *
 * It exists because importing a paper used to leave it invisible to
 * full-text search until the whole library was indexed again.  Rebuilding
 * takes minutes, so the newest paper — the one somebody is most likely to
 * look for — was reliably the one that could not be found.
 *
 * A paper that is already in the index with the same file behind it is left
 * alone.  Appending a second copy of text that is already there is not
 * harmless: the old copy stays in the file for ever, reachable from no
 * entry, and the file grows by a paper every time anything asks about one.
 */
export async function ftAdd(docs: Doc[], ids: string[]): Promise<number> {
  if (!dir) return 0
  const want = docs.filter((d) => d.localPdf && ids.includes(d.id))
  if (!want.length) return 0
  // Queued rather than dropped.  Both a build and an append hold the text
  // file, and both drain this list when they are done, so a paper that
  // arrived in the middle of either is indexed a moment later instead of
  // never.
  if (busy) {
    for (const d of want) if (!pending.some((p) => p.id === d.id)) pending.push(d)
    return 0
  }
  busy = true
  const m = loadMeta()
  let at = endOf(m)
  let byteAt = m.bytes
  // The byte anchor decides both where the text goes and whether the file has
  // to be cut back first, for the same reason `ftBuild` does it: everything
  // after it is text that was written but never recorded.  An entry table with
  // no anchor behind it cannot be appended to at all.
  const had = fs.existsSync(dataFile())
  const size = had ? fs.statSync(dataFile()).size : 0
  const out = fs.openSync(dataFile(), had && m.bytes <= size ? 'r+' : 'w')
  let added = 0
  try {
    if (had && m.bytes <= size) fs.ftruncateSync(out, m.bytes)
    else {
      m.entries = {}
      m.bytes = 0
      at = 0
      byteAt = 0
    }
    for (const d of want) {
      let st: fs.Stats
      try {
        st = fs.statSync(d.localPdf as string)
      } catch {
        continue
      }
      const prev = m.entries[d.id]
      // Same file, same moment, same length: the text already in the index is
      // this text.  A different path counts as a different file, so a paper
      // that was renamed, re-downloaded or re-attached is read again.
      if (
        prev &&
        prev.file === d.localPdf &&
        prev.mtime === Math.floor(st.mtimeMs) &&
        prev.size === st.size
      ) {
        continue
      }
      const g = await extract(d.localPdf as string, pages)
      if (!g.text.trim()) continue
      const buf = Buffer.from(g.text, 'utf8')
      fs.writeSync(out, buf, 0, buf.length, byteAt)
      m.entries[d.id] = {
        start: at,
        len: g.text.length,
        bounds: g.bounds.map((b) => at + b),
        mtime: Math.floor(st.mtimeMs),
        size: st.size,
        file: d.localPdf
      }
      at += g.text.length
      byteAt += buf.length
      m.bytes = byteAt
      added++
    }
  } finally {
    fs.closeSync(out)
    busy = false
    // The corpus is held in memory as one string.  Appending invalidates it,
    // and without this a search straight after an import would read the text
    // as it was before the paper arrived.
    if (added) blob = null
    saveMeta()
  }
  // Whatever turned up while this run held the file gets its turn now.  It is
  // drained before the recursive call, so a run that keeps being handed
  // papers still terminates.
  const queued = pending.splice(0)
  if (queued.length) added += await ftAdd(queued, queued.map((d) => d.id))
  return added
}

export function ftClear() {
  meta = { version: 2, pages: pages, bytes: 0, entries: {} }
  skipped = []
  legacy = false
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
