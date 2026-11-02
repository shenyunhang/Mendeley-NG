import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { importTokenFrom } from '../mendeley'
import { resetClient } from '../library'
import { DEFAULT_PDF_DIR, loadConfig, saveConfig } from '../store'
import { getWin } from '../window'

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
        saveConfig({ ...cfg, exportDir: path.dirname(r.filePath) })
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
