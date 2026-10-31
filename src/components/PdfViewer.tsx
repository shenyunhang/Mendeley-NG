import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Annotation, CloudAnnotation, Doc, PdfPos } from '../../shared/types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Size {
  w: number
  h: number
}

/** The subset of a pdf.js text item the selection layer needs.  pdfjs-dist
 *  does not re-export `TextItem` from its entry point, so it is spelled out
 *  here rather than casting through `any`. */
interface TextRun {
  str: string
  transform: number[]
  width: number
  height: number
}

/** One occurrence of the find query: the page it is on and the boxes that
 *  cover it, in that page's own 0..1 coordinates. */
interface FindHit {
  page: number
  rects: Rect[]
}

/** Highlight colours, roughly the ones Mendeley Desktop offered. */
const PALETTE = ['#ffe066', '#a9e34b', '#74c0fc', '#ffa8a8', '#d0bfff']

/**
 * How the zoom is chosen.  `fit-width` and `fit-page` are recomputed from the
 * viewport, so they survive a window resize; any manual zoom step drops back
 * to `manual`, because silently snapping back on the next page turn would
 * fight the user.
 */
type ZoomMode = 'manual' | 'fit-width' | 'fit-page'

/** Past either end the page is either a few pixels or unusably large.  Named
 *  because there are four places that zoom and they must agree. */
const MIN_SCALE = 0.2
const MAX_SCALE = 6
const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))

/** Depth-first walk of the outline tree into a flat, indented list. */
function flattenOutline(items: OutlineNode[], depth = 0): OutlineRow[] {
  const out: OutlineRow[] = []
  for (const n of items ?? []) {
    out.push({ node: n, depth })
    if (n.items?.length) out.push(...flattenOutline(n.items, depth + 1))
  }
  return out
}

/** One node of the PDF outline, as pdf.js hands it back. */
type OutlineNode = Awaited<ReturnType<pdfjs.PDFDocumentProxy['getOutline']>>[number]

interface OutlineRow {
  node: OutlineNode
  depth: number
}

/** Room for the scroll container's own padding, plus a vertical scroll bar.
 *  Both are reserved unconditionally: measuring `clientWidth` instead would
 *  make the fitted scale depend on whether a scroll bar happens to be showing,
 *  which is exactly the feedback loop that makes a fitted reader jitter. */
const FIT_PAD = 24
const SCROLLBAR = 18

/** Gap between pages in continuous mode, in CSS px. */
const PGAP = 14

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
const fromCloudPositions = (
  c: CloudAnnotation
): PdfPos[] =>
  (c.positions || []).map((p) => ({
    page: p.page,
    x: Math.min(p.top_left.x, p.bottom_right.x),
    y: Math.min(p.top_left.y, p.bottom_right.y),
    w: Math.abs(p.bottom_right.x - p.top_left.x),
    h: Math.abs(p.bottom_right.y - p.top_left.y)
  }))

/** PDF points -> normalised rect with y measured from the top of the page. */
const posToRect = (p: PdfPos, s: Size): Rect => ({
  x: p.x / s.w,
  y: (s.h - (p.y + p.h)) / s.h,
  w: p.w / s.w,
  h: p.h / s.h
})

/** The inverse of `posToRect`. */
const rectToPos = (r: Rect, page: number, s: Size): PdfPos => ({
  page,
  x: r.x * s.w,
  // y in PDF points is the *bottom* edge, hence the flip
  y: s.h - (r.y + r.h) * s.h,
  w: r.w * s.w,
  h: r.h * s.h
})

