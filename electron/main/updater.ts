import { app, ipcMain } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'

export interface UpdateState {
  phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'unsupported'
  /** version being offered, when known */
  version?: string
  percent?: number
  message?: string
}

/**
 * Auto-update over GitHub Releases.
 *
 * electron-updater reads the `latest.yml` that electron-builder writes next to
 * the installer and that the release workflow attaches to the release, so the
 * app never has to scrape the release page itself.  It also drives the NSIS
 * installer with the relaunch flag, which is the whole reason we use it rather
 * than downloading the .exe by hand: a silent NSIS run on its own gives no
 * guarantee the app comes back up afterwards.
 *
 * Updates only make sense for an installed, packaged app.  In dev (or in the
 * unpacked dir) there is nothing to replace, so we say so instead of failing.
 */

let send: (s: UpdateState) => void = () => {}

function installHandlers() {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => send({ phase: 'checking' }))

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    send({ phase: 'available', version: info.version, message: info.releaseNotes as string })
  })

  autoUpdater.on('update-not-available', () => send({ phase: 'not-available' }))

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    send({ phase: 'downloading', percent: Math.round(p.percent) })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    send({ phase: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (e: Error) => {
    send({ phase: 'error', message: e?.message ?? String(e) })
  })
}

export function initUpdater(emit: (s: UpdateState) => void) {
  send = emit
  installHandlers()

  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      send({ phase: 'unsupported', message: '开发模式不支持更新（需打包安装后的版本）' })
      return { unsupported: true }
    }
    try {
      const r = await autoUpdater.checkForUpdates()
      return { version: r?.updateInfo?.version ?? null }
    } catch (e) {
      send({ phase: 'error', message: String(e) })
      return { error: String(e) }
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (e) {
      send({ phase: 'error', message: String(e) })
      return { error: String(e) }
    }
  })

  /** quits and runs the installer, which relaunches the app when it is done */
  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  })
}
