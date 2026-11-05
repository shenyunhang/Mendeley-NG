import { reportFailure, FAILURE } from '../../../shared/failures'
import { useEffect, useMemo, useRef, useState } from 'react'
import { HIGHLIGHT_UNDO_WINDOW_MS } from '../timing'
import type { Annotation, PdfPos } from '../../../shared/types'
import { fromCloudPositions, posToRect, rectToPos, type Rect, type Size } from '../pdfgeom'
import {
  createDocumentLoad,
  valueForDocument,
  type DocumentLoad,
  type ForDocument
} from '../documentScope'

/** One stable empty list, so a paper with no marks does not hand a new array
 *  to every memo that depends on `anns` on every render. */
const NO_ANNOTATIONS: Annotation[] = []

/**
 * The annotations of one paper: highlights, their notes, and the cloud's copy
 * of them.
 *
 * It is one hook because they are one thing being kept in step — the local
 * list, the copy on Mendeley's servers, and which of them is selected — and
 * because none of it is about zooming, paging or finding.  What it needs from
 * outside is only the document it belongs to, the page sizes (to convert
 * between a rect on screen and a position in PDF points) and the app's one
 * confirmation box.
 *
 * Positions are kept in PDF points and are the authoritative copy: a rect in
 * 0..1 of a page is only meaningful at the size it was measured at, so a cloud
 * round trip through a rect would drift whenever the page was later rendered
 * at another zoom.
 */
