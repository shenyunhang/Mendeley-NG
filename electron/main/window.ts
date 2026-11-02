import { BrowserWindow, app, screen } from 'electron'
import path from 'node:path'
import { loadConfig, saveConfig } from './store'
import type { SyncStatus } from '../../shared/types'

/**
 * The window, and the only way to reach it.
 *
 * Held here rather than in the entry point because three callers want it for
 * three different reasons: the entry point creates it, the IPC handlers parent
 * their dialogs to it, and a sync running in the background broadcasts its
 * progress to it.  A reference passed down to each of them would have to be
 * threaded through every handler, and a handler that outlived it would still
 * be holding a window that had closed.
 */
let win: BrowserWindow | null = null

export const getWin = () => win

export function setWin(w: BrowserWindow | null) {
  win = w
}

/**
 * Progress from a sync, pushed rather than asked for.
 *
 * `?.` because a sync can be the very first thing that happens, before there
 * is a window to tell — the boot pull in the entry point reaches nobody, and
 * that is the point of it.  A status nobody is listening for is not an error.
 */
export function status(s: SyncStatus) {
  win?.webContents.send('sync:status', s)
}

/**
 * Where the window was left, or `null` when there is nothing worth restoring.
 *
 * A saved rectangle is refused unless a display still contains a usable part
 * of it: windows are remembered across the very event that makes them wrong
 * — a monitor unplugged, a laptop undocked — and a window restored where
 * nobody can reach it is worse than one at the default, because the reader
 * has no way to know what happened.
 */
export function savedBounds(): Electron.Rectangle | null {
  const b = loadConfig().window
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null
  const w = { x: b.x, y: b.y, width: b.width, height: b.height }
  const enough = 64
  return screen.getAllDisplays().some((d) => {
    const a = d.bounds
    return (
      Math.min(w.x + w.width, a.x + a.width) - Math.max(w.x, a.x) >= enough &&
      Math.min(w.y + w.height, a.y + a.height) - Math.max(w.y, a.y) >= enough
    )
  })
    ? w
    : null
}

/**
 * Called when the window closes.  `close` and not `blur`, which also fires
 * when another application takes focus and would record a size the reader
 * only meant for a moment.
 *
 * Maximised is stored beside the rectangle instead of as the rectangle: what
 * a maximised window reports is the screen, and restoring that would open a
 * window that fills the display with no memory of the size that was chosen.
 */
export function rememberBounds(w: BrowserWindow) {
  const cfg = loadConfig()
  if (w.isMaximized()) {
    cfg.window = { ...(cfg.window ?? w.getBounds()), maximized: true }
  } else {
    cfg.window = { ...w.getBounds(), maximized: false }
  }
  saveConfig(cfg)
}

/** Both halves of remembering the window, in the order the window needs them:
 *  come back maximised if that is how it was left, and write where it is when
 *  it goes away. */
export function attachWindowMemory(w: BrowserWindow) {
  if (loadConfig().window?.maximized) w.maximize()
  w.on('close', () => rememberBounds(w))
}

export function createWindow() {
  const bounds = savedBounds()
  const w = new BrowserWindow({
    /**
     * The taskbar and the title bar take this.  `build/icon.ico` is what goes
     * on the exe and the installer, but that directory is electron-builder's
     * and is not copied into the app, so the window needs the copy under
     * assets/.  `app.getAppPath()` is the project root unpacked and the asar
     * packaged, which is why the one path works in both.
     */
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    ...(bounds ?? { width: 1500, height: 950 }),
    minWidth: 1000,
    minHeight: 650,
    // no zoomFactor and no DPI overrides on purpose: Chromium already renders
    // at the system scale factor, which is the whole point of this rewrite
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  attachWindowMemory(w)
  w.once('ready-to-show', () => w.show())
  w.on('closed', () => {
    if (win === w) setWin(null)
  })
  setWin(w)

  if (process.env.ELECTRON_RENDERER_URL) {
    w.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    w.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return w
}
