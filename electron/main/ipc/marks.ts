import { ipcMain } from 'electron'
import { ensureClient } from '../library'
import {
  loadAnnotations,
  loadNotes,
  loadReading,
  saveAnnotations,
  saveNotes,
  saveReading
} from '../store'
import type { Annotation, CloudAnnotation } from '../../../shared/types'
import {
  applyMergedAnnotations,
  markPushed,
  mergeCloudAnnotations
} from '../../../src/lib/annotationMerge'

export function registerMarksIpc() {
  ipcMain.handle('annotations:pull', async (_e, docId: string) => {
    const c = ensureClient()
    return c.listAnnotations(docId)
  })

  ipcMain.handle('annotations:fileHash', async (_e, docId: string) => {
    const c = ensureClient()
    return c.fileHash(docId)
  })

  ipcMain.handle(
    'annotations:push',
    async (_e, docId: string, filehash: string, items: { page: number; x: number; y: number; w: number; h: number }[]) => {
      const c = ensureClient()
      const out: CloudAnnotation[] = []
      for (const it of items) {
        const created = await c.createAnnotation({
          document_id: docId,
          filehash,
          type: 'highlight',
          positions: [
            {
              top_left: { x: it.x, y: it.y },
              bottom_right: { x: it.x + it.w, y: it.y + it.h },
              page: it.page
            }
          ]
        })
        out.push(created)
      }
      return out
    }
  )

  ipcMain.handle('annotations:deleteRemote', async (_e, id: string) => {
    const c = ensureClient()
    await c.deleteAnnotation(id)
    return { ok: true }
  })

  /**
   * One quiet, best-effort pass over the papers that already have local marks.
   *
   * Only those papers are asked about: a library-wide pull of annotations
   * would turn "a start-up sync nobody notices" into thousands of requests.
   * It runs in the background, one paper at a time, and never rejects — the
   * renderer has no banner to show and the cached marks stay on screen. Each
   * paper is its own unit, so one broken id cannot stop the rest.
   *
   * Writing back always re-reads the file and only adds or updates the fields
   * the cloud owns, because the reader may be drawing a highlight while this
   * is talking to the network.
   */
  ipcMain.handle('annotations:syncAtStart', async () => {
    const out = { docs: 0, pulled: 0, pushed: 0, skipped: [] as string[] }
    let c: ReturnType<typeof ensureClient>
    try {
      c = ensureClient()
    } catch (e) {
      out.skipped.push('client: ' + String(e))
      return out
    }
    const docIds = [...new Set(loadAnnotations().map((a) => a.docId))]
    out.docs = docIds.length
    for (const docId of docIds) {
      try {
        const cloud = await c.listAnnotations(docId)
        const mine = loadAnnotations().filter((a) => a.docId === docId)
        const { merged, toPush } = mergeCloudAnnotations(
          docId,
          mine,
          cloud,
          new Date().toISOString()
        )
        saveAnnotations(applyMergedAnnotations(loadAnnotations(), docId, merged))
        out.pulled += cloud.length
        if (!toPush.length) continue
        const hash = await c.fileHash(docId)
        if (!hash) continue
        for (const item of toPush) {
          const created = await c.createAnnotation({
            document_id: docId,
            filehash: hash,
            type: 'highlight',
            positions: item.pos.map((p) => ({
              top_left: { x: p.x, y: p.y },
              bottom_right: { x: p.x + p.w, y: p.y + p.h },
              page: p.page
            }))
          })
          if (created?.id) {
            saveAnnotations(markPushed(loadAnnotations(), item.id, created.id, item.pos))
            out.pushed += 1
          }
        }
      } catch (e) {
        out.skipped.push(docId + ': ' + String(e))
      }
    }
    return out
  })

  ipcMain.handle('annotations:load', () => loadAnnotations())
  ipcMain.handle('annotations:save', (_e, list: Annotation[]) => {
    saveAnnotations(list)
    return { ok: true }
  })

  // notes are local only: Mendeley's /notes endpoint does not exist
  ipcMain.handle('notes:load', () => loadNotes())
  ipcMain.handle('notes:save', (_e, notes: Record<string, string>) => {
    saveNotes(notes)
    return { ok: true }
  })

  // Reading position is a whole-file rewrite per change, but a change is one
  // debounced write per document left, not one per page turned, so it stays
  // cheap.  Kept in the main process so the renderer cannot lose it by
  // navigating away mid-write.
  ipcMain.handle('reading:load', () => loadReading())
  ipcMain.handle('reading:set', (_e, docId: string, page: number) => {
    // Re-read before every write. A process-local snapshot looked cheaper but
    // went stale the moment anything else wrote reading.json: the next set put
    // the old pages back, and reading:load -- which always reads the file --
    // disagreed with what had just been saved. The file is a handful of page
    // numbers, so one extra read per debounced write costs nothing.
    const reading = loadReading()
    reading[docId] = Math.max(1, Math.floor(Number(page) || 1))
    saveReading(reading)
    return { ok: true }
  })
}
