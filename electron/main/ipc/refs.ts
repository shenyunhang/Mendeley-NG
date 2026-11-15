import { ipcMain } from 'electron'
import { buildRefsIndex, refsStatus, searchRefs } from '../refsindex'
import { getWin } from '../window'

/**
 * The references-search channels.  A build reads every local PDF, so it is
 * started on request and pushes its progress instead of blocking an invoke;
 * search and status are small enough to answer synchronously inside a handler.
 */
export function registerRefsIpc() {
  ipcMain.handle('refs:build', async () => {
    try {
      return await buildRefsIndex((p) => getWin()?.webContents.send('refs:progress', p))
    } catch (e) {
      return { error: String(e) }
    }
  })

  ipcMain.handle('refs:search', (_e, q: string) => {
    try {
      return searchRefs(q)
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
