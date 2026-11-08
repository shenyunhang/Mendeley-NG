import type { Rect } from './pdfgeom'
import { mergeRectsIntoLines } from './rectLines'

/**
 * What the reader has selected, as rectangles on the page.
 *
 * The browser's own selection is what makes a highlight follow the words
 * instead of a hand-drawn box, and the text layer was built for exactly that.
 * Turning a DOM selection into page coordinates is fiddly enough — one
 * fragment per text run, in whatever order the runs were laid out — that it
 * earns a module of its own rather than sitting inside the reader.
 */

/** Rects covering the current browser selection, in 0..1 page coordinates. */
export function rectsInLayer(layer: HTMLElement): Rect[] {
  const sel = window.getSelection()
  if (!layer || !sel || sel.isCollapsed || !sel.rangeCount) return []
  const box = layer.getBoundingClientRect()
  if (!box.width || !box.height) return []
  const spans = Array.from(layer.querySelectorAll('span.tx'))
  const raw: Rect[] = []
  for (let r = 0; r < sel.rangeCount; r++) {
    const range = sel.getRangeAt(r)
    const rr = range.getBoundingClientRect()
    for (const sp of spans) {
      if (!range.intersectsNode(sp)) continue
      const sr = (sp as HTMLElement).getBoundingClientRect()
      const x0 = Math.max(sr.left, rr.left)
      const x1 = Math.min(sr.right, rr.right)
      const y0 = Math.max(sr.top, rr.top)
      const y1 = Math.min(sr.bottom, rr.bottom)
      if (x1 - x0 > 0.5 && y1 - y0 > 0.5) {
        raw.push({ x: x0 - box.left, y: y0 - box.top, w: x1 - x0, h: y1 - y0 })
      }
    }
  }
  // a selection is one fragment per text run; stitch the ones on the same
  // line back into a single rectangle per line
  // CSS pixels here, so the tolerance is three pixels and a gap in x does
  // not split a line: a selection can skip a run in the middle.
  const lines = mergeRectsIntoLines(
    raw.sort((a, b) => a.y - b.y || a.x - b.x),
    (l, r) => Math.abs(l.y - r.y) < 3
  )
  return lines.map((l) => ({
    x: l.x / box.width,
    y: l.y / box.height,
    w: l.w / box.width,
    h: l.h / box.height
  }))
}

/**
 * The words a hand-drawn box covers, read off the text layer.
 *
 * A band dragged over a page is a request to mark whatever is under it, and a
 * mark that does not remember which words those were is only a rectangle: the
 * sidebar has nothing to name it by and an export has nothing to quote.  The
 * layer exists already so that a selection can follow the words, so the text
 * is read off it rather than fetched out of the PDF a second time.
 */
export function textInRect(layer: HTMLElement, rect: Rect): string {
  const box = layer.getBoundingClientRect()
  if (!box.width || !box.height) return ''
  const x0 = rect.x * box.width
  const x1 = (rect.x + rect.w) * box.width
  const y0 = rect.y * box.height
  const y1 = (rect.y + rect.h) * box.height
  let out = ''
  let prevRight: number | null = null
  for (const el of Array.from(layer.querySelectorAll('span.tx'))) {
    const r = (el as HTMLElement).getBoundingClientRect()
    if (!r.height) continue
    const sx0 = r.left - box.left
    const sx1 = r.right - box.left
    const sy0 = r.top - box.top
    const sy1 = r.bottom - box.top
    const ox = Math.min(sx1, x1) - Math.max(sx0, x0)
    const oy = Math.min(sy1, y1) - Math.max(sy0, y0)
    // a run counts only when the band covers most of it: a box whose edge
    // clips the line above by a pixel must not drag that whole line in
    if (ox <= 0.5 || oy < Math.min(r.height, y1 - y0) * 0.5) continue
    // pdf.js splits a line into runs, so the gap between two of them is the
    // only thing that tells a space inside a word from a space between two;
    // without this "et al." comes back as "etal."
    if (prevRight !== null && sx0 - prevRight > r.height * 0.2) out += ' '
    out += el.textContent ?? ''
    prevRight = sx1
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * The selection, resolved to the page it was made on and to rects in that
 * page's own 0..1 coordinates.  In continuous mode the column has one text
 * layer per page, so the layers on screen are tried in reading order.
 *
 * The words come back with it because making a highlight clears the selection:
 * whoever asks for the rectangles has one moment to read the text, and it is
 * the text the mark was made for.
 */
export function selectionRects(
  layers: Array<[number, HTMLElement | null | undefined]>,
  fallbackPage: number
): { page: number; rects: Rect[]; text: string } {
  for (const [n, layer] of layers) {
    if (!layer) continue
    const rects = rectsInLayer(layer)
    if (rects.length) {
      const t = (window.getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim()
      return { page: n, rects, text: t }
    }
  }
  return { page: fallbackPage, rects: [], text: '' }
}
