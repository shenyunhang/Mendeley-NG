import { useCallback, useEffect, useRef, useState } from 'react'
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

/** Highlight colours, roughly the ones Mendeley Desktop offered. */
const PALETTE = ['#ffe066', '#a9e34b', '#74c0fc', '#ffa8a8', '#d0bfff']

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

export default function PdfViewer({ doc }: { doc: Doc }) {
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.3)
  const [err, setErr] = useState<string | null>(null)
  const [anns, setAnns] = useState<Annotation[]>([])
  const [drag, setDrag] = useState<Rect | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [sizes, setSizes] = useState<Record<number, Size>>({})
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
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
    if (!doc.localPdf) return
    let dead = false
    pdfjs
      .getDocument({ url: window.api.pdfUrl(doc.localPdf) })
      .promise.then((p) => {
        if (dead) {
          p.destroy()
          return
        }
        setPdf(p)
        setNumPages(p.numPages)
      })
      .catch((e) => !dead && setErr(String(e)))
    return () => {
      dead = true
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

  const render = useCallback(async () => {
    const canvas = canvasRef.current
    if (!pdf || !canvas) return
    const pg = await pdf.getPage(page)
    const viewport = pg.getViewport({ scale })
    // devicePixelRatio is what makes this crisp on a 4K panel; Mendeley
    // Desktop rendered at 1x and looked correspondingly soft
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, viewport.width, viewport.height)
    await pg.render({ canvasContext: ctx, viewport }).promise
  }, [pdf, page, scale])

  useEffect(() => {
    render().catch((e) => setErr(String(e)))
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

  const commitHighlight = async (r: Rect) => {
    const s = await sizeOf(page)
    const a: Annotation = {
      id: `${doc.id}-${page}-${Date.now()}`,
      docId: doc.id,
      page,
      type: 'highlight',
      color: '#ffe066',
      rects: [r],
      // keep the authoritative copy in PDF points so a cloud round trip does
      // not drift when the page is later rendered at another zoom level
      pos: s ? [rectToPos(r, page, s)] : undefined,
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
    const box = canvasRef.current!.getBoundingClientRect()
    dragStart.current = { x: e.clientX - box.left, y: e.clientY - box.top }
    setDrag(null)
  }
  const onMove = (e: React.MouseEvent) => {
    if (!dragStart.current) return
    const box = canvasRef.current!.getBoundingClientRect()
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
    if (drag && drag.w > 0.01 && drag.h > 0.005) await commitHighlight(drag)
    else setSel(null)
    dragStart.current = null
    setDrag(null)
  }

  const selected = anns.find((a) => a.id === sel) || null
  const pageAnns = anns.filter((a) =>
    a.pos ? a.pos.some((p) => p.page === page) : a.page === page
  )

  if (!doc.localPdf) {
    return <div className="empty">这篇没有本地 PDF（云端标记：{doc.file_attached ? '有文件' : '无文件'}）</div>
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
        <button onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}>−</button>
        <span style={{ minWidth: 46, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale((s) => Math.min(4, s + 0.2))}>＋</button>
        <button onClick={() => setScale(1.3)}>复位</button>
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

      <div className="pdf-scroll" ref={wrapRef}>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <canvas
            ref={canvasRef}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            style={{ display: 'block' }}
          />
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
        </div>
      </div>
    </div>
  )
}
