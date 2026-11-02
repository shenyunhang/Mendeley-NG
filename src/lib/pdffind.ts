import * as pdfjs from 'pdfjs-dist'
import type { FindHit, Rect, Size, TextRun } from './pdfgeom'

/**
 * Finding a word inside a PDF.
 *
 * pdfjs-dist ships no viewer layer, so there is no PDFFindController to lean
 * on: the text runs are pulled per page, matched against the query by hand,
 * and mapped back to the same 0..1 rectangles the annotation overlay already
 * draws.
 */
export const pageText = (items: unknown[]): TextRun[] =>
  (items as TextRun[]).filter((i) => typeof i.str === 'string' && i.str.length > 0)

/** Where one text run sits, in 0..1 with y from the top.  The viewport is
 *  taken at scale 1 so the numbers are PDF points, which is the same space
 *  `posToRect` converts annotation positions from. */
export const runRect = (it: TextRun, vp: pdfjs.PageViewport, s: Size): Rect => {
  const tx = pdfjs.Util.transform(vp.transform, it.transform)
  const fh = Math.hypot(tx[2], tx[3]) || Math.abs(it.height) || 10
  const w = Math.abs(it.width) || fh * 0.5
  return { x: tx[4] / s.w, y: (tx[5] - fh) / s.h, w: w / s.w, h: fh / s.h }
}

/**
 * Rects covering `haystack[a..b)`.  A match that straddles two runs yields
 * one slice per run, and slices on the same line are stitched back into a
 * single box, which is what makes a hit look like a word rather than like a
 * row of separate letters.
 */
export const rectsForRange = (
  a: number,
  b: number,
  map: { run: number; at: number }[],
  items: TextRun[],
  vp: pdfjs.PageViewport,
  s: Size
): Rect[] => {
  const per = new Map<number, { lo: number; hi: number }>()
  for (let i = a; i < b; i++) {
    const m = map[i]
    if (m.run < 0) continue
    const cur = per.get(m.run)
    if (cur) {
      cur.lo = Math.min(cur.lo, m.at)
      cur.hi = Math.max(cur.hi, m.at)
    } else per.set(m.run, { lo: m.at, hi: m.at })
  }
  const raw: Rect[] = []
  for (const [idx, r] of per) {
    const it = items[idx]
    const base = runRect(it, vp, s)
    const len = Math.max(1, it.str.length)
    raw.push({
      x: base.x + base.w * (r.lo / len),
      y: base.y,
      w: base.w * ((r.hi - r.lo + 1) / len),
      h: base.h
    })
  }
  raw.sort((p, q) => p.y - q.y || p.x - q.x)
  const out: Rect[] = []
  for (const r of raw) {
    const line = out.find((t) => Math.abs(t.y - r.y) < 0.006 && r.x <= t.x + t.w + 0.02)
    if (line) {
      const right = Math.max(line.x + line.w, r.x + r.w)
      line.x = Math.min(line.x, r.x)
      line.w = right - line.x
      line.h = Math.max(line.h, r.h)
    } else out.push({ ...r })
  }
  return out
}

/**
 * Every occurrence of `needle` on page `n`, in reading order.
 *
 * `cache` is the page's text once it has been pulled, so a second query never
 * asks pdf.js for the same page twice.
 */
export async function findInPage(
  pdf: pdfjs.PDFDocumentProxy,
  cache: Map<number, TextRun[]>,
  n: number,
  needle: string
): Promise<FindHit[]> {
  const pg = await pdf.getPage(n)
  const vp = pg.getViewport({ scale: 1 })
  const s = { w: vp.width, h: vp.height }
  if (!s.w || !s.h) return []
  let items = cache.get(n)
  if (!items) {
    const tc = await pg.getTextContent()
    items = pageText(tc.items as unknown[])
    cache.set(n, items)
  }
  if (!items.length) return []
  // pdf.js breaks a line into a new run wherever the font, the size or the
  // spacing changes, so "Back" and "propagation" are often two items with
  // nothing between them.  A space is inserted at every such boundary and
  // recorded as belonging to no run: a query typed with a space then still
  // matches, while the inserted character never contributes a rectangle.
  let hay = ''
  const map: { run: number; at: number }[] = []
  items.forEach((it, i) => {
    if (i > 0 && !/\s$/.test(items![i - 1].str) && !/^\s/.test(it.str)) {
      hay += ' '
      map.push({ run: -1, at: 0 })
    }
    for (let k = 0; k < it.str.length; k++) {
      hay += it.str[k]
      map.push({ run: i, at: k })
    }
  })
  const low = hay.toLowerCase()
  const out: FindHit[] = []
  let from = 0
  for (;;) {
    const at = low.indexOf(needle, from)
    if (at < 0) break
    const rects = rectsForRange(at, at + needle.length, map, items, vp, s)
    if (rects.length) out.push({ page: n, rects })
    from = at + Math.max(1, needle.length)
  }
  return out
}
