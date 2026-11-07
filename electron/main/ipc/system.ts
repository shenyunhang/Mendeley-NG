import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { importTokenFrom } from '../mendeley'
import { authorize } from '../auth'
import { resetClient } from '../library'
import { DEFAULT_PDF_DIR, loadConfig, saveConfig } from '../store'
import { getWin } from '../window'
import type { LeaveProgress } from '../../../shared/types'

export function registerSystemIpc() {
  // The renderer is a file:// page, where navigator.clipboard is a permission
  // policy away from silently doing nothing.  Going through Electron's own
  // clipboard is deterministic, and it lets the smoke run read back what was
  // copied instead of trusting that a write happened.
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  ipcMain.handle('dialog:pickPdfDir', async () => {
    if (!getWin()) return null
    const r = await dialog.showOpenDialog(getWin()!, {
      properties: ['openDirectory'],
      defaultPath: loadConfig().pdfDir || DEFAULT_PDF_DIR
    })
    if (r.canceled || !r.filePaths[0]) return null
    const pdfDir = r.filePaths[0]
    saveConfig({ ...loadConfig(), pdfDir })
    return pdfDir
  })

  /**
   * A folder rather than a file, for the one export that writes several of
   * them.  Remembered in the same `exportDir` the single-file exports use, so
   * the next time — of either kind — starts where the last one ended.
   */
  ipcMain.handle('dialog:pickDir', async (_e, title: string) => {
    if (!getWin()) return null
    const cfg = loadConfig()
    const r = await dialog.showOpenDialog(getWin()!, {
      title: title || '选择文件夹',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: cfg.exportDir || app.getPath('downloads')
    })
    if (r.canceled || !r.filePaths[0]) return null
    const dir = r.filePaths[0]
    // Re-read: anything the reader changed while the dialog was open (theme,
    // font, page budget) must not be rolled back by this stale snapshot.
    saveConfig({ ...loadConfig(), exportDir: dir })
    return dir
  })

  /**
   * What copying the PDFs would actually cost, before anything is copied.
   *
   * Asking "also copy the PDFs?" without a number is asking the reader to
   * guess whether it is forty megabytes or thirty gigabytes, and the wrong
   * guess either fills a disk or leaves them without the files.  Statting a
   * few thousand files is a second or two; being surprised by the size lasts
   * longer.  Files that are no longer where the library thinks they are drop
   * out here, so the number is what will really be written.
   *
   * The target names are made here too, because two papers can easily own the
   * same filename and the second one must not overwrite the first.
   */
  ipcMain.handle('export:pdfPlan', async (_e, files: string[]) => {
    const taken = new Map<string, number>()
    const copies: { from: string; to: string }[] = []
    let bytes = 0
    for (const f of files) {
      let size = 0
      try {
        size = fs.statSync(f).size
      } catch {
        continue
      }
      const base = path.basename(f)
      const dot = base.lastIndexOf('.')
      const stem = dot > 0 ? base.slice(0, dot) : base
      const ext = dot > 0 ? base.slice(dot) : ''
      const n = taken.get(base) ?? 0
      taken.set(base, n + 1)
      copies.push({ from: f, to: `pdf/${n ? `${stem}-${n + 1}${ext}` : base}` })
      bytes += size
    }
    return { copies, bytes }
  })

  /**
   * The way out: every kind of data in the library, written in one go.
   *
   * It lives in the main process because it is thousands of files, and a
   * renderer that dies halfway through leaves a half-copied folder behind
   * with no record of how far it got.  Each PDF is copied on its own: one
   * unreadable file is a line in the summary, not the end of the run — the
   * reader is leaving, and "three of your five thousand papers failed" is
   * something they can act on where "nothing was exported" is not.
   */
  ipcMain.handle(
    'export:leave',
    async (
      _e,
      dir: string,
      files: { name: string; text: string }[],
      copies: { from: string; to: string }[]
    ) => {
      const say = (p: LeaveProgress) => getWin()?.webContents.send('leave:progress', p)
      try {
        fs.mkdirSync(dir, { recursive: true })
        say({ phase: 'files', done: 0, total: files.length, bytes: 0 })
        for (const f of files) {
          fs.writeFileSync(path.join(dir, f.name), f.text, 'utf8')
        }
        say({ phase: 'files', done: files.length, total: files.length, bytes: 0 })

        const failed: { from: string; error: string }[] = []
        let bytes = 0
        let done = 0
        if (copies.length) {
          fs.mkdirSync(path.join(dir, 'pdf'), { recursive: true })
          for (const c of copies) {
            try {
              fs.copyFileSync(c.from, path.join(dir, c.to))
              try {
                bytes += fs.statSync(path.join(dir, c.to)).size
              } catch {
                /* the size is only for the progress line */
              }
            } catch (e) {
              failed.push({ from: c.from, error: String(e) })
            }
            done++
            // every fiftieth, plus the last: five thousand sends would cost
            // more than the copying, and nothing in between is worth seeing
            if (done % 50 === 0 || done === copies.length) {
              say({ phase: 'pdf', done, total: copies.length, bytes })
            }
          }
        }
        say({ phase: 'done', done, total: copies.length, bytes })
        return { dir, files: files.map((f) => f.name), copied: done - failed.length, failed, bytes }
      } catch (e) {
        return { error: String(e) }
      }
    }
  )

  ipcMain.handle('dialog:importToken', async () => {
    if (!getWin()) return null
    const r = await dialog.showOpenDialog(getWin()!, {
      properties: ['openFile'],
      filters: [{ name: 'token.json', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      const got = importTokenFrom(r.filePaths[0])
      resetClient(got.path, got.tok)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  /**
   * The other way to end up with a token, and the one the guide now points
   * at: type the two values from the registration in, sign in once in a
   * window the app opens, and the token is written where the app looks for
   * it.  Kept next to `dialog:importToken` because the two are the same
   * question — how does a token get here — answered two ways.
   */
  ipcMain.handle('auth:authorize', async (_e, clientId: string, clientSecret: string) => {
    try {
      return await authorize(clientId, clientSecret)
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  /**
   * Exports are the one place where a file has to land where the reader said,
   * not wherever the browser keeps downloads: the second export used to arrive
   * as "library (1).bib" and nobody had asked for that.  The folder is
   * remembered so the next export starts where the last one ended.
   *
   * Cancelling is a normal outcome, not a failure — it must not raise a banner.
   */
  ipcMain.handle(
    'dialog:saveText',
    async (_e, name: string, text: string, kind: string, ext: string) => {
      if (!getWin()) return { canceled: true }
      const cfg = loadConfig()
      const r = await dialog.showSaveDialog(getWin()!, {
        title: `导出为 ${kind}`,
        defaultPath: path.join(cfg.exportDir || app.getPath('downloads'), name),
        filters: [{ name: kind, extensions: [ext] }],
        properties: ['showOverwriteConfirmation']
      })
      if (r.canceled || !r.filePath) return { canceled: true }
      try {
        fs.writeFileSync(r.filePath, text, 'utf8')
        saveConfig({ ...loadConfig(), exportDir: path.dirname(r.filePath) })
        return { path: r.filePath }
      } catch (e) {
        return { error: String(e) }
      }
    }
  )

  ipcMain.handle('dialog:openFiles', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '参考文献',
          extensions: ['bib', 'bibtex', 'ris', 'xml', 'enw', 'txt']
        }
      ]
    })
    if (r.canceled || !r.filePaths.length) return []
    return r.filePaths.map((p) => ({
      name: path.basename(p),
      text: fs.readFileSync(p, 'utf-8')
    }))
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    shell.openExternal(url)
    return { ok: true }
  })

  // Sometimes the file itself is the thing to work on: rename it, move it, or
  // read it in an external reader.  Both go through shell rather than child
  // processes, so the file manager and the default PDF handler are the ones the
  // user already chose.
  ipcMain.handle('pdf:reveal', (_e, p: string) => {
    if (!p) return { ok: false, error: 'no path' }
    shell.showItemInFolder(p)
    return { ok: true }
  })

  ipcMain.handle('pdf:openExternal', (_e, p: string) => {
    if (!p) return { ok: false, error: 'no path' }
    return shell.openPath(p)
  })
}
