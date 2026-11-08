import { defineConfig } from 'vitest/config'

/**
 * The unit suite is pure Node: every module under test is a pure function or a
 * state machine with an injected clock. Nothing here opens a window, talks to
 * Electron, or needs a DOM, so it can run on a headless CI runner -- unlike
 * `npm run smoke`, which drives a real window against a real library.
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