export default function PdfViewer({
  doc,
  onLocalPdf,
  jumpTo,
  confirm
}: {
  doc: Doc
  onLocalPdf?: (docId: string, p: string) => void
  /** Open at this page.  The nonce is what makes a second jump to the same
   *  page on the same document possible, e.g. two hits on page 3. */
  jumpTo?: { page: number; nonce: number } | null
  /** The app's one confirmation box.  Deleting an annotation is the only
   *  destructive thing in here, and it has no way back. */
  confirm: (req: { title: string; body?: string; ok?: string }) => Promise<boolean>
}) {
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.3)
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width')
  const [tick, setTick] = useState(0)
  const [outline, setOutline] = useState<OutlineRow[] | null>(null)
  const [side, setSide] = useState<'none' | 'outline' | 'anns'>('none')
  const [continuous, setContinuous] = useState(false)
  /**
   * Whether dragging over a page draws a highlight.
   *
   * It is off until asked for.  A tool that is always on turns every drag
   * across a page into a mark on it, so the ordinary act of selecting a
   * sentence to copy leaves a yellow box behind — and the reader has no way
   * to know it happened until the page is full of them.
   *
   * It is deliberately not remembered, unlike continuous scrolling.  A
   * reading habit is worth carrying across sessions; a drawing tool is not,
   * and one left switched on quietly undoes the default this restores.
   */
  const [marking, setMarking] = useState(false)
  /**
   * A highlight that was just made out of a text selection, so that it can be
   * taken back in one click.
   *
   * Only that kind.  Dragging a box over the page is an unambiguous request to
   * mark it, where picking words is exactly what somebody does to copy them —
   * and the mode may have been left on from the last paper.  Without a way
   * back, one forgotten switch fills a paper with marks that then have to be
   * found and deleted one at a time.
   */
  const [justMade, setJustMade] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [findHits, setFindHits] = useState<FindHit[]>([])
  const [findAt, setFindAt] = useState(0)
  const [findBusy, setFindBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [anns, setAnns] = useState<Annotation[]>([])
  const [drag, setDrag] = useState<Rect | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [sizes, setSizes] = useState<Record<number, Size>>({})
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pending = useRef<ReturnType<pdfjs.PDFPageProxy['render']> | null>(null)
  const renderId = useRef(0)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const dragBox = useRef<DOMRect | null>(null)
  const dragPage = useRef<number | null>(null)
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes
  const pageRef = useRef(page)
  pageRef.current = page
  const idRef = useRef(doc.id)
  idRef.current = doc.id

  // Continuous scrolling is a reading habit, not a per-document decision, so
  // it is remembered like the theme rather than reset on every open.
  useEffect(() => {
    window.api
      .getConfig()
      .then((c) => {
        if (typeof c.pdfContinuous === 'boolean') setContinuous(c.pdfContinuous)
      })
      .catch(() => {
        /* a default of one page at a time is fine */
      })
  }, [])

  const toggleContinuous = () => {
    setContinuous((v) => {
      const next = !v
      void window.api.setConfig({ pdfContinuous: next }).catch(() => {})
      return next
    })
  }

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

  // load annotations for this document
  useEffect(() => {
    setSel(null)
    window.api.loadAnnotations().then((all) => {
      setAnns(all.filter((a) => a.docId === doc.id))
    })
  }, [doc.id])

  useEffect(() => {
    setPage(1)
    setErr(null)
    setPdf(null)
    // reset rather than left at the previous document's count, so nothing
    // decides an opening page against a length this document does not have
    setNumPages(0)
    // and forget that this document was already opened, or coming back to it
    // would look like a re-render rather than an opening
    setOpenedAt('')
    setSizes({})
    setMsg(null)
    setOutline(null)
    if (!doc.localPdf) return
    let dead = false
    pdfjs
      .getDocument({ url: window.api.pdfUrl(doc.localPdf) })
      .promise.then(async (p) => {
        if (dead) {
          p.destroy()
          return
        }
        setPdf(p)
        setNumPages(p.numPages)
        // the outline is cheap and lets a long paper be navigated by section,
        // which is the only way a 40-page PDF is usable at all
        try {
          const o = await p.getOutline()
          if (!dead && o?.length) setOutline(flattenOutline(o))
        } catch {
          /* a PDF without a valid outline is not an error worth showing */
        }
      })
      .catch((e) => !dead && setErr(String(e)))
    return () => {
      dead = true
      pending.current?.cancel()
    }
  }, [doc.localPdf])

  // Where the reader left off.  Loaded once, and only consulted once the
  // document's length is known, because a remembered page says nothing about
  // the file that is there now.
  // A ref, not state: the position is written back as the reader goes, and a
  // copy that was only ever read once at mount would send a paper back to
  // where it was when the app started rather than where it was left.
  const resumeRef = useRef<Record<string, number>>({})
  const [resumeReady, setResumeReady] = useState(false)
  useEffect(() => {
    window.api
      .loadReading()
      .then((m) => {
        resumeRef.current = m ?? {}
      })
      .catch(() => {
        resumeRef.current = {}
      })
      .finally(() => setResumeReady(true))
  }, [])

  // Which page a document opens at, decided in one place: a jump wins over
  // the remembered position, and neither can be applied before the document
  // has a length.  The key is what keeps this from re-deciding — and
  // therefore from yanking the reader back — on every later render.
  const [openedAt, setOpenedAt] = useState('')
  // A jump is a one-off instruction, not part of the document.  Without this
  // the nonce from the last full-text hit would still be sitting there when
  // the reader moves to another paper, and that paper would open at a page
  // nobody asked for.
  const jumped = useRef(0)
  useEffect(() => {
    if (!resumeReady || !numPages || !doc.localPdf) return
    const key = `${doc.id}|${numPages}|${jumpTo?.nonce ?? 0}`
    if (key === openedAt) return
    setOpenedAt(key)
    const fresh = !!jumpTo && jumped.current !== jumpTo.nonce
    if (fresh) jumped.current = jumpTo!.nonce
    const want = fresh ? jumpTo!.page : resumeRef.current[doc.id] ?? 1
    const at = Math.min(Math.max(1, want), numPages)
    setPage(at)
    if (continuous && at > 1) requestAnimationFrame(() => scrollToPage(at))
    // A document that opens somewhere other than page one has to say why,
    // or it looks like the page counter is broken.
    setMsg(!fresh && at > 1 ? `回到上次读到的第 ${at} 页` : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeReady, numPages, doc.id, doc.localPdf, jumpTo, openedAt])

  // Written back on a delay, and the delay reads where the reader *now* is
  // rather than where it was when the timer was armed.  That distinction is
  // the whole difficulty here: the render that switches documents still
  // carries the previous document's page, so anything eager writes the old
  // page onto the new document — and onto the value the restore above is
  // about to read, which then opens the paper on page one.
  //
  // Page one is not stored: it is where a document opens when there is
  // nothing to remember, and writing it for every paper looked at would fill
  // the file with noise.
  useEffect(() => {
    if (!resumeReady || !numPages || !doc.localPdf) return
    const t = setTimeout(() => {
      const id = idRef.current
      const p = pageRef.current
      if (p <= 1) return
      resumeRef.current[id] = p
      void window.api.setReading(id, p).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [page, doc.id, doc.localPdf, numPages, resumeReady])

  /** Where the cursor was on the page when a zoom started, kept so the point
   *  under it can be put back afterwards. */
  const anchor = useRef<{
    el: HTMLElement
    fx: number
    fy: number
    x: number
    y: number
  } | null>(null)

  /**
   * Ctrl + wheel, which is the zoom gesture on every platform and the shape
   * Chromium reports a trackpad pinch in as well.
   *
   * The listener is registered by hand on the window in the capture phase for
   * two reasons.  React attaches `wheel` passively, and preventDefault from a
   * passive listener is ignored — the browser would zoom the whole page
   * instead of the document.  And it cannot be hung on the pane element,
   * because the pane is not in the tree until a document has loaded.
   */
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      const pane = paneRef.current
      if (!pane || !pane.contains(e.target as Node)) return
      e.preventDefault()
      // a line or a page of delta means something very different from a pixel
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
      const d = e.deltaY * unit
      if (!d) return
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const page = el?.closest('.pg-box, canvas') as HTMLElement | null
      if (page) {
        const r = page.getBoundingClientRect()
        if (r.width && r.height) {
          anchor.current = {
            el: page,
            fx: (e.clientX - r.left) / r.width,
            fy: (e.clientY - r.top) / r.height,
            x: e.clientX,
            y: e.clientY
          }
        }
      }
      // exponential, so one notch feels the same at 50% as at 400%
      setZoomMode('manual')
      setScale((s) => clampScale(s * Math.exp(-d * 0.002)))
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  /**
   * Put the anchored point back under the cursor.
   *
   * Without this the page slides out from under the pointer and the gesture
   * feels like it missed, even though the scale did change.  It runs in a
   * layout effect so the scroll is corrected in the same frame as the new
   * size, before the reader sees the wrong position.
   */
  useLayoutEffect(() => {
    const a = anchor.current
    if (!a) return
    anchor.current = null
    const sc = continuous ? contRef.current : scrollRef.current
    if (!sc) return
    const r = a.el.getBoundingClientRect()
    if (!r.width || !r.height) return
    sc.scrollLeft += r.left + a.fx * r.width - a.x
    sc.scrollTop += r.top + a.fy * r.height - a.y
  }, [scale, continuous])

  /** Page size in PDF points, fetched on demand and cached. */
  const sizeOf = useCallback(
    async (n: number): Promise<Size | null> => {
      const hit = sizesRef.current[n]
      if (hit) return hit
      if (!pdf) return null
      const pg = await pdf.getPage(n)
      const vp = pg.getViewport({ scale: 1 })
      const s = { w: vp.width, h: vp.height }
      setSizes((prev) => ({ ...prev, [n]: s }))
      return s
    },
    [pdf]
  )

  // make sure every page that carries an annotation has its size known
  useEffect(() => {
    if (!pdf) return
    let dead = false
    const need = new Set<number>([page])
    for (const a of anns) for (const p of a.pos || []) need.add(p.page)
    ;(async () => {
      for (const n of need) {
        if (dead) return
        await sizeOf(n)
      }
    })()
    return () => {
      dead = true
    }
  }, [pdf, anns, page, sizeOf])

  // the fitted scale depends on the viewport, which changes with the window,
  // the font size knob and the pane split; a ResizeObserver is what keeps it
  // honest without polling
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setTick((t) => t + 1))
    ro.observe(el)
    return () => ro.disconnect()
  }, [doc.localPdf])

  useEffect(() => {
    if (zoomMode === 'manual') return
    const el = scrollRef.current
    // In continuous mode the scale must not depend on which page happens to be
    // at the top: it would change as the user scrolls, which relaid out the
    // column and moved the scroll position, which changed the page again.
    // Fitting the widest page keeps one stable scale for the whole column.
    let s = sizes[page]
    if (continuous) {
      for (const k of Object.keys(sizes)) {
        const c = sizes[Number(k)]
        if (c && (!s || c.w > s.w)) s = c
      }
    }
    if (!el || !s || !s.w || !s.h) return
    const box = el.getBoundingClientRect()
    const availW = box.width - FIT_PAD - SCROLLBAR
    const availH = box.height - FIT_PAD
    if (availW <= 0 || availH <= 0) return
    const byWidth = availW / s.w
    const next =
      zoomMode === 'fit-width' ? byWidth : Math.min(byWidth, availH / s.h)
    setScale(clampScale(next))
  }, [zoomMode, page, sizes, tick, continuous])

  /**
   * Neighbouring pages, rendered ahead of time into offscreen canvases so a
   * page turn paints immediately instead of waiting for pdf.js.  Keyed by
   * page and scale, so a zoom change simply misses and re-renders.  Capped,
   * because a full-page bitmap at devicePixelRatio is not small.
   */
  const prefetch = useRef(new Map<string, HTMLCanvasElement>())
  /** In-flight warms, kept as promises so a page turn can join one instead of
   *  starting a second render of the same page.  A warm is queued behind the
   *  visible page in the pdf.js worker, so it routinely outlives the click
   *  that will ask for it; without this the turn just renders it again. */
  const warming = useRef(new Map<string, Promise<HTMLCanvasElement>>())
  const PREFETCH_MAX = 6

  // A different document makes every cached bitmap wrong.  A different scale
  // does not: the key carries the scale, so stale entries simply miss and get
  // pushed out by the LRU below.  Clearing on every scale change used to throw
  // away the neighbours a moment before the user turned to them.
  useEffect(() => {
    prefetch.current.clear()
    warming.current.clear()
  }, [doc.localPdf])

  /** Drop the least recently used entries until the cache fits again. */
  const evict = () => {
    const m = prefetch.current
    while (m.size > PREFETCH_MAX) {
      const oldest = m.keys().next().value
      if (oldest === undefined) return
      m.delete(oldest)
    }
  }

  /** Exposed on <html> so the smoke run can tell a hit from a miss. */
  const stampCache = () => {
    const d = document.documentElement.dataset
    d.pfSize = String(prefetch.current.size)
    d.pfKeys = [...prefetch.current.keys()].join(',')
    d.pfWarm = [...warming.current.keys()].join(',')
  }

  const prefetchKey = (n: number, s: number, d: number) =>
    `${n}:${s.toFixed(3)}:${d}`

  const renderTo = useCallback(
    async (canvas: HTMLCanvasElement, n: number, s: number) => {
      const pg = await pdf!.getPage(n)
      const viewport = pg.getViewport({ scale: s })
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, viewport.width, viewport.height)
      await pg.render({ canvasContext: ctx, viewport }).promise
      return viewport
    },
    [pdf]
  )

  const warm = (n: number, s: number): Promise<void> => {
    if (n < 1 || n > numPages || !pdf) return Promise.resolve()
    const dpr = window.devicePixelRatio || 1
    const k = prefetchKey(n, s, dpr)
    const done = prefetch.current.get(k)
    if (done) return Promise.resolve()
    const flight = warming.current.get(k)
    if (flight) return flight.then(() => undefined).catch(() => undefined)
    const off = document.createElement('canvas')
    const p = renderTo(off, n, s).then(() => {
      warming.current.delete(k)
      prefetch.current.set(k, off)
      evict()
      stampCache()
      return off
    })
    warming.current.set(k, p)
    stampCache()
    // the rejection is deliberately left on the promise: whoever awaits it
    // decides whether a failed warm matters, and an unhandled one would be
    // indistinguishable from a real bug
    p.catch(() => {
      warming.current.delete(k)
      stampCache()
    })
    return p.then(() => undefined)
  }

  /**
   * Fill the cache around `p`.  The immediate pair comes first, then the next
   * ring out, so a slow warm of page +1 cannot hold up the one for page +2.
   * Never awaited by the caller: prefetching must not delay the page in front
   * of the user, and a dropped bitmap only costs a normal render.
   */
  const warmAround = (p: number, s: number) => {
    ;(async () => {
      await Promise.all([warm(p + 1, s), warm(p - 1, s)])
      await Promise.all([warm(p + 2, s), warm(p - 2, s)])
    })().catch(() => {
      /* a failed prefetch is invisible: the page just renders normally */
    })
  }

  const render = useCallback(async () => {
    const canvas = canvasRef.current
    // in continuous mode the single-page canvas is not what is on screen
    if (!pdf || !canvas || continuous) return
    const dpr = window.devicePixelRatio || 1
    const key = prefetchKey(page, scale, dpr)
    let cached = prefetch.current.get(key)
    const pg = await pdf.getPage(page)
    const viewport = pg.getViewport({ scale })
    // a bitmap only helps if it is already the right size; anything else
    // means the scale or the device pixel ratio moved on
    const fits = (c: HTMLCanvasElement | undefined) =>
      !!c &&
      c.width === Math.floor(viewport.width * dpr) &&
      c.height === Math.floor(viewport.height * dpr)

    if (!cached) {
      const flight = warming.current.get(key)
      if (flight) {
        // the neighbour render is already under way; waiting for it is the
        // whole point of having started it, and re-rendering would double the
        // work and leave the worker busy for twice as long
        try {
          cached = await flight
        } catch {
          cached = undefined
        }
        document.documentElement.dataset.pfLast = 'joined-warm'
      } else {
        document.documentElement.dataset.pfLast = 'absent'
      }
    }

    if (fits(cached)) {
      const bmp = cached!
      canvas.width = bmp.width
      canvas.height = bmp.height
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, bmp.width, bmp.height)
      ctx.drawImage(bmp, 0, 0)
      // re-insert so the LRU knows this one was just used
      prefetch.current.delete(key)
      prefetch.current.set(key, bmp)
      await drawTextLayer(pg, viewport)
      document.documentElement.dataset.renderSrc = 'cache'
      stampCache()
      // the turn came from the cache, so the neighbours of the new page are
      // the ones worth warming now
      warmAround(page, scale)
      return
    }
    if (cached) {
      prefetch.current.delete(key)
      document.documentElement.dataset.pfLast = 'size-mismatch'
    }
    stampCache()

    // devicePixelRatio is what makes this crisp on a 4K panel; Mendeley
    // Desktop rendered at 1x and looked correspondingly soft
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, viewport.width, viewport.height)
    // A zoom change or a page turn can start a render while the previous one
    // is still running, and pdf.js refuses to touch the same canvas twice:
    // "Cannot use the same canvas during multiple render() operations".  The
    // stale task has to be cancelled, and its rejection swallowed, or the
    // pane would show that as a failure every time the window is resized.
    pending.current?.cancel()
    const id = ++renderId.current
    const task = pg.render({ canvasContext: ctx, viewport })
    pending.current = task
    try {
      await task.promise
    } catch (e) {
      if ((e as { name?: string })?.name === 'RenderingCancelledException') return
      throw e
    }
    if (id !== renderId.current) return
    document.documentElement.dataset.renderSrc = 'pdf'
    await drawTextLayer(pg, viewport)

    // Warm the neighbours now that the page the user asked for is on screen.
    warmAround(page, scale)
  }, [pdf, page, scale, numPages, renderTo, continuous])

  /**
   * An invisible layer of one span per text run, laid out to match the glyphs.
   * Its only job is to make the page selectable, so that a highlight follows
   * the words instead of a hand-drawn box.  The text is transparent and the
   * browser's own selection colour is what the user sees.
   */
  const drawTextLayer = async (
    pg: pdfjs.PDFPageProxy,
    viewport: pdfjs.PageViewport,
    into?: HTMLElement | null
  ) => {
    const layer = into ?? layerRef.current
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

  /**
   * Paint one page of the continuous column.  Idempotent: a page already
   * painted at the current scale and pixel ratio is left alone, which is what
   * keeps a scroll from re-rendering everything it passes.
   */
  const paintPage = useCallback(
    async (n: number, s: number) => {
      const canvas = contCanvas.current.get(n)
      if (!pdf || !canvas || contBusy.current.has(n)) return
      const dpr = window.devicePixelRatio || 1
      const k = prefetchKey(n, s, dpr)
      if (painted.current.get(n) === k) return
      const pg = await pdf.getPage(n)
      const viewport = pg.getViewport({ scale: s })
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
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
        await sizeOf(n)
      }
    })()
    return () => {
      dead = true
    }
  }, [pdf, continuous, numPages, sizeOf])

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
        repaintVisible(scale)
      },
      { root, rootMargin: '700px 0px' }
    )
    for (const el of root.querySelectorAll('[data-page]')) io.observe(el)
    return () => io.disconnect()
  }, [continuous, numPages, sizes, scale, repaintVisible])

  // a new scale invalidates every bitmap, and the observer will not fire again
  // for pages that are already on screen, so they are repainted by hand
  useEffect(() => {
    if (!continuous) return
    contPending.current.forEach((t) => t.cancel())
    contPending.current.clear()
    contBusy.current.clear()
    painted.current.clear()
    visible.current.clear()
    const root = contRef.current
    if (!root) return
    // the column is about to be relaid out at the new size, so ask again on
    // the next frame rather than measuring heights that are still old
    requestAnimationFrame(() => {
      for (const el of root.querySelectorAll('[data-page]')) {
        const n = Number((el as HTMLElement).dataset.page)
        if (Number.isFinite(n)) visible.current.add(n)
      }
      repaintVisible(scale)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, continuous])

  /** Scroll the column so that page `n` is at the top. */
  const scrollToPage = (n: number) => {
    const el = contRef.current
    if (!el) return
    let top = 0
    for (let i = 1; i < n; i++) {
      const s = sizesRef.current[i]
      if (!s) return
      top += s.h * scale + PGAP
    }
    el.scrollTo({ top })
  }

  /**
   * Turn to a page, in either mode.  In continuous mode the column has to be
   * scrolled as well, or the page box and the view disagree about where the
   * reader is.
   */
  const goPage = (n: number) => {
    const want = Math.min(Math.max(1, n), numPages || 1)
    setPage(want)
    if (continuous) scrollToPage(want)
  }

  /**
   * Paging from the keyboard.  The pane is focusable and claims these keys
   * while it has focus, and it stops them there: the same keys move the
   * table's selection, and one press moving both would be worse than either
   * on its own.  Arrow keys are left to the browser in continuous mode,
   * where what they do — scroll a little — is what is being asked for.
   *
   * The page box is an input and keeps its own keys, which is also why the
   * target is checked rather than the pane being assumed to have focus.
   */
  const onPaneKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    let want: number | null = null
    if (e.key === 'Home') want = 1
    else if (e.key === 'End') want = numPages || 1
    else if (e.key === 'PageDown' || e.key === ' ' || e.key === 'ArrowRight') {
      want = pageRef.current + (e.key === ' ' && e.shiftKey ? -1 : 1)
    } else if (e.key === 'PageUp') want = pageRef.current - 1
    else if (!continuous && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      want = pageRef.current + (e.key === 'ArrowDown' ? 1 : -1)
    }
    if (want == null) return
    e.preventDefault()
    e.stopPropagation()
    goPage(want)
  }

  /** Keep the page box in step with whatever the user has scrolled to. */
  const onContScroll = () => {
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
        if (n !== pageRef.current) setPage(n)
        return
      }
      top += h
    }
  }

  /* ------------------------------------------------------------------ *
   *  Finding text inside the open PDF.  pdfjs-dist ships no viewer layer,
   *  so there is no PDFFindController to lean on: the text runs are pulled
   *  per page, matched against the query by hand, and mapped back to the
   *  same 0..1 rectangles the annotation overlay already draws.
   * ------------------------------------------------------------------ */

  /** Text runs of every page already pulled, so a second query never asks
   *  pdf.js for the same page twice.  Thrown away on a document change. */
  const textCache = useRef(new Map<number, TextRun[]>())
  /** Bumped on every query; a scan that notices it moved stops early. */
  const scanId = useRef(0)
  const findInput = useRef<HTMLInputElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    textCache.current.clear()
    scanId.current++
    setFindQ('')
    setFindHits([])
    setFindAt(0)
    setFindOpen(false)
  }, [doc.localPdf])

  const itemsOf = async (n: number): Promise<TextRun[]> => {
    const hit = textCache.current.get(n)
    if (hit) return hit
    const pg = await pdf!.getPage(n)
    const tc = await pg.getTextContent()
    const items = (tc.items as unknown as TextRun[]).filter(
      (i) => typeof i.str === 'string' && i.str.length > 0
    )
    textCache.current.set(n, items)
    return items
  }

  /** Where one text run sits, in 0..1 with y from the top.  The viewport is
   *  taken at scale 1 so the numbers are PDF points, which is the same space
   *  `posToRect` converts annotation positions from. */
  const runRect = (it: TextRun, vp: pdfjs.PageViewport, s: Size): Rect => {
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
  const rectsForRange = (
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
      const line = out.find(
        (t) => Math.abs(t.y - r.y) < 0.006 && r.x <= t.x + t.w + 0.02
      )
      if (line) {
        const right = Math.max(line.x + line.w, r.x + r.w)
        line.x = Math.min(line.x, r.x)
        line.w = right - line.x
        line.h = Math.max(line.h, r.h)
      } else out.push({ ...r })
    }
    return out
  }

  /** Every occurrence of `needle` on page `n`, in reading order. */
  const findInPage = async (n: number, needle: string): Promise<FindHit[]> => {
    if (!pdf) return []
    const pg = await pdf.getPage(n)
    const vp = pg.getViewport({ scale: 1 })
    const s = { w: vp.width, h: vp.height }
    if (!s.w || !s.h) return []
    const items = await itemsOf(n)
    if (!items.length) return []
    // pdf.js breaks a line into a new run wherever the font, the size or the
    // spacing changes, so "Back" and "propagation" are often two items with
    // nothing between them.  A space is inserted at every such boundary and
    // recorded as belonging to no run: a query typed with a space then still
    // matches, while the inserted character never contributes a rectangle.
    let hay = ''
    const map: { run: number; at: number }[] = []
    items.forEach((it, i) => {
      if (i > 0 && !/\s$/.test(items[i - 1].str) && !/^\s/.test(it.str)) {
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

  /** Bring hit `i` on screen.  Takes the list explicitly so a scan can jump to
   *  its first hit before that list has reached React state. */
  const gotoHit = (i: number, list?: FindHit[]) => {
    const l = list ?? findHits
    if (!l.length) return
    const at = ((i % l.length) + l.length) % l.length
    setFindAt(at)
    const h = l[at]
    setPage(h.page)
    // the column has to be moved as well; the page box alone only labels the
    // page, it does not bring it into view
    if (continuous) requestAnimationFrame(() => scrollToPage(h.page))
  }

  /**
   * Walk every page.  Hits are published as they are found rather than at the
   * end, so a long paper reports its first matches while the rest is still
   * being read.
   */
  const runFind = useCallback(
    async (q: string) => {
      const needle = q.trim().toLowerCase()
      if (!pdf || needle.length < 2) {
        setFindHits([])
        setFindAt(0)
        setFindBusy(false)
        return
      }
      const id = ++scanId.current
      setFindBusy(true)
      const all: FindHit[] = []
      for (let n = 1; n <= numPages; n++) {
        if (id !== scanId.current) return
        try {
          const hits = await findInPage(n, needle)
          if (id !== scanId.current) return
          if (hits.length) {
            all.push(...hits)
            setFindHits([...all])
          }
        } catch {
          /* a page that will not give up its text costs a hit, not the scan */
        }
      }
      setFindBusy(false)
      if (all.length) gotoHit(0, all)
    },
    // gotoHit reads page/scale through the closure on purpose: a stale copy
    // would only mean one extra scroll
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pdf, numPages]
  )

  // a query is worth a scan once the typing pauses; 250ms is long enough that
  // a four-character word costs one scan rather than four
  useEffect(() => {
    if (!findOpen) return
    const t = setTimeout(() => runFind(findQ), 250)
    return () => clearTimeout(t)
  }, [findQ, findOpen, runFind])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || !!t.isContentEditable)
      const mine = !!t && !!paneRef.current && paneRef.current.contains(t)

      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        // The library search owns Ctrl+F only while the caret is in it.  While
        // the user is reading, the same key has to mean "find in this PDF",
        // which is what every other reader does.
        if (typing && !mine) return
        e.preventDefault()
        e.stopPropagation()
        setFindOpen(true)
        requestAnimationFrame(() => {
          findInput.current?.focus()
          findInput.current?.select()
        })
        return
      }
      if (!findOpen) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setFindOpen(false)
        return
      }
      // only the find box answers Enter: the note box has its own meaning for
      // it, and swallowing that would silently stop notes from saving
      if (e.key === 'F3' || (e.key === 'Enter' && t === findInput.current)) {
        e.preventDefault()
        gotoHit(findAt + (e.shiftKey ? -1 : 1))
      }
    }
    // Capture, because App installs the library-wide Ctrl+F on window first and
    // a bubble listener would always run after it.
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findAt, findHits, continuous])

  // exposed so the smoke run can assert on a hit count without screenshotting
  useEffect(() => {
    const d = document.documentElement.dataset
    d.findHits = String(findHits.length)
    d.findPage = findHits.length ? String(findHits[findAt]?.page ?? '') : ''
  }, [findHits, findAt])

  /** The selection, resolved to the page it was made on and to rects in that
   *  page's own 0..1 coordinates.  In continuous mode the column has one text
   *  layer per page, so the layers on screen are tried in reading order. */
  const selectionRects = (): { page: number; rects: Rect[] } => {
    const layers: Array<[number, HTMLElement]> = continuous
      ? [...visible.current]
          .sort((a, b) => a - b)
          .map((n) => [n, contLayer.current.get(n)] as [number, HTMLElement])
          .filter((x) => x[1])
      : [[page, layerRef.current as HTMLElement]]
    for (const [n, layer] of layers) {
      const rects = rectsInLayer(layer)
      if (rects.length) return { page: n, rects }
    }
    return { page, rects: [] }
  }

  /** Rects covering the current browser selection, in 0..1 page coordinates. */
  const rectsInLayer = (layer: HTMLElement): Rect[] => {
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

  useEffect(() => {
    render().catch((e) => {
      // cancelling is a normal part of switching zoom, not a failure
      if ((e as { name?: string })?.name === 'RenderingCancelledException') return
      setErr(String(e))
    })
  }, [render])

  /** Rects to draw for `a` on page `n`, in 0..1 with y from the top. */
  const rectsFor = (a: Annotation, n: number): Rect[] => {
    if (a.pos && a.pos.length) {
      const out: Rect[] = []
      for (const p of a.pos) {
        if (p.page !== n) continue
        const s = sizes[p.page]
        if (!s) continue
        out.push(posToRect(p, s))
      }
      return out
    }
    return a.page === n ? a.rects : []
  }

  /** Annotations that belong on page `n`. */
  const annsOn = (n: number) =>
    anns.filter((a) => (a.pos?.length ? a.pos.some((p) => p.page === n) : a.page === n))

  /** Positions for `a` in PDF points, deriving them from rects if needed. */
  const posFor = async (a: Annotation): Promise<PdfPos[]> => {
    if (a.pos && a.pos.length) return a.pos
    const out: PdfPos[] = []
    for (const r of a.rects) {
      const s = await sizeOf(a.page)
      if (!s) continue
      out.push(rectToPos(r, a.page, s))
    }
    return out
  }

  const persist = async (next: Annotation[]) => {
    const all = await window.api.loadAnnotations()
    const others = all.filter((a) => a.docId !== doc.id)
    await window.api.saveAnnotations([...others, ...next])
    setAnns(next)
  }

  /** Save a highlight on page `on`, in that page's own 0..1 rects. */
  const commitHighlight = async (rects: Rect[], on: number): Promise<string | null> => {
    if (!rects.length) return null
    const s = await sizeOf(on)
    const a: Annotation = {
      id: `${doc.id}-${on}-${Date.now()}`,
      docId: doc.id,
      page: on,
      type: 'highlight',
      color: '#ffe066',
      rects,
      // keep the authoritative copy in PDF points so a cloud round trip does
      // not drift when the page is later rendered at another zoom level
      pos: s ? rects.map((r) => rectToPos(r, on, s)) : undefined,
      created: new Date().toISOString()
    }
    const all = await window.api.loadAnnotations()
    const next = [...all, a]
    await window.api.saveAnnotations(next)
    setAnns(next.filter((x) => x.docId === doc.id))
    setSel(a.id)
    return a.id
  }

  /** Take the last highlight back, locally first and then in the cloud. */
  const undoHighlight = async (id: string) => {
    const all = await window.api.loadAnnotations()
    const gone = all.find((a) => a.id === id)
    const next = all.filter((a) => a.id !== id)
    await window.api.saveAnnotations(next)
    setAnns(next.filter((x) => x.docId === doc.id))
    setSel(null)
    setJustMade(null)
    // after the local copy is safely written, so a failure here leaves a stray
    // cloud highlight rather than a lost local one
    if (gone?.remoteId) {
      await window.api.deleteRemoteAnnotation(gone.remoteId).catch(() => {})
    }
  }

  useEffect(() => {
    if (!justMade) return
    const t = setTimeout(() => setJustMade(null), 8000)
    return () => clearTimeout(t)
  }, [justMade])

  /** Pull cloud annotations, merge them in, then push anything local-only. */
  const syncCloud = async () => {
    if (busy) return
    setBusy(true)
    setMsg('正在与云端同步…')
    try {
      const cloud = await window.api.pullAnnotations(doc.id)
      const mine = anns
      const byRemote = new Map(mine.filter((a) => a.remoteId).map((a) => [a.remoteId!, a]))
      const merged: Annotation[] = []
      for (const c of cloud) {
        const pos = fromCloudPositions(c)
        if (!pos.length && c.type !== 'sticky_note') continue
        const prev = byRemote.get(c.id)
        byRemote.delete(c.id)
        merged.push({
          id: prev?.id ?? 'cloud-' + c.id,
          docId: doc.id,
          page: pos[0]?.page ?? prev?.page ?? 1,
          type: c.type === 'sticky_note' ? 'note' : 'highlight',
          color: prev?.color ?? '#ffe066',
          rects: prev?.rects ?? [],
          text: c.text,
          note: prev?.note ?? c.text,
          created: prev?.created ?? c.created ?? new Date().toISOString(),
          remoteId: c.id,
          pos
        })
      }
      // local-only ones survive; anything we knew from the cloud but that the
      // cloud no longer lists was deleted elsewhere, so it is dropped
      const localOnly = mine.filter((a) => !a.remoteId)
      let pushed = 0
      const hash = await window.api.fileHash(doc.id)
      for (const a of localOnly) {
        if (!hash) break
        const items = await posFor(a)
        if (!items.length) continue
        try {
          const created = await window.api.pushAnnotations(doc.id, hash, items)
          if (created[0]?.id) {
            a.remoteId = created[0].id
            a.pos = items
            pushed++
          }
        } catch {
          /* leave it local-only and try again next time */
        }
      }
      const next = [...merged, ...localOnly]
      await persist(next)
      setMsg(
        `云端 ${cloud.length} 条${hash ? ` · 新上传 ${pushed} 条` : ' · 云端无 filehash，本地高亮未上传'}`
      )
    } catch (e) {
      setMsg('同步失败：' + String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    const target = anns.find((a) => a.id === id)
    if (!target) return
    // Asking here too, and not only in the annotation list, because this is
    // the button next to the highlight itself — the one most easily hit by
    // accident while reaching for the colour swatches beside it.  An
    // annotation has no trash to come back from.
    const go = await confirm({
      title: target.type === 'note' ? '删除这条笔记？' : '删除这条标注？',
      body: target.note
        ? `「${target.note.slice(0, 60)}${target.note.length > 60 ? '…' : ''}」\n\n不可恢复，云端那条也会一并删掉。`
        : '不可恢复，云端那条也会一并删掉。',
      ok: '删除'
    })
    if (!go) return
    if (target.remoteId) {
      try {
        await window.api.deleteRemoteAnnotation(target.remoteId)
      } catch {
        /* the cloud copy may already be gone; drop it locally regardless */
      }
    }
    setSel(null)
    await persist(anns.filter((a) => a.id !== id))
  }

  const recolor = async (id: string, color: string) => {
    await persist(anns.map((a) => (a.id === id ? { ...a, color } : a)))
  }

  const saveNote = async (id: string, text: string) => {
    await persist(anns.map((a) => (a.id === id ? { ...a, note: text } : a)))
  }

  /** Which page a mouse event landed on, and the box to measure it against.
   *  In continuous mode the column has one such box per page, so the event
   *  itself is the only reliable way to tell them apart. */
  const pageBox = (e: React.MouseEvent): { page: number; box: DOMRect } => {
    const host = (e.currentTarget as HTMLElement).closest('[data-page]')
    if (host) {
      const n = Number((host as HTMLElement).dataset.page)
      if (Number.isFinite(n)) return { page: n, box: host.getBoundingClientRect() }
    }
    return { page, box: wrapRef.current!.getBoundingClientRect() }
  }

  const onDown = (e: React.MouseEvent) => {
    if (!marking) return
    const { page: p, box } = pageBox(e)
    dragPage.current = p
    dragStart.current = { x: e.clientX - box.left, y: e.clientY - box.top }
    dragBox.current = box
    setDrag(null)
  }
  const onMove = (e: React.MouseEvent) => {
    if (!dragStart.current || !dragBox.current) return
    // while the browser is building a text selection, drawing a rubber band
    // on top of it is just noise
    if (!(window.getSelection()?.isCollapsed ?? true)) return
    const box = dragBox.current
    const x = e.clientX - box.left
    const y = e.clientY - box.top
    setDrag({
      x: Math.min(dragStart.current.x, x) / box.width,
      y: Math.min(dragStart.current.y, y) / box.height,
      w: Math.abs(x - dragStart.current.x) / box.width,
      h: Math.abs(y - dragStart.current.y) / box.height
    })
  }
  const onUp = async () => {
    // with highlighting off, a drag is a text selection and nothing more:
    // picking words to copy must not also mark the page
    if (!marking) return
    // a real text selection wins: it follows the words rather than a box
    const picked = selectionRects()
    if (picked.rects.length) {
      setJustMade(await commitHighlight(picked.rects, picked.page))
      window.getSelection()?.removeAllRanges()
    } else if (drag && drag.w > 0.01 && drag.h > 0.005) {
      await commitHighlight([drag], dragPage.current ?? page)
    } else {
      setSel(null)
    }
    dragStart.current = null
    dragBox.current = null
    setDrag(null)
  }

  /** Jump to a section.  Destinations are resolved lazily: some papers have
   *  hundreds of them and resolving a broken one throws. */
  const goTo = async (node: OutlineNode) => {
    if (!pdf) return
    try {
      const dest =
        typeof node.dest === 'string' ? await pdf.getDestination(node.dest) : node.dest
      const ref = Array.isArray(dest) ? dest[0] : null
      if (!ref) return
      const idx = await pdf.getPageIndex(ref)
      if (Number.isFinite(idx)) {
        setPage(idx + 1)
        // in continuous mode the column has to be moved as well; the page box
        // alone only labels the page, it does not bring it into view
        if (continuous) requestAnimationFrame(() => scrollToPage(idx + 1))
      }
    } catch {
      /* outlines pointing at a missing destination are common enough */
    }
  }

  const selected = anns.find((a) => a.id === sel) || null
  const pageAnns = annsOn(page)

  /** One highlight rectangle, shared by the single page and the column. */
  const overlay = (a: Annotation, r: Rect, key: string) => (
    <div
      key={key}
      title={a.note || '高亮'}
      onClick={() => {
        setSel(a.id)
        setNote(a.note || '')
      }}
      style={{
        position: 'absolute',
        left: `${r.x * 100}%`,
        top: `${r.y * 100}%`,
        width: `${r.w * 100}%`,
        height: `${r.h * 100}%`,
        background: a.color,
        opacity: 0.32,
        cursor: 'pointer',
        mixBlendMode: 'multiply',
        boxShadow: sel === a.id ? '0 0 0 1px var(--accent)' : undefined
      }}
    />
  )

  /** The box being dragged out, before it becomes a highlight. */
  const rubberBand = (d: Rect) => (
    <div
      style={{
        position: 'absolute',
        left: `${d.x * 100}%`,
        top: `${d.y * 100}%`,
        width: `${d.w * 100}%`,
        height: `${d.h * 100}%`,
        background: '#ffe066',
        opacity: 0.35,
        pointerEvents: 'none'
      }}
    />
  )

  /** The query's boxes on page `n`.  The one the caret is on is drawn louder,
   *  because "which of them am I looking at" is the whole point of a count. */
  const findMarks = (n: number) =>
    findHits.flatMap((h, i) =>
      h.page !== n
        ? []
        : h.rects.map((r, k) => (
            <div
              key={`f-${i}-${k}`}
              className={i === findAt ? 'find-hit cur' : 'find-hit'}
              style={{
                position: 'absolute',
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`
              }}
            />
          ))
    )

  /** Everything on this document, in reading order, for the sidebar. */
  const annsByPage = useMemo(
    () =>
      [...anns].sort((a, b) => {
        const pa = a.pos?.[0]?.page ?? a.page
        const pb = b.pos?.[0]?.page ?? b.page
        if (pa !== pb) return pa - pb
        // same page: top of the page first, remembering PDF y counts upwards
        const ya = a.pos?.[0]?.y ?? 0
        const yb = b.pos?.[0]?.y ?? 0
        return yb - ya
      }),
    [anns]
  )

  const download = async () => {
    if (busy) return
    setBusy(true)
    setMsg('正在从云端下载…')
    const r = await window.api.downloadPdf(doc.id)
    setBusy(false)
    if (r.ok && r.path) {
      setMsg(`已保存到 ${r.path}`)
      onLocalPdf?.(doc.id, r.path)
    } else {
      setMsg('下载失败：' + (r.error ?? '未知错误'))
    }
  }

  /**
   * No file on disk.  Which of the three ways out applies depends on whether
   * Mendeley has a copy, and on whether the failure to fetch it was about
   * the token — so the reason is looked at rather than printed.
   */
  if (!doc.localPdf) {
    const noToken = /NO_TOKEN/.test(msg ?? '')
    return (
      <div className="empty">
        <p>这篇还没有本地 PDF。</p>
        <p className="sub">
          {doc.file_attached
            ? 'Mendeley 云端有这篇的附件，可以直接下载。'
            : 'Mendeley 云端没有这篇的附件——那就得自己找一份。把 PDF 拖进窗口，'
              + '会按里面读到的 DOI / arXiv id 挂到这条上。'}
        </p>
        {doc.file_attached && !noToken && (
          <button style={{ marginTop: 10 }} onClick={download} disabled={busy}>
            {busy ? '下载中…' : '从云端下载 PDF'}
          </button>
        )}
        {noToken && (
          <button
            style={{ marginTop: 10 }}
            onClick={async () => {
              const r = await window.api.importToken()
              if (r?.ok) setMsg(null)
            }}
          >
            导入 token 后再下载
          </button>
        )}
        {msg && <div className="pdf-msg">{msg}</div>}
      </div>
    )
  }
  if (err) return <div className="err">PDF 打开失败：{err}</div>

  return (
    <div className="pdf-pane" ref={paneRef} tabIndex={0} onKeyDown={onPaneKey}>
      <div className="pdf-bar">
        <button
          onClick={() => goPage(page - 1)}
          disabled={page <= 1}
        >
          ←
        </button>
        <input
          style={{ width: 58 }}
          value={page}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10)
            if (!Number.isFinite(n)) return
            goPage(n)
          }}
        />
        <span>
          / {numPages || '…'}
        </span>
        <button
          onClick={() => goPage(page + 1)}
          disabled={page >= numPages}
        >
          →
        </button>
        <span style={{ marginLeft: 8 }} />
        <button
          title="缩小（Ctrl + 滚轮也行）"
          onClick={() => {
            setZoomMode('manual')
            setScale((s) => clampScale(s - 0.2))
          }}
        >
          −
        </button>
        <span
          style={{ minWidth: 46, textAlign: 'center' }}
          title="按住 Ctrl 滚动滚轮即可缩放"
        >
          {Math.round(scale * 100)}%
        </span>
        <button
          title="放大（Ctrl + 滚轮也行）"
          onClick={() => {
            setZoomMode('manual')
            setScale((s) => clampScale(s + 0.2))
          }}
        >
          ＋
        </button>
        <button
          className={zoomMode === 'fit-width' ? 'primary' : ''}
          title="缩放到页宽，跟着窗口一起变"
          onClick={() => setZoomMode('fit-width')}
        >
          适宽
        </button>
        <button
          className={zoomMode === 'fit-page' ? 'primary' : ''}
          title="缩放让整页完整可见"
          onClick={() => setZoomMode('fit-page')}
        >
          整页
        </button>
        <button
          className={continuous ? 'primary' : ''}
          title="所有页排成一列连续滚动，而不是一次一页"
          onClick={toggleContinuous}
        >
          连续
        </button>
        <button
          className={side === 'outline' ? 'primary' : ''}
          disabled={!outline?.length}
          title={outline?.length ? '显示 PDF 目录' : '这个 PDF 没有目录'}
          onClick={() => setSide((v) => (v === 'outline' ? 'none' : 'outline'))}
        >
          目录
        </button>
        <button
          className={marking ? 'primary' : ''}
          title={
            marking
              ? '高亮已开启：在页面上拖选即生成高亮。再点一次关掉，拖选就只是选中文字'
              : '开启后，在页面上拖选即生成高亮。关闭时拖选只是选中文字，可以直接复制'
          }
          onClick={() => setMarking((v) => !v)}
        >
          高亮
        </button>
        <button
          className={side === 'anns' ? 'primary' : ''}
          title="列出本篇全部标注，点一条跳到那一页"
          onClick={() => setSide((v) => (v === 'anns' ? 'none' : 'anns'))}
        >
          标注 {anns.length ? `(${anns.length})` : ''}
        </button>
        <button
          className={findOpen ? 'primary' : ''}
          title="在这篇 PDF 里查找文字  (Ctrl+F)"
          onClick={() => {
            setFindOpen((v) => {
              if (!v) requestAnimationFrame(() => findInput.current?.focus())
              return !v
            })
          }}
        >
          查找
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={syncCloud} disabled={busy}>
          云同步标注
        </button>
        <span style={{ color: 'var(--fg-dim)', marginLeft: 8 }}>
          {justMade ? (
            // what the reader just did, and the way out of it.  It replaces the
            // mode hint for those few seconds because that is the moment the
            // hint is least useful and the mistake is most likely
            <>
              已高亮 ·{' '}
              <button
                style={{ padding: '1px 6px', fontSize: '0.733rem' }}
                title="撤销这条高亮"
                onClick={() => void undoHighlight(justMade)}
              >
                撤销
              </button>
            </>
          ) : marking ? (
            `拖选即高亮 · 本页 ${pageAnns.length} 条`
          ) : (
            `拖选即选中文字，可以复制 · 本页 ${pageAnns.length} 条标注`
          )}
        </span>
      </div>

      {findOpen && (
        <div className="pdf-find">
          <input
            ref={findInput}
            value={findQ}
            placeholder="在这篇 PDF 里查找…"
            onChange={(e) => setFindQ(e.target.value)}
          />
          <button
            disabled={!findHits.length}
            title="上一个 (Shift+Enter)"
            onClick={() => gotoHit(findAt - 1)}
          >
            ↑
          </button>
          <button
            disabled={!findHits.length}
            title="下一个 (Enter / F3)"
            onClick={() => gotoHit(findAt + 1)}
          >
            ↓
          </button>
          <span className="find-count">
            {findBusy
              ? '查找中…'
              : findHits.length
                ? `${findAt + 1} / ${findHits.length}`
                : findQ.trim().length >= 2
                  ? '无匹配'
                  : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button title="关闭 (Esc)" onClick={() => setFindOpen(false)}>
            ×
          </button>
        </div>
      )}

      {msg && (
        <div className="pdf-msg" onClick={() => setMsg(null)}>
          {msg}
        </div>
      )}

      {selected && (
        <div className="ann-box">
          <span style={{ color: 'var(--fg-dim)' }}>颜色</span>
          {PALETTE.map((c) => (
            <button
              key={c}
              className="swatch"
              style={{ background: c, outline: selected.color === c ? '2px solid var(--accent)' : 'none' }}
              onClick={() => recolor(selected.id, c)}
              title={c}
            />
          ))}
          <span style={{ flex: 1 }} />
          <button className="danger" onClick={() => remove(selected.id)}>
            删除
          </button>
          <input
            placeholder="笔记…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => saveNote(selected.id, note)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveNote(selected.id, note)
            }}
            style={{ flex: 2, minWidth: 120 }}
          />
        </div>
      )}

      <div className="pdf-body">
        {side !== 'none' && (
          <div className="pdf-outline">
            {side === 'outline'
              ? (outline ?? []).map((r, i) => (
                  <div
                    key={i}
                    className="ol-row"
                    style={{ paddingLeft: 6 + r.depth * 12 }}
                    title={r.node.title}
                    onClick={() => goTo(r.node)}
                  >
                    {r.node.title || '(无标题)'}
                  </div>
                ))
              : annsByPage.map((a) => (
                  <div
                    key={a.id}
                    className="ol-row"
                    onClick={() => {
                      setPage(a.page)
                      setSel(a.id)
                      setNote(a.note ?? '')
                      if (continuous) scrollToPage(a.page)
                    }}
                    title={a.note || a.text || '高亮'}
                  >
                    <span
                      className="ann-dot"
                      style={{ background: a.color }}
                    />
                    <span className="pg">p{a.page}</span>
                    {a.note || a.text || (a.type === 'note' ? '笔记' : '高亮')}
                  </div>
                ))}
            {side === 'anns' && !annsByPage.length && (
              <div className="empty" style={{ padding: '0.4rem 0.6rem' }}>
                这篇还没有标注
              </div>
            )}
          </div>
        )}
        {!continuous ? (
          <div className="pdf-scroll" ref={scrollRef}>
            <div
              ref={wrapRef}
              className={marking ? 'marking' : undefined}
              style={{ position: 'relative', display: 'inline-block' }}
              onMouseDown={onDown}
              onMouseMove={onMove}
              onMouseUp={onUp}
            >
              <canvas ref={canvasRef} style={{ display: 'block' }} />
              {pageAnns.map((a) =>
                rectsFor(a, page).map((r, i) => overlay(a, r, `${a.id}-${i}`))
              )}
              {findMarks(page)}
              {drag && rubberBand(drag)}
              {/* invisible, selectable, the reason highlights follow words */}
              <div className="tx-layer" ref={layerRef} />
            </div>
          </div>
        ) : (
          <div
            className="pdf-scroll pdf-cont"
            ref={contRef}
            onScroll={onContScroll}
          >
            {/* one box per page: the sum of their heights is the scroll range,
                and only the ones in view get a canvas painted into them */}
            {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
              const s = sizes[n]
              const h = s ? s.h * scale : 0
              const w = s ? s.w * scale : 0
              return (
                <div
                  key={n}
                  className={marking ? 'pg-wrap marking' : 'pg-wrap'}
                  data-page={n}
                  style={{ height: h ? h + PGAP : undefined, width: w || undefined }}
                  onMouseDown={onDown}
                  onMouseMove={onMove}
                  onMouseUp={onUp}
                >
                  <div
                    className="pg-box"
                    style={{ width: w || undefined, height: h || undefined }}
                  >
                    <canvas
                      ref={(el) => {
                        if (el) contCanvas.current.set(n, el)
                        else contCanvas.current.delete(n)
                      }}
                      style={{ display: 'block' }}
                    />
                    {annsOn(n).map((a) =>
                      rectsFor(a, n).map((r, i) => overlay(a, r, `${a.id}-${i}`))
                    )}
                    {findMarks(n)}
                    {drag && dragPage.current === n && rubberBand(drag)}
                    <div
                      className="tx-layer"
                      ref={(el) => {
                        if (el) contLayer.current.set(n, el)
                        else contLayer.current.delete(n)
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
