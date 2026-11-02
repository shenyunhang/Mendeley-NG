/**
 * The entry point, and nothing else.
 *
 * What happens when the icon is clicked: one window, whether another copy is
 * already running, and which of the four ways there are to start the app this
 * launch is — the library, the screenshot run, the measurement run, or the
 * real thing.  Everything it decides between lives in its own module, so
 * nothing here is more than a few lines long and none of it is about the
 * details of syncing, indexing or the forty-odd channels the renderer calls.
 */
import { app, BrowserWindow, net, protocol } from 'electron'
import { initUpdater, type UpdateState } from './updater'
import { bringUp, wantsSingleInstance } from './instance'
import { createWindow, getWin } from './window'
import { initFt } from './ftops'
import { registerIpc, setDemoMode } from './ipc'
import { runDemo } from './demo'
import { restoreSmokeConfig, runSmoke } from './smoke'
import { runPerf } from './perf'

const alone = !wantsSingleInstance(process.argv) || app.requestSingleInstanceLock()
if (!alone) {
  // quit before anything else happens: a second copy that flashes a window
  // and then disappears is worse than one that never appears
  app.quit()
}

app.on('second-instance', () => {
  const w = getWin()
  if (w) bringUp(w)
})

app.whenReady().then(() => {
  if (!alone) return
  // serve local PDFs through our own scheme so webSecurity stays on
  protocol.handle('mendeley', (req) => {
    const u = new URL(req.url)
    if (u.hostname === 'pdf') {
      const p = decodeURIComponent(u.pathname.replace(/^\//, ''))
      return net.fetch('file:///' + p.replace(/\\/g, '/').replace(/^\/+/, ''))
    }
    return new Response('not found', { status: 404 })
  })

  if (process.argv.includes('--demo')) {
    setDemoMode(true)
    runDemo().catch((e) => {
      console.log('[demo] crashed', String(e))
      app.exit(1)
    })
    return
  }

  if (process.argv.includes('--smoke')) {
    // a run that threw still has to hand the config back: the next run starts
    // from whatever this one left, and one crash would otherwise read as a
    // dozen failures of things that are not broken.  A run that got to its
    // own last line already put it back, and calling this again changes
    // nothing.
    runSmoke().catch((e) => {
      console.log('[smoke] crashed', String(e))
      restoreSmokeConfig()
      app.exit(1)
    })
    return
  }

  if (process.argv.includes('--perf')) {
    runPerf().catch((e) => {
      console.log('[perf] crashed', String(e))
      app.exit(1)
    })
    return
  }

  createWindow()
  app.on('activate', () => {
    // on macOS a click on the dock icon lands here rather than starting a
    // second copy, and it means the same thing: bring the window back
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (getWin()) bringUp(getWin()!)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// The full-text index has to be live before anything can answer a question
// about it, and every channel is registered after that rather than before.
initFt()
registerIpc()

// updater events are pushed to the renderer, which renders them in the toolbar
initUpdater((s: UpdateState) => getWin()?.webContents.send('updater:state', s))

