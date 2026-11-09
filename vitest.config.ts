import { defineConfig } from 'vitest/config'

/**
 * The unit suite is pure Node. Most cases exercise a pure function or a state
 * machine with an injected clock; the main-process IPC cases replace the
 * `electron` module with a stub and call the handlers captured from
 * `ipcMain.handle` directly. Nothing starts Electron, opens a window, touches
 * the real library or needs a DOM, so the whole suite runs on a headless CI
 * runner -- unlike `npm run smoke`, which drives a real window against a real
 * library.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Keep a failing assertion's output readable: these files hold hundreds of
    // small, independent cases and a single run reports all of them.
    reporters: ['default']
  }
})
