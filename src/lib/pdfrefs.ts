import * as pdfjs from 'pdfjs-dist'
import type { Rect } from './pdfgeom'
import { pageText, rectsForRange } from './pdffind'
import { isRefHead, linesOf, markersIn, parseRefEntries } from './refly'

/**
 * Where the references of a paper are, and where its citations are.
 *
 * Everything that can be decided without a document is in `refly.ts`; this is
 * the half that has to ask pdf.js.  It is kept small on purpose, and it is
 * asked for as little as possible: the list is read once when a paper is
 * opened, and a page's markers are read when that page is being looked at.
 */
/** A citation marker on a page: the entries it stands for, and where it is. */
export interface CiteMark {
  nums: number[]
  rects: Rect[]
}

/** The reference list of one paper, and the page it opens on. */
export interface RefList {
  entries: Map<number, string>
  /** 1-based */
  page: number
}

/**
 * How far from the end of the paper the list is looked for.
 *
 * The list is not always last: a vision paper puts a dozen pages of tables and
 * appendices after it.  Sixty is generous enough for every such case seen and
 * still bounds the work — a paper with no list to find is not worth reading
 * in full, and walking a whole thesis backwards would be.
 */
const BACK = 60

/** Hand the main thread back, so opening a paper is not held up by this. */
const pause = () => new Promise((r) => setTimeout(r, 0))

/**
 * The reference list of this paper, or null when it has none that can be read
 * with confidence.
 *
 * The pages are walked from the end backwards, because that is where the list
 * is and because the first heading that yields a list going that way is the
 * one the reader means: a "References" in an appendix nearer the front is not
 * the paper's list.  Walking backwards also means the walk usually ends after
 * a page or two rather than after the whole paper.
 */
export async function findRefList(
  pdf: pdfjs.PDFDocumentProxy,
  numPages: number,
  alive: () => boolean = () => true
): Promise<RefList | null> {
  const later: string[] = []
  const first = Math.max(1, numPages - BACK + 1)
  for (let n = numPages; n >= first; n--) {
    if (!alive()) return null
    let rows: string[]
    try {
      const pg = await pdf.getPage(n)
      const tc = await pg.getTextContent()
      rows = linesOf(pageText(tc.items as unknown[])).map((l) => l.text)
    } catch {
      // a page that will not give up its text is not carrying the list
      rows = []
    }
    const at = rows.findIndex(isRefHead)
    if (at >= 0) {
      const entries = parseRefEntries([...rows.slice(at + 1), ...later])
      if (entries.size >= 3) return { entries, page: n }
    }
    later.unshift(...rows)
    await pause()
  }
  return null
}

/**
 * Every citation marker on page `n`, with the boxes that cover it.
 *
 * Only the body is asked for — a page at or after the one the list opens on
 * is the list itself, and every line of it starts with a number in brackets.
 */
export async function marksOnPage(
  pdf: pdfjs.PDFDocumentProxy,
  n: number
): Promise<CiteMark[]> {
  const pg = await pdf.getPage(n)
  const vp = pg.getViewport({ scale: 1 })
  const s = { w: vp.width, h: vp.height }
  if (!s.w || !s.h) return []
  const tc = await pg.getTextContent()
  const items = pageText(tc.items as unknown[])
  const out: CiteMark[] = []
  for (const line of linesOf(items)) {
    for (const m of markersIn(line.text)) {
      const rects = rectsForRange(m.at, m.end, line.map, items, vp, s)
      if (rects.length) out.push({ nums: m.nums, rects })
    }
  }
  return out
}
