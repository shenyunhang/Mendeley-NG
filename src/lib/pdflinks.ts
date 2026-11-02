import type * as pdfjs from 'pdfjs-dist'
import type { Size } from './pdfgeom'

/**
 * The links inside a paper.
 *
 * They are annotations of subtype `Link` that pdf.js hands back with the page,
 * and they are the reason a reference list is worth anything: a citation you
 * can click is a citation you can follow.  Two kinds, and they want opposite
 * things: a destination inside this paper turns the page, an address outside
 * it leaves the app.
 */

/** One link on one page, in that page's own 0..1 coordinates, y from the top. */
export interface LinkBox {
  x: number
  y: number
  w: number
  h: number
  /** Where it points inside the paper, one-based. */
  page?: number
  /** Where it points outside the app, already checked. */
  url?: string
  /** What the pointer says, so a link is a link before it is pressed. */
  title: string
}

/** What a link annotation looks like as pdf.js hands it back.  pdfjs-dist does
 *  not export the type, and casting through `any` would lose more than it
 *  saves — the four fields this needs are spelled out instead. */
interface RawLink {
  subtype?: string
  rect?: number[]
  url?: string
  unsafeUrl?: string
  dest?: unknown
}

/**
 * Which protocols are allowed to leave the app.
 *
 * A PDF is a file somebody else wrote, and its links are data, not code: a
 * `javascript:` or a `file:` destination in a paper from an unknown source is
 * not something to hand to the shell.  Anything else is dropped, which is
 * better than opening it and better than showing a link that does nothing.
 */
const SAFE = new Set(['http:', 'https:', 'mailto:'])

export function safeUrl(raw?: string): string | undefined {
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    return SAFE.has(u.protocol) ? u.href : undefined
  } catch {
    return undefined
  }
}

/** pdf.js gives a rectangle as two corners in PDF points, origin bottom left;
 *  the page's own box has its origin at the top. */
export function linkBox(rect: number[] | undefined, s: Size) {
  if (!rect || rect.length < 4 || !s.w || !s.h) return null
  const x1 = Math.min(rect[0], rect[2])
  const x2 = Math.max(rect[0], rect[2])
  const y1 = Math.min(rect[1], rect[3])
  const y2 = Math.max(rect[1], rect[3])
  const w = (x2 - x1) / s.w
  const h = (y2 - y1) / s.h
  if (!(w > 0) || !(h > 0)) return null
  return { x: x1 / s.w, y: (s.h - y2) / s.h, w, h }
}

/**
 * The page a destination points at, one-based.
 *
 * A destination is either an array whose first entry is a reference to the
 * page, or a name that has to be looked up first — which is why this is
 * async.  Papers point at destinations that do not exist often enough that a
 * failure is simply "no link" rather than something to report.
 */
export async function destPage(
  pdf: pdfjs.PDFDocumentProxy,
  dest: unknown
): Promise<number | null> {
  try {
    const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
    const ref = Array.isArray(d) ? d[0] : null
    if (!ref) return null
    const idx = await pdf.getPageIndex(ref)
    return Number.isFinite(idx) ? idx + 1 : null
  } catch {
    return null
  }
}

/** Every link on page `n`, in reading order is not guaranteed but does not
 *  matter: they do not overlap in any paper that is not broken. */
export async function linksOf(
  pdf: pdfjs.PDFDocumentProxy,
  n: number
): Promise<LinkBox[]> {
  const pg = await pdf.getPage(n)
  const vp = pg.getViewport({ scale: 1 })
  const s = { w: vp.width, h: vp.height }
  const raw = (await pg.getAnnotations({ intent: 'display' })) as unknown as RawLink[]
  const out: LinkBox[] = []
  for (const a of raw) {
    if (a.subtype !== 'Link') continue
    const box = linkBox(a.rect, s)
    if (!box) continue
    const url = safeUrl(a.url ?? a.unsafeUrl)
    if (url) {
      out.push({ ...box, url, title: url })
      continue
    }
    if (a.dest == null) continue
    const page = await destPage(pdf, a.dest)
    if (!page) continue
    out.push({ ...box, page, title: `第 ${page} 页` })
  }
  return out
}
