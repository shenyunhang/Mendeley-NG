import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ensureClient } from '../library'
import { pdfNameFor } from '../pdfname'
import { ftCancel, ftClear, ftSearch, ftStatus } from '../fulltext'
import { ftDocs, indexAdded, startBuild } from '../ftops'
import { DEFAULT_PDF_DIR, loadConfig, loadLibrary, saveLibrary } from '../store'
import type { Doc } from '../../../shared/types'

export function registerFilesIpc() {

  /**
   * Rename every local PDF to the template, or say what it would do.
   * `apply: false` is a preview: renaming files on disk is not something to
   * discover the shape of by doing it.
   */
  ipcMain.handle(
    'pdf:rename',
    async (_e, template: string, apply: boolean) => {
      const lib = loadLibrary()
      if (!lib) return { total: 0, renamed: 0, skipped: 0, sample: [] as string[] }
      const plan: { doc: Doc; from: string; to: string }[] = []
      for (const d of lib.docs) {
        const from = d.localPdf
        if (!from || !fs.existsSync(from)) continue
        const to = path.join(path.dirname(from), pdfNameFor(d, undefined, template))
        if (path.normalize(to) === path.normalize(from)) continue
        plan.push({ doc: d, from, to })
      }
      const sample = plan.slice(0, 5).map((p) => `${path.basename(p.from)}  ->  ${path.basename(p.to)}`)
      if (!apply) return { total: plan.length, renamed: 0, skipped: 0, sample }

      let renamed = 0
      let skipped = 0
      const touched = new Set<string>()
      for (const p of plan) {
        // a name that is already taken is left alone rather than overwritten:
        // two papers can legitimately want the same file name
        if (fs.existsSync(p.to)) {
          skipped++
          continue
        }
        try {
          fs.renameSync(p.from, p.to)
          p.doc.localPdf = p.to
          touched.add(p.doc.id)
          renamed++
        } catch {
          skipped++
        }
      }
      if (renamed) {
        saveLibrary(lib.docs, lib.folders)
        // The papers have moved, so the paths the index recorded for them are
        // now names that do not exist.  The text is still the right text — it
        // came from the same file — but the entry is made to say where it is
        // now, or the next thing that compares the two decides a paper changed
        // because it moved, and reads a library's worth of PDFs to find out
        // that it did not.
        for (const d of lib.docs) if (touched.has(d.id)) indexAdded(d)
      }
      return { total: plan.length, renamed, skipped, sample }
    }
  )

  ipcMain.handle('pdf:download', async (_e, docId: string) => {
    try {
      const c = ensureClient()
      const meta = await c.fileMeta(docId)
      if (!meta) return { ok: false, error: '云端没有这篇的附件' }
      const buf = await c.downloadFile(meta.id)
      const cfg = loadConfig()
      const dir = cfg.pdfDir || DEFAULT_PDF_DIR
      fs.mkdirSync(dir, { recursive: true })
      const lib = loadLibrary()
      const doc = lib?.docs.find((d) => d.id === docId)
      let dest = path.join(dir, pdfNameFor(doc, meta.file_name, cfg.pdfNameTemplate))
      for (let n = 2; fs.existsSync(dest) && n < 50; n++) {
        dest = path.join(
          dir,
          pdfNameFor(doc, meta.file_name, cfg.pdfNameTemplate).replace(/\.pdf$/, ` (${n}).pdf`)
        )
      }
      fs.writeFileSync(dest, buf)
      if (lib && doc) {
        doc.localPdf = dest
        saveLibrary(lib.docs, lib.folders)
        // a paper pulled down from the cloud is as new to the index as one that
        // was imported; it has to be searchable for the same reason
        indexAdded(doc)
      }
      return { ok: true, path: dest, size: buf.length }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('pdf:read', async (_e, p: string) => {
    try {
      const buf = fs.readFileSync(p)
      return { ok: true, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  // Full-text search.  Building the index reads every local PDF, which takes
  // minutes on a large library, so it is started on request and reports
  // progress rather than blocking an invoke for the whole run.
  ipcMain.handle('ft:status', () => ftStatus(ftDocs()))
  ipcMain.handle('ft:build', (_e, rebuild?: boolean) => startBuild(!!rebuild))
  // Stopping a build has to be its own call.  The build is answered
  // immediately and runs in the background, so "cancel" cannot arrive on the
  // same channel as the thing being cancelled.
  ipcMain.handle('ft:cancel', () => {
    ftCancel()
    return ftStatus(ftDocs())
  })
  ipcMain.handle('ft:clear', () => {
    ftClear()
    return ftStatus(ftDocs())
  })
  ipcMain.handle('ft:search', (_e, q: string) => ftSearch(q))
}
