import path from 'node:path'
import type { AppConfig } from './types'

/**
 * The trust boundary between the renderer and the file system.
 *
 * The renderer is sandboxed with `contextIsolation`, but everything it sends
 * over IPC is still untrusted input: a compromised or merely buggy renderer
 * can name any path it likes.  Three places used to take those names at face
 * value -- the `mendeley://pdf` protocol handler would fetch any file on the
 * machine, `export:leave` would join an unchecked relative name onto the
 * export folder, and `shell:openExternal` would hand any scheme to the OS.
 *
 * The rules live here rather than in the handlers so they can be exercised
 * with fixed inputs.  `platform` is injected for the same reason: a Windows
 * path comparison is case-insensitive and uses `\`, and a test must be able
 * to prove that on any runner.
 */
export type Platform = 'win32' | 'posix'

const host = (): Platform => (process.platform === 'win32' ? 'win32' : 'posix')
const api = (p: Platform) => (p === 'win32' ? path.win32 : path.posix)
const fold = (s: string, p: Platform) => (p === 'win32' ? s.toLowerCase() : s)

/** True when `candidate` is `root` itself or lives underneath it.
 *  Both sides are resolved first, so `..` segments and mixed separators
 *  cannot be used to name a sibling of the root. */
export function isPathWithin(
  root: string,
  candidate: string,
  platform: Platform = host()
): boolean {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false
  if (!root || !candidate) return false
  const p = api(platform)
  if (!p.isAbsolute(root) || !p.isAbsolute(candidate)) return false
  const r = fold(p.resolve(root), platform)
  const c = fold(p.resolve(candidate), platform)
  const prefix = r.endsWith(p.sep) ? r : r + p.sep
  return c === r || c.startsWith(prefix)
}

/** Resolve a renderer-supplied relative name inside `root`, or refuse it.
 *  Returns null for absolute paths, drive-relative names such as `C:foo`,
 *  UNC paths, NUL bytes, and anything that resolves outside the root. */
export function resolveInside(
  root: string,
  rel: string,
  platform: Platform = host()
): string | null {
  if (typeof root !== 'string' || typeof rel !== 'string') return null
  if (!root || !rel || rel.includes('\0')) return null
  const p = api(platform)
  if (p.isAbsolute(rel) || p.parse(rel).root) return null
  const joined = p.resolve(root, rel)
  return isPathWithin(root, joined, platform) ? joined : null
}

/** Only web addresses may be handed to the OS shell.  `file:`, `smb:`,
 *  `javascript:` and every other scheme are refused rather than filtered,
 *  because the set of dangerous schemes is not a fixed list. */
export function isSafeExternalUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * May the custom protocol serve this file?
 *
 * A PDF is either inside one of the library's roots, most commonly `pdfDir`,
 * or is a file the library itself has recorded as an attachment (a paper
 * reattached from somewhere else on the disk).  Checking the roots first
 * keeps the common case free of a library.json read.  A request for
 * `token.json`, a browser profile or any other file is refused.
 */
export function canServePdf(
  input: {
    candidate: string
    roots: readonly (string | undefined | null)[]
    knownFiles?: readonly (string | undefined | null)[]
  },
  platform: Platform = host()
): boolean {
  const { candidate } = input
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return false
  const p = api(platform)
  if (!p.isAbsolute(candidate)) return false
  const wanted = fold(p.resolve(candidate), platform)
  for (const root of input.roots) {
    if (typeof root === 'string' && root && isPathWithin(root, candidate, platform)) return true
  }
  for (const file of input.knownFiles ?? []) {
    if (typeof file === 'string' && file && fold(p.resolve(file), platform) === wanted) return true
  }
  return false
}

/**
 * `satisfies Record<keyof AppConfig, true>` is the point: adding a config
 * field without deciding whether the renderer may write it is a type error,
 * not a silently ignored key.  Unknown keys are dropped rather than merged
 * into the file, so an old or hostile client cannot persist arbitrary data.
 */
const CONFIG_KEYS = {
  pdfDir: true,
  lastSync: true,
  fontSize: true,
  savedSearches: true,
  theme: true,
  pdfContinuous: true,
  cols: true,
  colWidths: true,
  pdfNameTemplate: true,
  views: true,
  citeStyle: true,
  paneLeft: true,
  paneRight: true,
  ftPages: true,
  exportDir: true,
  sort: true,
  syncOnStart: true,
  syncPdfsOnSync: true,
  dupeIgnores: true,
  window: true
} satisfies Record<keyof AppConfig, true>

const NUMERIC = new Set<string>(['fontSize', 'paneLeft', 'paneRight', 'ftPages'])
const TEXT = new Set<string>([
  'pdfDir',
  'lastSync',
  'theme',
  'pdfNameTemplate',
  'citeStyle',
  'exportDir'
])
const FLAGS = new Set<string>(['pdfContinuous', 'syncOnStart', 'syncPdfsOnSync'])
const ARRAYS = new Set<string>(['savedSearches', 'views', 'cols', 'dupeIgnores'])
const OBJECTS = new Set<string>(['colWidths', 'sort', 'window'])
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

/** Keep only the keys and value shapes a config file can actually hold.
 *  `undefined` is skipped rather than written, because callers that restore
 *  a snapshot legitimately pass it for a key that was never set. */
export function safeConfigPatch(raw: unknown): Partial<AppConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN.has(key) || !(key in CONFIG_KEYS)) continue
    const value = (raw as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (value === null || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') continue
    if (NUMERIC.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
    } else if (TEXT.has(key)) {
      if (typeof value !== 'string') continue
      if (key === 'theme' && value !== 'dark' && value !== 'light') continue
    } else if (FLAGS.has(key)) {
      if (typeof value !== 'boolean') continue
    } else if (ARRAYS.has(key)) {
      if (!Array.isArray(value)) continue
    } else if (OBJECTS.has(key)) {
      if (typeof value !== 'object' || Array.isArray(value)) continue
    } else {
      continue
    }
    out[key] = value
  }
  return out as Partial<AppConfig>
}
