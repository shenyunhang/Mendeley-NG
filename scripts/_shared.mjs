/**
 * The pieces every dev/build script used to copy from each other.
 *
 * `root` is derived from this file, not from process.cwd(), so a script run
 * from any directory still finds the repository. `cleanEnv` strips the two
 * variables that make Electron boot as plain Node from inside Electron-based
 * IDE terminals. `UA` is the browser-looking string Cloudflare demands; the
 * TypeScript half of the project keeps the same literal in
 * shared/userAgent.ts and tests/refactor-regression.test.ts proves the two
 * copies agree, so a change to one cannot silently leave the other behind.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path to the repository root, independent of the caller's cwd. */
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Cloudflare in front of api.mendeley.com answers error 1010 to anything
 *  that does not look like a browser -- /oauth/token included. */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** The Electron binary for this platform. */
export const electronBin = () =>
  process.platform === 'win32'
    ? path.join(root, 'node_modules/electron/dist/electron.exe')
    : path.join(root, 'node_modules/electron/dist/electron')

/** A copy of the environment without the two variables that break Electron.
 *  Callers add their own run-mode variables after this, so `--smoke` can keep
 *  its `??=` behaviour while `--demo` can override unconditionally. */
export function cleanEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

/** Let the child's exit code be the script's exit code. */
export function propagateExit(child) {
  child.on('close', (code) => process.exit(code ?? 0))
}
