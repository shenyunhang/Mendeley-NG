import { useCallback, useEffect, useRef } from 'react'
import type * as pdfjs from 'pdfjs-dist'
import type { MutableRefObject } from 'react'
import { PGAP, bitmapKey, type Size } from '../pdfgeom'
import {
  REPAINT_MARGIN_PX,
  continuousPageTop,
  pagesNearViewport
} from '../continuousScroll'
import { bitmapPixelSize, devicePixelRatioOrOne } from '../bitmapPixelSize'
import { drawTextLayer } from '../pdftext'

/**
 * The continuous column: which of its pages are painted, and at what.
 *
 * A column of every page is a different thing to render from a single page,
 * and the difference is not the drawing, it is the bookkeeping.  Only the
 * pages near the view get a canvas painted into them; a page already painted
 * at the scale and pixel ratio now in force is left alone, which is what keeps
 * a scroll from re-rendering everything it passes; and a record kept of which
 * pages are in view is what tells a scroll which page the reader is on.
 *
 * All of that is this hook, and none of it is about zooming, finding, marking
 * or talking to the cloud.  The component keeps the single page.
 */
export function useContinuousPages(o: {
  pdf: pdfjs.PDFDocumentProxy | null
  scale: number
  numPages: number
  continuous: boolean
  /** Identifies the open document; a new one invalidates every record. */
  docKey: string | undefined | null
  sizes: Record<number, Size>
  sizesRef: MutableRefObject<Record<number, Size>>
  pageRef: MutableRefObject<number>
  /** The page the scroll has arrived at, so the page box follows it. */
  onPage: (n: number) => void
  /** Page size in PDF points, fetched on demand and cached by the caller. */
  sizeOf: (n: number) => Promise<Size | null>
}) {
  const { pdf, scale, numPages, continuous, sizes, sizesRef, pageRef } = o

  /** Canvases and text layers of the continuous column, keyed by page. */
  const contCanvas = useRef(new Map<number, HTMLCanvasElement>())
  const contLayer = useRef(new Map<number, HTMLDivElement>())
  /** What each page was last painted at, so a scroll does not repaint it. */
  const painted = useRef(new Map<number, string>())
  const contBusy = useRef(new Set<number>())
  const contPending = useRef(
    new Map<number, ReturnType<pdfjs.PDFPageProxy['render']>>()
  )
  /** Pages currently inside the observer's margin. */
  const visible = useRef(new Set<number>())
  const contRef = useRef<HTMLDivElement>(null)
  /** The observer callback must see the current zoom without re-subscribing.
   *  Scale changes are already handled by the repaint effect below. */
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  /** A jump that could not be made yet because page heights were still
   *  arriving.  `gen` invalidates it when another document is opened, so a
   *  late height from the old paper cannot move the new one. */
  const jump = useRef<{ n: number; gen: number } | null>(null)
  const gen = useRef(0)

  const forgetPaints = () => {
    // a bitmap of the paper being left must not land on a canvas that now
    // belongs to another one
    contPending.current.forEach((t) => t.cancel())
    contPending.current.clear()
    contBusy.current.clear()
    painted.current.clear()
    visible.current.clear()
  }

  // A different document makes every record wrong: the key is page, scale and
  // pixel ratio, with nothing in it to say which document the paint was of.
  // Opening another paper at an unchanged zoom therefore found every page
  // already recorded as painted, returned before touching a canvas, and left
  // the whole column black — the scroll bar was there and the pages had their
  // full height, so nothing looked broken except that there was no paper on
  // any of them.  Single-page mode never showed it, and only by luck: fitting
  // a new paper moves the scale, which happens to change the key.
  useEffect(() => {
    forgetPaints()
    gen.current += 1
    jump.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.docKey])

  /**
   * Paint one page of the column.  Idempotent: a page already painted at the
   * current scale and pixel ratio is left alone.
   */
  const paintPage = useCallback(
    async (n: number, s: number) => {
      const canvas = contCanvas.current.get(n)
      if (!pdf || !canvas || contBusy.current.has(n)) return
      const dpr = devicePixelRatioOrOne(window.devicePixelRatio)
      const k = bitmapKey(n, s, dpr)
      if (painted.current.get(n) === k) return
      const pg = await pdf.getPage(n)
      const viewport = pg.getViewport({ scale: s })
      const pixels = bitmapPixelSize(viewport, dpr)
      canvas.width = pixels.width
      canvas.height = pixels.height
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, viewport.width, viewport.height)
      contBusy.current.add(n)
      // one canvas, one render at a time: pdf.js refuses to touch a canvas
      // that already has a render in flight
      const task = pg.render({ canvasContext: ctx, viewport })
      contPending.current.set(n, task)
      try {
        await task.promise
      } catch (e) {
        if ((e as { name?: string })?.name === 'RenderingCancelledException') return
        throw e
      } finally {
        contBusy.current.delete(n)
        contPending.current.delete(n)
      }
      painted.current.set(n, k)
      await drawTextLayer(pg, viewport, contLayer.current.get(n))
    },
    [pdf]
  )

  /** Repaint whatever is on screen, e.g. after the scale moved. */
  const repaintVisible = useCallback(
    (s: number) => {
      for (const n of [...visible.current].sort((a, b) => a - b)) {
        paintPage(n, s).catch(() => {
          /* a page that fails to paint stays blank until it is scrolled to */
        })
      }
    },
    [paintPage]
  )

  // every page has to have a known size before the column can be laid out,
  // because the scroll height is the sum of them
  useEffect(() => {
    if (!pdf || !continuous) return
    let dead = false
    ;(async () => {
      for (let n = 1; n <= numPages; n++) {
        if (dead) return
        await o.sizeOf(n)
      }
    })()
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, continuous, numPages])

  // paint pages as they come into view, with a margin so a flick of the wheel
  // lands on something already drawn
  useEffect(() => {
    const root = contRef.current
    if (!continuous || !root || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page)
          if (!Number.isFinite(n)) continue
          if (e.isIntersecting) visible.current.add(n)
          else visible.current.delete(n)
        }
        repaintVisible(scaleRef.current)
      },
      { root, rootMargin: `${REPAINT_MARGIN_PX}px 0px` }
    )
    for (const el of root.querySelectorAll('[data-page]')) io.observe(el)
    return () => io.disconnect()
    // The column renders every [data-page] element up front from numPages;
    // `sizes` only changes their heights. Depending on it used to disconnect
    // and re-observe the whole column once per measured page. `scale` is read
    // from a ref because the repaint effect below already owns zoom changes.
  }, [continuous, numPages, repaintVisible])

  // a new scale invalidates every bitmap, and the observer will not fire again
  // for pages that are already on screen, so they are repainted by hand
  useEffect(() => {
    if (!continuous) return
    forgetPaints()
    const root = contRef.current
    if (!root) return
    // the column is about to be relaid out at the new size, so ask again on
    // the next frame rather than measuring heights that are still old
    const frame = requestAnimationFrame(() => {
      const view = root.getBoundingClientRect()
      const boxes = [...root.querySelectorAll('[data-page]')].map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        return {
          page: Number((el as HTMLElement).dataset.page),
          top: r.top,
          bottom: r.bottom
        }
      })
      // Only pages near the viewport need a fresh bitmap. Adding every
      // [data-page] element here repainted the whole paper on every step of a
      // zoom gesture, which is what made the full-window reader stutter: it
      // has more room, more pages in view and larger bitmaps than the pane.
      // The same margin as the observer keeps the two in agreement.
      for (const n of pagesNearViewport(
        { top: view.top, bottom: view.bottom },
        boxes,
        REPAINT_MARGIN_PX
      )) {
        visible.current.add(n)
      }
      repaintVisible(scale)
    })
    // A second scale change, or an unmount, must not let a frame from the
    // previous layout repaint pages at the old size.
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, continuous])

  /** Make a pending jump, if the heights it needs have arrived by now. */
  const tryJump = () => {
    const t = jump.current
    if (!t) return
    if (t.gen !== gen.current) {
      jump.current = null
      return
    }
    const el = contRef.current
    if (!el) return
    const top = continuousPageTop(t.n, sizesRef.current, scale, PGAP)
    // null means "not all pages above n are measured yet", not "top of page
    // one": guessing here would land short and the next scroll event would
    // report the page actually shown, contradicting the page box.
    if (top === null) return
    el.scrollTo({ top })
    jump.current = null
  }

  /** Scroll the column so that page `n` is at the top.  A jump asked for on
   *  the frame a document opens almost never has the heights it needs, so the
   *  target is kept and retried as they arrive instead of being dropped. */
  const scrollToPage = (n: number) => {
    jump.current = { n, gen: gen.current }
    tryJump()
  }

  // Heights arrive one at a time from `sizeOf`, and every one of them changes
  // `sizes`.  Without this effect, resuming at page 20 in continuous mode
  // showed "20" in the page box with the column still at the top, and the
  // first wheel event quietly changed the box back to 1.
  useEffect(() => {
    if (!continuous) return
    tryJump()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizes, scale, continuous, numPages])

  /** Keep the page box in step with whatever the user has scrolled to. */
  const onScroll = () => {
    const el = contRef.current
    if (!el) return
    // a line below the very top edge, so a page is "current" once it occupies
    // most of the view rather than the instant it peeks in
    const y = el.scrollTop + 24
    let top = 0
    for (let n = 1; n <= numPages; n++) {
      const s = sizesRef.current[n]
      if (!s) return
      const h = s.h * scale + PGAP
      if (y < top + h) {
        if (n !== pageRef.current) o.onPage(n)
        return
      }
      top += h
    }
  }

  return { contCanvas, contLayer, contRef, visible, scrollToPage, onScroll }
}
