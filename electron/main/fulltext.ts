import fs from 'node:fs'
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
let progress: { done: number; total: number } = { done: 0, total: 0 }

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
    bytes
  }
}

/** Pull the text of the first `n` pages, or null if the PDF will not open. */
async function extract(file: string, n: number): Promise<{ text: string; bounds: number[] } | null> {
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null
  try {
    const data = new Uint8Array(fs.readFileSync(file))
    doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise
    const count = Math.min(n, doc.numPages)
    let out = ''
    const bounds: number[] = []
    for (let i = 1; i <= count; i++) {
      const p = await doc.getPage(i)
      const tc = await p.getTextContent()
      for (const it of tc.items as unknown as { str?: string }[]) {
        if (it.str) out += it.str + ' '
      }
      bounds.push(out.length)
      p.cleanup()
    }
    return { text: out, bounds }
  } catch (e) {
    // the first few failures are worth seeing: a library-wide problem, such as
    // a worker that will not start, shows up as every document failing
    if (failures++ < 3) console.warn('[fulltext] cannot read', file, String(e))
    return null
  } finally {
    await doc?.destroy().catch(() => {})
  }
}

let failures = 0

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
  const m = loadMeta()
  if (rebuild) {
    meta = { version: 1, pages: pages, entries: {} }
  }
  const fresh = meta!
  const queue = docs.filter((d) => d.localPdf)
  progress = { done: 0, total: queue.length }
  const out = fs.openSync(dataFile(), rebuild ? 'w' : 'a')
  let at = rebuild ? 0 : fs.fstatSync(out).size
  try {
    for (const d of queue) {
      const file = d.localPdf as string
      let st: fs.Stats
      try {
        st = fs.statSync(file)
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
      const got = await extract(file, pages)
      if (!got || !got.text.trim()) {
        progress.done++
        continue
      }
      const buf = Buffer.from(got.text.toLowerCase(), 'utf8')
      fs.writeSync(out, buf)
      fresh.entries[d.id] = {
        start: at,
        len: got.text.length,
        bounds: got.bounds.map((b) => at + b),
        mtime: Math.floor(st.mtimeMs),
        size: st.size
      }
      at += got.text.length
      progress.done++
      // yield often enough that the UI keeps painting progress, and write
      // the offset table as we go so an interrupted run is not wasted
      if (progress.done % 25 === 0) {
        saveMeta()
        onProgress(ftStatus(docs))
        await new Promise((r) => setImmediate(r))
      }
    }
  } finally {
    fs.closeSync(out)
    building = false
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

  // several words: prefer the phrase, then fall back to all of them present
  for (const [id, e] of sorted) {
    const slice = body.slice(e.start, e.start + e.len)
    let at = slice.indexOf(needle)
    if (at === -1) {
      let every = true
      let first = -1
      for (const t of tokens) {
        const i = slice.indexOf(t)
        if (i === -1) {
          every = false
          break
        }
        if (first === -1 || i < first) first = i
      }
      if (!every) continue
      at = first
    }
    hits.push({ docId: id, page: pageOf(e, e.start + at), snippet: snippetAt(e.start + at, needle.length) })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}
