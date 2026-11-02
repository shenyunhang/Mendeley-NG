import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Annotation, Doc, PdfPos } from '../../shared/types'
import {
  FIT_PAD,
  PALETTE,
  PGAP,
  SCROLLBAR,
  bitmapKey,
  clampScale,
  flattenOutline,
  fromCloudPositions,
  posToRect,
  rectToPos,
  type FindHit,
  type OutlineNode,
  type OutlineRow,
  type Rect,
  type Size,
  type TextRun,
  type ZoomMode
} from '../lib/pdfgeom'
import { PrefetchCache } from '../lib/pdfcache'
import { selectionRects } from '../lib/pdfsel'
import { drawTextLayer } from '../lib/pdftext'
import { useContinuousPages } from '../lib/hooks/useContinuousPages'
import { usePdfFind } from '../lib/hooks/usePdfFind'
import { usePdfLinks } from '../lib/hooks/usePdfLinks'
import { usePdfAnnotations } from '../lib/hooks/usePdfAnnotations'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export default function PdfViewer({
  doc,
  onLocalPdf,
  jumpTo,
  hitQuery,
  confirm
}: {
  doc: Doc
  onLocalPdf?: (docId: string, p: string) => void
  /** Open at this page.  The nonce is what makes a second jump to the same
   *  page on the same document possible, e.g. two hits on page 3. */
  jumpTo?: { page: number; nonce: number } | null
  /** The word the library was searched for, to be marked on the paper.  See
   *  the effect that watches it for why it is marked rather than looked up. */
  hitQuery?: string
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
  const [err, setErr] = useState<string | null>(null)
  const [drag, setDrag] = useState<Rect | null>(null)
  const [sizes, setSizes] = useState<Record<number, Size>>({})
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** The pane as a whole: what the zoom gesture and the find keys are scoped
   *  to, as opposed to the canvas inside it. */
  const paneRef = useRef<HTMLDivElement>(null)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pdf]
  )

  const {
    contCanvas,
    contLayer,
    contRef,
    visible,
    scrollToPage,
    onScroll: onContScroll
  } = useContinuousPages({
    pdf,
    scale,
    numPages,
    continuous,
    docKey: doc.localPdf,
    sizes,
    sizesRef,
    pageRef,
    onPage: setPage,
    sizeOf
  })

  const {
    anns,
    sel,
    setSel,
    justMade,
    setJustMade,
    rectsFor,
    annsOn,
    commitHighlight,
    undoHighlight,
    syncCloud,
    remove,
    recolor,
    saveNote,
    annsByPage
  } = usePdfAnnotations({
    docId: doc.id,
    sizes,
    sizeOf,
    confirm,
    busy,
    onBusy: setBusy,
    onMsg: setMsg
  })

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

  /** Bitmaps of the pages next to this one.  The cache itself — what to keep,
   *  what to drop, what is already in flight — is none of this component's
   *  business; see `PrefetchCache`. */
  const prefetch = useRef(new PrefetchCache())

  // A different document makes every cached bitmap wrong.  A different scale
  // does not: the key carries the scale, so stale entries simply miss and get
  // pushed out by the LRU.  Clearing on every scale change used to throw away
  // the neighbours a moment before the user turned to them.
  //
  useEffect(() => {
    prefetch.current.clear()
  }, [doc.localPdf])

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
    return prefetch.current.warm(bitmapKey(n, s, dpr), () => {
      // created inside, so a warm that finds the page already cached costs
      // nothing at all
      const off = document.createElement('canvas')
      return renderTo(off, n, s).then(() => off)
    })
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
    const key = bitmapKey(page, scale, dpr)
    let cached = prefetch.current.peek(key)
    const pg = await pdf.getPage(page)
    const viewport = pg.getViewport({ scale })
    // a bitmap only helps if it is already the right size; anything else
    // means the scale or the device pixel ratio moved on
    const fits = (c: HTMLCanvasElement | undefined) =>
      !!c &&
      c.width === Math.floor(viewport.width * dpr) &&
      c.height === Math.floor(viewport.height * dpr)

    if (!cached) {
      const flight = prefetch.current.flight(key)
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
      prefetch.current.touch(key)
      await drawTextLayer(pg, viewport, layerRef.current)
      document.documentElement.dataset.renderSrc = 'cache'
      prefetch.current.stamp()
      // the turn came from the cache, so the neighbours of the new page are
      // the ones worth warming now
      warmAround(page, scale)
      return
    }
    if (cached) {
      prefetch.current.drop(key)
      document.documentElement.dataset.pfLast = 'size-mismatch'
    }
    prefetch.current.stamp()

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
    await drawTextLayer(pg, viewport, layerRef.current)

    // Warm the neighbours now that the page the user asked for is on screen.
    warmAround(page, scale)
  }, [pdf, page, scale, numPages, renderTo, continuous])

  /**
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

  /**
   * Finding a word in the paper.  One hook, and one jump it is allowed to
   * make: `reveal` moves the page box and the column together, which is what
   * a hit needs — the page box alone only labels a page, it does not bring it
   * into view.
   */
  const reveal = (n: number) => {
    setPage(n)
    if (continuous) requestAnimationFrame(() => scrollToPage(n))
  }
  const {
    findOpen,
    setFindOpen,
    findQ,
    setFindQ,
    findHits,
    findAt,
    findBusy,
    findInput,
    closeFind,
    gotoHit
  } = usePdfFind({
    pdf,
    numPages,
    pageRef,
    docKey: doc.localPdf,
    hitQuery,
    paneRef,
    onJump: reveal
  })

  const { links } = usePdfLinks({
    pdf,
    numPages,
    continuous,
    page,
    docKey: doc.localPdf
  })

  /** Which layers the selection could have been made in.  In continuous mode
   *  the column has one text layer per page, so they are tried in reading
   *  order; the single page has only its own. */
  const selLayers = (): Array<[number, HTMLElement | null | undefined]> =>
    continuous
      ? [...visible.current]
          .sort((a, b) => a - b)
          .map((n) => [n, contLayer.current.get(n)])
      : [[page, layerRef.current]]

  useEffect(() => {
    render().catch((e) => {
      // cancelling is a normal part of switching zoom, not a failure
      if ((e as { name?: string })?.name === 'RenderingCancelledException') return
      setErr(String(e))
    })
  }, [render])

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
    const picked = selectionRects(selLayers(), page)
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

  /**
   * The links of one page, as a transparent layer over the paper.
   *
   * Nothing is drawn for them until the pointer is over one: a paper carries
   * dozens of links and a page full of blue boxes is worse than a page without
   * links, because it makes every sentence look like it goes somewhere.  A
   * hover ring and a pointing hand are enough to say "this one does".
   *
   * The whole layer stands down while highlighting is on.  Marking is a drag
   * across the page, and a link in the way would turn every one of those drags
   * into a jump to somewhere the reader was not going.
   */
  // Held in a ref so the layers below can be memoised.  A paper carries
  // dozens of links a page and the whole column is mounted at once, so that
  // is the better part of a thousand anchors; rebuilt on every render of the
  // window they cost more than a keystroke is allowed to, and rebuilding them
  // is pointless because nothing about them changes.  Memoising hands React
  // the very same element next time and it walks past the whole subtree.
  const revealRef = useRef(reveal)
  revealRef.current = reveal

  const linkLayers = useMemo(() => {
    const out: Record<number, ReactNode> = {}
    for (const k of Object.keys(links)) {
      const n = Number(k)
      if (!links[n].length) continue
      out[n] = links[n].map((l, i) => (
        <a
          key={`l-${i}`}
          className={l.url ? 'pdf-link ext' : 'pdf-link'}
          href={l.url ?? `#page-${l.page}`}
          title={l.url ? l.url : `跳到第 ${l.page} 页`}
          style={{
            position: 'absolute',
            left: `${l.x * 100}%`,
            top: `${l.y * 100}%`,
            width: `${l.w * 100}%`,
            height: `${l.h * 100}%`,
            // the layer only claims the pointer when it is allowed to answer it
            pointerEvents: marking ? 'none' : 'auto'
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (l.page) revealRef.current(l.page)
            else if (l.url) void window.api.openExternal(l.url)
          }}
        />
      ))
    }
    return out
  }, [links, marking])

  const linkMarks = (n: number) => linkLayers[n] ?? null

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
        <span className="pdf-hint" style={{ color: 'var(--fg-dim)', marginLeft: 8 }}>
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

      {/* The find bar used to be a row of its own under the toolbar, which put
          the count somewhere the reader is not looking: the matches are in the
          page, and so is the number that says how many there are.  It floats
          over the top right corner of the page instead, which is also where it
          does not push the page down every time it is opened. */}

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
              {linkMarks(page)}
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
                    {linkMarks(n)}
                  </div>
                </div>
              )
            })}
          </div>
        )}

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
                  ? `第 ${findAt + 1} 个匹配 · 共 ${findHits.length} 个`
                  : findQ.trim().length >= 2
                    ? '无匹配'
                    : ''}
            </span>
            <button title="关闭 (Esc)" onClick={closeFind}>
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
