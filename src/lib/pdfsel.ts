import type { Rect } from './pdfgeom'

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
  const lines: Rect[] = []
  for (const r of raw.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.y - r.y) < 3)
    if (line) {
      const right = Math.max(line.x + line.w, r.x + r.w)
      line.x = Math.min(line.x, r.x)
      line.w = right - line.x
      line.h = Math.max(line.h, r.h)
    } else {
      lines.push({ ...r })
    }
  }
  return lines.map((l) => ({
    x: l.x / box.width,
    y: l.y / box.height,
    w: l.w / box.width,
    h: l.h / box.height
  }))
}

/**
 * The selection, resolved to the page it was made on and to rects in that
 * page's own 0..1 coordinates.  In continuous mode the column has one text
 * layer per page, so the layers on screen are tried in reading order.
 */
export function selectionRects(
  layers: Array<[number, HTMLElement | null | undefined]>,
  fallbackPage: number
): { page: number; rects: Rect[] } {
  for (const [n, layer] of layers) {
    if (!layer) continue
    const rects = rectsInLayer(layer)
    if (rects.length) return { page: n, rects }
  }
  return { page: fallbackPage, rects: [] }
}
