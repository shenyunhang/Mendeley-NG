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
import { runPerf } from './perf'
import { loadConfig, loadLibrary } from './store'
import { canServePdf } from '../../shared/pathPolicy'

/**
 * The papers whose PDFs live outside `pdfDir` are the only reason the
 * protocol handler ever has to read library.json.  Remember them briefly:
 * pdf.js asks for the same file more than once, and a full library is several
 * megabytes.  A newly attached paper still appears within a second.
 */
const KNOWN_PDF_TTL_MS = 1000
let knownPdfs = { at: 0, files: [] as string[] }
function knownLocalPdfs(): string[] {
  const now = Date.now()
  if (now - knownPdfs.at < KNOWN_PDF_TTL_MS) return knownPdfs.files
  const files = (loadLibrary()?.docs ?? [])
    .map((d) => d.localPdf)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  knownPdfs = { at: now, files }
  return files
}

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

app.whenReady().then(async () => {
  if (!alone) return
  // Serve local PDFs through our own scheme so webSecurity stays on.  The
  // scheme is not a second file API: only the library's own PDFs may be
  // fetched, so a renderer that somehow learned an arbitrary absolute path
  // cannot read token.json, a browser profile, or anything else on the disk.
  protocol.handle('mendeley', (req) => {
    const u = new URL(req.url)
    if (u.hostname !== 'pdf') return new Response('not found', { status: 404 })
    let p: string
    try {
      p = decodeURIComponent(u.pathname.replace(/^\//, ''))
    } catch {
      return new Response('bad path', { status: 400 })
    }
    const cfg = loadConfig()
    const allowed = canServePdf({
      candidate: p,
      roots: [cfg.pdfDir],
      knownFiles: knownLocalPdfs()
    })
    if (!allowed) return new Response('forbidden', { status: 403 })
    return net.fetch('file:///' + p.replace(/\\/g, '/').replace(/^\/+/, ''))
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
    // The smoke suite is twelve thousand lines of assertions.  Loading it
    // only on this branch keeps it out of the production startup path and
    // out of the bundle the reader launches every day.  It is still built as
    // its own chunk, so `--smoke` works against exactly the same source.
    let smoke: typeof import('./smoke')
    try {
      smoke = await import('./smoke')
    } catch (e) {
      console.log('[smoke] could not load', String(e))
      app.exit(1)
      return
    }
    // a run that threw still has to hand the config back: the next run starts
    // from whatever this one left, and one crash would otherwise read as a
    // dozen failures of things that are not broken.  A run that got to its
    // own last line already put it back, and calling this again changes
    // nothing.
    try {
      await smoke.runSmoke()
    } catch (e) {
      console.log('[smoke] crashed', String(e))
      smoke.restoreSmokeConfig()
      app.exit(1)
    }
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