export function usePdfAnnotations(o: {
  docId: string
  sizes: Record<number, Size>
  sizeOf: (n: number) => Promise<Size | null>
  /** The app's one confirmation box: deleting an annotation has no way back. */
  confirm: (req: { title: string; body?: string; ok?: string }) => Promise<boolean>
  /** Whether something else is already in flight; a second sync would fight it. */
  busy: boolean
  onBusy: (b: boolean) => void
  onMsg: (m: string | null) => void
}) {
  /**
   * Three pieces of state that all belong to one paper. Each carries the id it
   * was produced for, so switching papers cannot show even one frame of the
   * previous paper's marks, selection or undo affordance. The reader is not
   * keyed by document, so a bare array used to survive the switch.
   */
  const [annotationsAnswer, setAnnotationsAnswer] =
    useState<ForDocument<Annotation[]> | null>(null)
  const [selectedAnswer, setSelectedAnswer] =
    useState<ForDocument<string | null> | null>(null)
  const [justMadeAnswer, setJustMadeAnswer] =
    useState<ForDocument<string | null> | null>(null)

  /**
   * The one read behind a generation guard. Built once and kept in a ref, as
   * `useUndo`'s stack is: it is started by an effect and outlives it, and it
   * must not close over a stale `docId`.
   */
  const loader = useRef<DocumentLoad<Annotation[]> | null>(null)
  if (loader.current === null) {
    loader.current = createDocumentLoad<Annotation[]>(
      (docId) =>
        window.api
          .loadAnnotations()
          .then((all) => all.filter((a) => a.docId === docId)),
      (state) => setAnnotationsAnswer(state),
      NO_ANNOTATIONS
    )
  }

  // Load for this document. Cleanup invalidates the read on a switch or on
  // unmount, so an old paper's file can never write into the new paper's
  // list and nothing calls setState after the reader is gone.
  useEffect(() => {
    loader.current?.start(o.docId)
    return () => loader.current?.cancel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.docId])

  const anns = valueForDocument(annotationsAnswer, o.docId) ?? NO_ANNOTATIONS
  /** `null` is a real answer here — "nothing selected" — and
   *  `valueForDocument` returns it for a matching document, `undefined` for
   *  another one. Both mean the same thing to the reader. */
  const sel = valueForDocument(selectedAnswer, o.docId) ?? null
  const justMade = valueForDocument(justMadeAnswer, o.docId) ?? null

  const setSel = (id: string | null) =>
    setSelectedAnswer({ docId: o.docId, value: id })
  const setJustMade = (id: string | null) =>
    setJustMadeAnswer({ docId: o.docId, value: id })

  /** A local edit wins over a read that is already on its way. Without the
   *  cancel, making a highlight just as the file comes back would have the
   *  old file contents silently replace the mark that was just drawn. */
  const setAnns = (next: Annotation[]) => {
    loader.current?.cancel()
    setAnnotationsAnswer({ docId: o.docId, value: next })
  }

  // A highlight that was just made out of a text selection, so that it can be
  // taken back in one click. Only that kind: dragging a box over the page is
  // an unambiguous request to mark it, where picking words is exactly what
  // somebody does to copy them — and the mode may have been left on from the
  // last paper. Without a way back, one forgotten switch fills a paper with
  // marks that then have to be found and deleted one at a time.
  useEffect(() => {
    if (!justMade) return
    const t = setTimeout(() => setJustMade(null), HIGHLIGHT_UNDO_WINDOW_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justMade])

  /** Rects to draw for `a` on page `n`, in 0..1 with y from the top. */
  const rectsFor = (a: Annotation, n: number): Rect[] => {
    if (a.pos && a.pos.length) {
      const out: Rect[] = []
      for (const p of a.pos) {
        if (p.page !== n) continue
        const s = o.sizes[p.page]
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
      const s = await o.sizeOf(a.page)
      if (!s) continue
      out.push(rectToPos(r, a.page, s))
    }
    return out
  }

  const persist = async (next: Annotation[]) => {
    const all = await window.api.loadAnnotations()
    const others = all.filter((a) => a.docId !== o.docId)
    await window.api.saveAnnotations([...others, ...next])
    setAnns(next)
  }

  /**
   * Save a highlight on page `on`, in that page's own 0..1 rects.
   *
   * `words` are the sentence the mark covers.  They are kept because a
   * highlight that only remembers where it is cannot be read anywhere but on
   * that one page: the sidebar has nothing to name it by, an export has
   * nothing to quote, and if the PDF is ever lost the rectangle points at
   * nothing.
   */
  const commitHighlight = async (
    rects: Rect[],
    on: number,
    words?: string
  ): Promise<string | null> => {
    if (!rects.length) return null
    const s = await o.sizeOf(on)
    const a: Annotation = {
      id: `${o.docId}-${on}-${Date.now()}`,
      docId: o.docId,
      page: on,
      type: 'highlight',
      color: '#ffe066',
      rects,
      ...(words ? { text: words } : {}),
      // keep the authoritative copy in PDF points so a cloud round trip does
      // not drift when the page is later rendered at another zoom level
      pos: s ? rects.map((r) => rectToPos(r, on, s)) : undefined,
      created: new Date().toISOString()
    }
    const all = await window.api.loadAnnotations()
    const next = [...all, a]
    await window.api.saveAnnotations(next)
    setAnns(next.filter((x) => x.docId === o.docId))
    setSel(a.id)
    return a.id
  }

  /** Take the last highlight back, locally first and then in the cloud. */
  const undoHighlight = async (id: string) => {
    const all = await window.api.loadAnnotations()
    const gone = all.find((a) => a.id === id)
    const next = all.filter((a) => a.id !== id)
    await window.api.saveAnnotations(next)
    setAnns(next.filter((x) => x.docId === o.docId))
    setSel(null)
    setJustMade(null)
    // after the local copy is safely written, so a failure here leaves a stray
    // cloud highlight rather than a lost local one
    if (gone?.remoteId) {
      await window.api.deleteRemoteAnnotation(gone.remoteId).catch((e) => reportFailure(FAILURE.cloudHighlightRemoval, e))
    }
  }

  /** Pull cloud annotations, merge them in, then push anything local-only. */
  const syncCloud = async () => {
    if (o.busy) return
    o.onBusy(true)
    o.onMsg('正在与云端同步…')
    try {
      const cloud = await window.api.pullAnnotations(o.docId)
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
          docId: o.docId,
          page: pos[0]?.page ?? prev?.page ?? 1,
        type: c.type === 'sticky_note' ? 'note' : 'highlight',
        color: prev?.color ?? '#ffe066',
        rects: prev?.rects ?? [],
        // Mendeley keeps the rectangles and not the words, so its copy of a
        // highlight made here has no text; taking it would throw away the
        // only record of what was marked
        text: prev?.text ?? c.text,
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
      const hash = await window.api.fileHash(o.docId)
      for (const a of localOnly) {
        if (!hash) break
        const items = await posFor(a)
        if (!items.length) continue
        try {
          const created = await window.api.pushAnnotations(o.docId, hash, items)
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
      o.onMsg(
        `云端 ${cloud.length} 条${hash ? ` · 新上传 ${pushed} 条` : ' · 云端无 filehash，本地高亮未上传'}`
      )
    } catch (e) {
      o.onMsg('同步失败：' + String(e))
    } finally {
      o.onBusy(false)
    }
  }

  const remove = async (id: string) => {
    const target = anns.find((a) => a.id === id)
    if (!target) return
    // Asking here too, and not only in the annotation list, because this is
    // the button next to the highlight itself — the one most easily hit by
    // accident while reaching for the colour swatches beside it.  An
    // annotation has no trash to come back from.
    const go = await o.confirm({
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

  return {
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
  }
}
