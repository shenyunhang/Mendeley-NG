import * as pdfjs from 'pdfjs-dist'
import type { TextRun } from './pdfgeom'

/**
 * An invisible layer of one span per text run, laid out to match the glyphs.
 * Its only job is to make the page selectable, so that a highlight follows the
 * words instead of a hand-drawn box.  The text is transparent and the
 * browser's own selection colour is what the user sees.
 *
 * It is drawn for the single page and for every page of the continuous column,
 * which is why it is not a method of either.
 */
export async function drawTextLayer(
  pg: pdfjs.PDFPageProxy,
  viewport: pdfjs.PageViewport,
  into?: HTMLElement | null
) {
  const layer = into ?? null
  if (!layer) return
  layer.innerHTML = ''
  const tc = await pg.getTextContent()
  const spans: HTMLElement[] = []
  const wanted: number[] = []
  for (const item of tc.items as unknown as TextRun[]) {
    if (!item.str) continue
    const tx = pdfjs.Util.transform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    if (!fontHeight) continue
    const span = document.createElement('span')
    span.className = 'tx'
    span.textContent = item.str
    span.style.fontSize = `${fontHeight}px`
    // pdf.js positions the baseline at tx[5]; the box top is one ascent up
    span.style.left = `${tx[4]}px`
    span.style.top = `${tx[5] - fontHeight}px`
    layer.appendChild(span)
    spans.push(span)
    wanted.push(item.width * viewport.scale)
  }
  // measure every span before writing any scaleX, otherwise each read
  // forces a layout and a dense page becomes noticeably sluggish
  const widths = spans.map((s) => s.getBoundingClientRect().width)
  spans.forEach((s, i) => {
    if (widths[i] > 0.5 && wanted[i] > 0.5) {
      s.style.transform = `scaleX(${wanted[i] / widths[i]})`
    }
  })
}
