/**
 * Where page `n` starts in the continuous column.
 *
 * The column is a stack of pages with a fixed gap, so the offset of a page is
 * the sum of the heights of everything above it.  Those heights arrive one
 * at a time from pdf.js; until all of them are known the offset is not merely
 * unknown, it is *wrong* to guess — a jump made against a half-filled table
 * lands short and the next scroll event then reports the page the reader was
 * actually shown, overwriting the page box with the wrong number.
 *
 * Returning null says "not yet" to the caller, which is the whole difference
 * from the old behaviour: `scrollToPage` used to return silently on a missing
 * size and never be called again, leaving the page box on 20 with the column
 * still at the top.  The hook keeps the target and retries when the next
 * height arrives.
 */
export function continuousPageTop(
  n: number,
  sizes: Record<number, { h: number } | undefined>,
  scale: number,
  gap: number
): number | null {
  if (!Number.isFinite(n) || n < 1) return 0
  let top = 0
  for (let i = 1; i < n; i++) {
    const s = sizes[i]
    if (!s || !Number.isFinite(s.h)) return null
    top += s.h * scale + gap
  }
  return top
}

/** How far outside the viewport a page is still painted ahead of the reader.
 *  Shared by the IntersectionObserver and the repaint after a zoom, so the two
 *  cannot disagree about what "nearby" means. */
export const REPAINT_MARGIN_PX = 700

export interface PageBox {
  page: number
  top: number
  bottom: number
}

/**
 * Which pages a repaint has to touch after the scale moved.
 *
 * A zoom invalidates every bitmap, but only the pages near the viewport are
 * on screen: repainting the whole column turns one step of a Ctrl+wheel
 * gesture into one full-page pdf.js render per page in the paper. The
 * full-window reader has more room and therefore more pages in view, which is
 * exactly why it felt so much worse than the side pane.
 *
 * Pure geometry: the caller measures the DOM, this only decides.
 */
export function pagesNearViewport(
  viewport: { top: number; bottom: number },
  boxes: PageBox[],
  margin: number
): number[] {
  const out: number[] = []
  for (const b of boxes) {
    if (!Number.isFinite(b.page) || b.page < 1) continue
    if (!Number.isFinite(b.top) || !Number.isFinite(b.bottom)) continue
    if (b.bottom < viewport.top - margin) continue
    if (b.top > viewport.bottom + margin) continue
    out.push(b.page)
  }
  return out
}
