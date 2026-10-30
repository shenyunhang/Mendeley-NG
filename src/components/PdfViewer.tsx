import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Annotation, Doc } from '../../shared/types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export default function PdfViewer({ doc }: { doc: Doc }) {
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.3)
  const [err, setErr] = useState<string | null>(null)
  const [anns, setAnns] = useState<Annotation[]>([])
  const [drag, setDrag] = useState<Rect | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  // load annotations for this document
  useEffect(() => {
    window.api.loadAnnotations().then((all) => {
      setAnns(all.filter((a) => a.docId === doc.id))
    })
  }, [doc.id])

  useEffect(() => {
    setPage(1)
    setErr(null)
    setPdf(null)
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

  const pageAnns = anns.filter((a) => a.page === page)

  const commitHighlight = async (r: Rect) => {
    const all = await window.api.loadAnnotations()
    const a: Annotation = {
      id: `${doc.id}-${page}-${Date.now()}`,
      docId: doc.id,
      page,
      type: 'highlight',
      color: '#ffe066',
      rects: [r],
      created: new Date().toISOString()
    }
    const next = [...all, a]
    await window.api.saveAnnotations(next)
    setAnns(next.filter((x) => x.docId === doc.id))
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
    dragStart.current = null
    setDrag(null)
  }

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
        <span className="grow" style={{ flex: 1 }} />
        <span style={{ color: 'var(--fg-dim)' }}>拖框可高亮 · 本页 {pageAnns.length} 条</span>
      </div>

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
            a.rects.map((r, i) => (
              <div
                key={a.id + i}
                title={a.note || '高亮'}
                style={{
                  position: 'absolute',
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                  background: a.color,
                  opacity: 0.32,
                  pointerEvents: 'none',
                  mixBlendMode: 'multiply'
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
