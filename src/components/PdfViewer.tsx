import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

/** Highlight colours, roughly the ones Mendeley Desktop offered. */
const PALETTE = ['#ffe066', '#a9e34b', '#74c0fc', '#ffa8a8', '#d0bfff']

/**
 * How the zoom is chosen.  `fit-width` and `fit-page` are recomputed from the
 * viewport, so they survive a window resize; any manual zoom step drops back
 * to `manual`, because silently snapping back on the next page turn would
 * fight the user.
 */
type ZoomMode = 'manual' | 'fit-width' | 'fit-page'

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
  onLocalPdf
}: {
  doc: Doc
  onLocalPdf?: (docId: string, p: string) => void
}) {
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.3)
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width')
  const [tick, setTick] = useState(0)
  const [outline, setOutline] = useState<OutlineRow[] | null>(null)
  const [side, setSide] = useState<'none' | 'outline' | 'anns'>('none')
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
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes

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
    const s = sizes[page]
    if (!el || !s || !s.w || !s.h) return
    const box = el.getBoundingClientRect()
    const availW = box.width - FIT_PAD - SCROLLBAR
    const availH = box.height - FIT_PAD
    if (availW <= 0 || availH <= 0) return
    const byWidth = availW / s.w
    const next =
      zoomMode === 'fit-width' ? byWidth : Math.min(byWidth, availH / s.h)
    setScale(Math.max(0.2, Math.min(6, next)))
  }, [zoomMode, page, sizes, tick])

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
    if (!pdf || !canvas) return
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
  }, [pdf, page, scale, numPages, renderTo])

  /**
   * An invisible layer of one span per text run, laid out to match the glyphs.
   * Its only job is to make the page selectable, so that a highlight follows
   * the words instead of a hand-drawn box.  The text is transparent and the
   * browser's own selection colour is what the user sees.
   */
  const drawTextLayer = async (pg: pdfjs.PDFPageProxy, viewport: pdfjs.PageViewport) => {
    const layer = layerRef.current
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

  /** Rects covering the current browser selection, in 0..1 page coordinates. */
  const rectsFromSelection = (): Rect[] => {
    const layer = layerRef.current
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

  /** Rects to draw for `a` on `page`, in 0..1 with y from the top. */
  const rectsFor = (a: Annotation): Rect[] => {
    if (a.pos && a.pos.length) {
      const out: Rect[] = []
      for (const p of a.pos) {
        if (p.page !== page) continue
        const s = sizes[p.page]
        if (!s) continue
        out.push(posToRect(p, s))
      }
      return out
    }
    return a.page === page ? a.rects : []
  }

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

  const commitHighlight = async (rects: Rect[]) => {
    if (!rects.length) return
    const s = await sizeOf(page)
    const a: Annotation = {
      id: `${doc.id}-${page}-${Date.now()}`,
      docId: doc.id,
      page,
      type: 'highlight',
      color: '#ffe066',
      rects,
      // keep the authoritative copy in PDF points so a cloud round trip does
      // not drift when the page is later rendered at another zoom level
      pos: s ? rects.map((r) => rectToPos(r, page, s)) : undefined,
      created: new Date().toISOString()
    }
    const all = await window.api.loadAnnotations()
    const next = [...all, a]
    await window.api.saveAnnotations(next)
    setAnns(next.filter((x) => x.docId === doc.id))
    setSel(a.id)
  }

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

  const onDown = (e: React.MouseEvent) => {
    const box = wrapRef.current!.getBoundingClientRect()
    dragStart.current = { x: e.clientX - box.left, y: e.clientY - box.top }
    setDrag(null)
  }
  const onMove = (e: React.MouseEvent) => {
    if (!dragStart.current) return
    // while the browser is building a text selection, drawing a rubber band
    // on top of it is just noise
    if (!(window.getSelection()?.isCollapsed ?? true)) return
    const box = wrapRef.current!.getBoundingClientRect()
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
    // a real text selection wins: it follows the words rather than a box
    const picked = rectsFromSelection()
    if (picked.length) {
      await commitHighlight(picked)
      window.getSelection()?.removeAllRanges()
    } else if (drag && drag.w > 0.01 && drag.h > 0.005) {
      await commitHighlight([drag])
    } else {
      setSel(null)
    }
    dragStart.current = null
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
      if (Number.isFinite(idx)) setPage(idx + 1)
    } catch {
      /* outlines pointing at a missing destination are common enough */
    }
  }

  const selected = anns.find((a) => a.id === sel) || null
  const pageAnns = anns.filter((a) =>
    a.pos ? a.pos.some((p) => p.page === page) : a.page === page
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

  if (!doc.localPdf) {
    return (
      <div className="empty">
        <div>这篇没有本地 PDF（云端标记：{doc.file_attached ? '有文件' : '无文件'}）</div>
        {doc.file_attached && (
          <button style={{ marginTop: 10 }} onClick={download} disabled={busy}>
            {busy ? '下载中…' : '从云端下载 PDF'}
          </button>
        )}
        {msg && <div className="pdf-msg">{msg}</div>}
      </div>
    )
  }
  if (err) return <div className="err">PDF 打开失败：{err}</div>

  return (
    <div className="pdf-pane">
      <div className="pdf-bar">
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
          ←
        </button>
        <input
          style={{ width: 58 }}
          value={page}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10)
            if (Number.isFinite(n)) setPage(Math.min(Math.max(1, n), numPages || 1))
          }}
        />
        <span>
          / {numPages || '…'}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(numPages, p + 1))}
          disabled={page >= numPages}
        >
          →
        </button>
        <span style={{ marginLeft: 8 }} />
        <button
          title="缩小（切到手动缩放）"
          onClick={() => {
            setZoomMode('manual')
            setScale((s) => Math.max(0.2, s - 0.2))
          }}
        >
          −
        </button>
        <span style={{ minWidth: 46, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
        <button
          title="放大（切到手动缩放）"
          onClick={() => {
            setZoomMode('manual')
            setScale((s) => Math.min(6, s + 0.2))
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
          className={side === 'outline' ? 'primary' : ''}
          disabled={!outline?.length}
          title={outline?.length ? '显示 PDF 目录' : '这个 PDF 没有目录'}
          onClick={() => setSide((v) => (v === 'outline' ? 'none' : 'outline'))}
        >
          目录
        </button>
        <button
          className={side === 'anns' ? 'primary' : ''}
          title="列出本篇全部标注，点一条跳到那一页"
          onClick={() => setSide((v) => (v === 'anns' ? 'none' : 'anns'))}
        >
          标注 {anns.length ? `(${anns.length})` : ''}
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={syncCloud} disabled={busy}>
          云同步标注
        </button>
        <span style={{ color: 'var(--fg-dim)', marginLeft: 8 }}>
          拖框可高亮 · 本页 {pageAnns.length} 条
        </span>
      </div>

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
        <div className="pdf-scroll" ref={scrollRef}>
          <div
            ref={wrapRef}
            style={{ position: 'relative', display: 'inline-block' }}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
          >
            <canvas ref={canvasRef} style={{ display: 'block' }} />
            {pageAnns.map((a) =>
              rectsFor(a).map((r, i) => (
                <div
                  key={a.id + i}
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
              ))
            )}
            {drag && (
              <div
                style={{
                  position: 'absolute',
                  left: `${drag.x * 100}%`,
                  top: `${drag.y * 100}%`,
                  width: `${drag.w * 100}%`,
                  height: `${drag.h * 100}%`,
                  background: '#ffe066',
                  opacity: 0.35,
                  pointerEvents: 'none'
                }}
              />
            )}
            {/* invisible, selectable, and the reason highlights follow words */}
            <div className="tx-layer" ref={layerRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
