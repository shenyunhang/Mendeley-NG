import { registerDocsIpc } from './docs'
import { registerFilesIpc } from './files'
import { registerLibraryIpc } from './library'
import { registerMarksIpc } from './marks'
import { registerSystemIpc } from './system'

/**
 * Every channel the renderer can call, registered in one place.
 *
 * They used to be a flat list of forty-odd `ipcMain.handle` calls at the
 * bottom of the entry point, next to the window and the sync — which meant
 * the file that decided what the app does on launch was also the file that
 * answered "what does `doc:patch` do".  Grouped by what they are about, each
 * group is small enough to read, and adding a channel is a question about
 * which group it belongs to rather than where in the list it should go.
 *
 * The order matters once: the full-text index has to be initialised before
 * anything can answer `ft:status`, so `registerIpc` is called after that and
 * not before.
 */
export function registerIpc() {
  registerLibraryIpc()
  registerSystemIpc()
  registerDocsIpc()
  registerMarksIpc()
  registerFilesIpc()
}

export { setDemoMode } from './library'
