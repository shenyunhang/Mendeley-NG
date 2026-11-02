import type { BrowserWindow } from 'electron'

/**
 * One window, however many times the icon is clicked.
 *
 * Without this a second click starts a second copy: two windows on the same
 * library, each keeping its own annotations and reading position in memory
 * and writing them back over each other, and no way for the reader to tell
 * which one they are looking at.  What the second copy should do is not open
 * a window at all but hand the click to the copy already running.
 *
 * `--smoke` and `--demo` do not take the lock.  Both are development aids
 * that get run while the real app is open, and being answered with "already
 * running" would make them impossible to run at all.
 */
export const wantsSingleInstance = (argv: string[]) =>
  !argv.includes('--smoke') && !argv.includes('--demo') && !argv.includes('--perf')

/** What a second launch does to the window that is already there: bring it
 *  back.  Only minimised needs handling — there is no tray to hide to, so a
 *  window that is not on screen is one that was minimised. */
export function bringUp(w: BrowserWindow) {
  if (w.isMinimized()) w.restore()
  w.focus()
}
