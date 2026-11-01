import { app, ipcMain } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'

// One definition, in shared/types, re-exported so callers that imported it
// from here keep working.  Two interfaces with the same name drift: the field
// added to one is silently absent from the other, and a status that carries
// the version being offered but not the version being run is exactly the kind
// of half-answer this module keeps having to explain.
import type { UpdateState } from '../../shared/types'
export type { UpdateState }

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

/**
 * electron-updater only records the update internally when one is actually
 * available, and `downloadUpdate()` throws "Please check update first" if that
 * never happened.  Tracking the outcome here keeps the guard in the main
 * process instead of trusting the renderer to call things in the right order.
 */
let updateAvailable = false
/** Whether the check in flight is one the app started rather than the reader.
 *  The events fire outside the invoke, so they need to know whose they are. */
let quietRun = false
/**
 * The version on offer, kept because the progress events do not repeat it.
 * A download that says "42%" without saying what is at 42% leaves the reader
 * watching a bar for a version they were told about once, several screens
 * and one restart ago.
 */
let offered = ''

function installHandlers() {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => send({ phase: 'checking' }))

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    updateAvailable = true
    offered = info.version
    send({ phase: 'available', version: info.version, message: info.releaseNotes as string })
  })

  autoUpdater.on('update-not-available', () => {
    updateAvailable = false
    // "已是最新版本" is a fine answer to a press of the button and noise when
    // nobody asked
    if (quietRun) send({ phase: 'idle' })
    else send({ phase: 'not-available' })
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    send({ phase: 'downloading', percent: Math.round(p.percent), version: offered || undefined })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    offered = info.version
    send({ phase: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (e: Error) => {
    if (quietRun) {
      send({ phase: 'idle' })
      return
    }
    send({ phase: 'error', message: e?.message ?? String(e) })
  })
}

export function initUpdater(emit: (s: UpdateState) => void) {
  // Every state carries the version that is running, so the panel can put the
  // two numbers next to each other without the renderer having to ask again.
  // "已是最新版本" on its own is unanswerable: newest compared to what?
  send = (s: UpdateState) => emit({ ...s, current: app.getVersion() })
  installHandlers()

  /**
   * `quiet` is the check the app makes on its own at startup rather than the
   * one the reader asked for.
   *
   * Nothing looked for an update unless the button was pressed, so a build sat
   * at whatever version it was installed at while the releases page filled up
   * behind it: four releases went out unread, and a reader met the old
   * behaviour and reported it as a bug.  A check nobody asked for also has no
   * business failing out loud — starting up offline should not leave
   * "更新失败" sitting in the toolbar all session.
   */
  ipcMain.handle('updater:check', async (_e, quiet?: boolean) => {
    const idle = () => send({ phase: 'idle' as const })
    if (!app.isPackaged) {
      if (quiet) {
        idle()
        return { unsupported: true }
      }
      // the version is in the message as well as in `current`, so the one
      // phase that has nothing to offer still answers "what am I running?"
      send({
        phase: 'unsupported',
        message: `当前 ${app.getVersion()}：开发模式不支持更新（需打包安装后的版本）`
      })
      return { unsupported: true }
    }
    try {
      updateAvailable = false
      quietRun = !!quiet
      const r = await autoUpdater.checkForUpdates()
      const available = r?.isUpdateAvailable ?? false
      if (quiet && !available) idle()
      return {
        version: r?.updateInfo?.version ?? null,
        available
      }
    } catch (e) {
      if (quiet) idle()
      else send({ phase: 'error', message: String(e) })
      return { error: String(e) }
    } finally {
      quietRun = false
    }
  })

  ipcMain.handle('updater:download', async () => {
    if (!updateAvailable) {
      // no update means there is nothing to download; saying so beats letting
      // electron-updater throw "Please check update first"
      send({ phase: 'not-available' })
      return { noUpdate: true }
    }
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
