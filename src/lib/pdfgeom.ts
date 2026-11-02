import type * as pdfjs from 'pdfjs-dist'
import type { CloudAnnotation, PdfPos } from '../../shared/types'

/**
 * The geometry a PDF viewer keeps having to convert between.
 *
 * Three spaces are in play and mixing them up is the classic way to put a
 * highlight in the wrong place: PDF user space (points, origin at the bottom
 * left), a page's own 0..1 box (origin at the top, so it survives a zoom),
 * and CSS pixels.  Every conversion the reader needs is here, and nowhere
 * else, so there is one place to look when a mark lands somewhere odd.
 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A page's size in PDF points. */
export interface Size {
  w: number
  h: number
}

/** The subset of a pdf.js text item the selection layer needs.  pdfjs-dist
 *  does not re-export `TextItem` from its entry point, so it is spelled out
 *  here rather than casting through `any`. */
export interface TextRun {
  str: string
  transform: number[]
  width: number
  height: number
}

/** One occurrence of the find query: the page it is on and the boxes that
 *  cover it, in that page's own 0..1 coordinates. */
export interface FindHit {
  page: number
  rects: Rect[]
}

/** Highlight colours, roughly the ones Mendeley Desktop offered. */
export const PALETTE = ['#ffe066', '#a9e34b', '#74c0fc', '#ffa8a8', '#d0bfff']

/**
 * How the zoom is chosen.  `fit-width` and `fit-page` are recomputed from the
 * viewport, so they survive a window resize; any manual zoom step drops back
 * to `manual`, because silently snapping back on the next page turn would
 * fight the user.
 */
export type ZoomMode = 'manual' | 'fit-width' | 'fit-page'

/** Past either end the page is either a few pixels or unusably large.  Named
 *  because there are four places that zoom and they must agree. */
export const MIN_SCALE = 0.2
export const MAX_SCALE = 6
export const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))

/** One node of the PDF outline, as pdf.js hands it back. */
export type OutlineNode = Awaited<ReturnType<pdfjs.PDFDocumentProxy['getOutline']>>[number]

export interface OutlineRow {
  node: OutlineNode
  depth: number
}

/** Depth-first walk of the outline tree into a flat, indented list. */
export function flattenOutline(items: OutlineNode[], depth = 0): OutlineRow[] {
  const out: OutlineRow[] = []
  for (const n of items ?? []) {
    out.push({ node: n, depth })
    if (n.items?.length) out.push(...flattenOutline(n.items, depth + 1))
  }
  return out
}

/** Room for the scroll container's own padding, plus a vertical scroll bar.
 *  Both are reserved unconditionally: measuring `clientWidth` instead would
 *  make the fitted scale depend on whether a scroll bar happens to be showing,
 *  which is exactly the feedback loop that makes a fitted reader jitter. */
export const FIT_PAD = 24
export const SCROLLBAR = 18

/** Gap between pages in continuous mode, in CSS px. */
export const PGAP = 14

/**
 * Mendeley stores annotation positions in raw PDF points, but with a trap:
 * the field called `top_left` holds the point with the *smaller* y, which is
 * the visually *lower* corner, because PDF user space has its origin at the
 * bottom left.  Verified against three existing cloud highlights by checking
 * which convention lands on real text:
 *
 *   page 1, y 671.3..685.7 on a 612x792 page -> the paper's title, i.e. near
 *   the top, which is only true if y is measured from the bottom.
 *
 * So the visual top of a rectangle is `pageHeight - max(y)`.
 */
export const fromCloudPositions = (c: CloudAnnotation): PdfPos[] =>
  (c.positions || []).map((p) => ({
    page: p.page,
    x: Math.min(p.top_left.x, p.bottom_right.x),
    y: Math.min(p.top_left.y, p.bottom_right.y),
    w: Math.abs(p.bottom_right.x - p.top_left.x),
    h: Math.abs(p.bottom_right.y - p.top_left.y)
  }))

/** PDF points -> normalised rect with y measured from the top of the page. */
export const posToRect = (p: PdfPos, s: Size): Rect => ({
  x: p.x / s.w,
  y: (s.h - (p.y + p.h)) / s.h,
  w: p.w / s.w,
  h: p.h / s.h
})

/** The inverse of `posToRect`. */
export const rectToPos = (r: Rect, page: number, s: Size): PdfPos => ({
  page,
  x: r.x * s.w,
  // y in PDF points is the *bottom* edge, hence the flip
  y: s.h - (r.y + r.h) * s.h,
  w: r.w * s.w,
  h: r.h * s.h
})

/** The key a rendered bitmap is filed under: page, scale and pixel ratio.
 *  A bitmap is only reusable at exactly the size it was drawn at. */
export const bitmapKey = (n: number, s: number, dpr: number) => `${n}:${s.toFixed(3)}:${dpr}`
