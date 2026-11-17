/**
 * The shape and the read-only rules of the full-text index table.
 *
 * The state machine that writes `fulltext.dat` and its meta table lives in
 * `electron/main/fulltext.ts`. These are the parts that only look at values:
 * whether a parsed table is safe to use, where a text region ends, which
 * document an offset belongs to, which page it falls on, and whether a parse
 * failed because the whole install is broken rather than because one PDF is.
 *
 * Keeping them out of the module that owns `fs` means the boundaries can be
 * tested with fixed inputs instead of a real library and a real worker.
 */

export interface FullTextEntry {
  /** Offset into the text corpus, counted in UTF-16 code units. */
  start: number
  len: number
  /** Absolute offsets of the end of each indexed page, for hit to page. */
  bounds: number[]
  mtime: number
  size: number
  /**
   * Which file the text came from. Older entries lack it, which counts as
   * "not the same file" for an append. See `sameIndexedFile`.
   */
  file?: string
}

export interface FullTextMeta {
  version: 2
  pages: number
  /**
   * How many bytes of the text file the entry table actually describes.
   * Offsets are UTF-16 code units while the file is UTF-8 bytes; the two are
   * not convertible without reading the whole corpus, so the byte length is
   * carried alongside the entries and is the only place a build can resume.
   */
  bytes: number
  entries: Record<string, FullTextEntry>
}

/**
 * Whether a parsed table has the shape the rest of the index reads. A legal
 * JSON object with the right version but a missing `entries` or `bytes` used
 * to be cached and written back, while `Object.keys(m.entries)` threw on
 * every later call.
 */
export function isFullTextMetaShape(m: unknown): m is FullTextMeta {
  if (!m || typeof m !== 'object') return false
  const x = m as FullTextMeta
  if (x.version !== 2) return false
  if (typeof x.bytes !== 'number' || !Number.isFinite(x.bytes) || x.bytes < 0) return false
  if (!x.entries || typeof x.entries !== 'object' || Array.isArray(x.entries)) return false
  for (const e of Object.values(x.entries)) {
    if (!e || typeof e !== 'object') return false
    if (typeof e.start !== 'number' || !Number.isFinite(e.start)) return false
    if (typeof e.len !== 'number' || !Number.isFinite(e.len)) return false
    if (!Array.isArray(e.bounds) || !e.bounds.every((b) => typeof b === 'number' && Number.isFinite(b))) return false
  }
  return true
}

/** The highest offset the entry table claims, in code units. */
export function endOf(m: FullTextMeta): number {
  let at = 0
  for (const e of Object.values(m.entries)) {
    if (e.start + e.len > at) at = e.start + e.len
  }
  return at
}

/** Which document an offset into the text file belongs to, by binary search. */
export function docAt(
  sorted: [string, FullTextEntry][],
  off: number
): [string, FullTextEntry] | null {
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

/** The 1-based page an offset falls on; the last page owns all trailing text. */
export function pageOf(e: FullTextEntry, off: number): number {
  for (let i = 0; i < e.bounds.length; i++) {
    if (off < e.bounds[i]) return i + 1
  }
  return e.bounds.length
}

/**
 * These are the messages pdf.js gives when its worker is missing, and then
 * every document fails identically whatever is in it. Telling that apart is
 * the difference between "your PDFs are broken" and "this install is".
 */
export function isReaderFailure(err: string): boolean {
  return /fake worker|workerSrc|pdf\.worker|GlobalWorkerOptions/i.test(err)
}
