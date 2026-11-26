import { ipcMain } from 'electron'
import { buildRefsIndex, refsStatus, searchRefsAsync } from '../refsindex'
import { getWin } from '../window'

/**
 * The references-search channels.  A build reads every local PDF, so it is
 * started on request and pushes its progress instead of blocking an invoke.
 * Search is driven across event-loop turns like the full-text scan, so a
 * large reference table cannot keep every other channel waiting.
 */
export function registerRefsIpc() {
  ipcMain.handle('refs:build', async () => {
    try {
      return await buildRefsIndex((p) => getWin()?.webContents.send('refs:progress', p))
    } catch (e) {
      return { error: String(e) }
    }
  })

  ipcMain.handle('refs:search', async (_e, q: string) => {
    try {
      return await searchRefsAsync(q)
    } catch (e) {
      return { error: String(e) }
    }
  })

  ipcMain.handle('refs:status', () => {
    try {
      return refsStatus()
    } catch (e) {
      return { error: String(e) }
    }
  })
}
