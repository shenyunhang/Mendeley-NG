import { app, ipcMain } from 'electron'
import { findToken } from '../mendeley'
import { sync } from '../library'
import { loadConfig, loadLibrary, saveConfig } from '../store'
import { setFullTextPages } from '../fulltext'
import { status } from '../window'
import type { AppConfig } from '../../../shared/types'

/**
 * True for `--demo`, the screenshot run against the invented library.
 *
 * Syncing is refused and the token check is answered yes.  A screenshot run
 * has no business reaching the network, and it has no business showing the
 * first-run guide either, because the guide is what an empty library looks
 * like and the point is to photograph a full one.
 *
 * It lives here rather than in the entry point because what it changes is how
 * the library answers, and both of the channels that ask are in this file.
 */
let demoMode = false

export function setDemoMode(v: boolean) {
  demoMode = v
}

export function registerLibraryIpc() {
  ipcMain.handle('library:load', () => {
    try {
      return loadLibrary()
    } catch (e) {
      return { error: String(e) }
    }
  })

  ipcMain.handle('library:sync', async (_e, full: boolean) => {
    if (demoMode) return loadLibrary()
    try {
      return await sync(full)
    } catch (e) {
      const msg = String(e)
      status({ phase: 'error', done: 0, total: 0, message: msg })
      return { error: msg }
    }
  })

  ipcMain.handle('library:hasToken', () => demoMode || !!findToken())

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', (_e, c: Partial<AppConfig>) => {
    const cur = loadConfig()
    saveConfig({ ...cur, ...c })
    // The full-text page budget lives in the index, not just in the config: it
    // has to take effect the moment it is written, or the index on disk keeps
    // describing a corpus nobody is asking about any more.
    if (typeof c.ftPages === 'number') setFullTextPages(c.ftPages)
    return loadConfig()
  })
}
