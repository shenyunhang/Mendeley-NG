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
  let reading: Record<string, number> | null = null
  ipcMain.handle('reading:set', (_e, docId: string, page: number) => {
    if (reading === null) reading = loadReading()
    reading[docId] = Math.max(1, Math.floor(Number(page) || 1))
    saveReading(reading)
    return { ok: true }
  })
}
