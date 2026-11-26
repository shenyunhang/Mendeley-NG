import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Annotation, AppConfig, Doc, Folder, Library } from '../../shared/types'
import { atomicWriteJson } from '../../shared/atomicJson'

function dir() {
  const d = path.join(app.getPath('userData'), 'library')
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** Where the library, the config and the full-text index live. */
export const dataDir = dir

const libFile = () => path.join(dir(), 'library.json')
const annFile = () => path.join(dir(), 'annotations.json')
const cfgFile = () => path.join(dir(), 'config.json')
const notesFile = () => path.join(dir(), 'notes.json')
const readFile = () => path.join(dir(), 'reading.json')

export type Config = AppConfig


/** Mendeley Desktop's own download folder, derived rather than hard-coded so
 *  the tree carries no machine-specific paths. */
export const DEFAULT_PDF_DIR = path.join(
  process.env.LOCALAPPDATA ?? app.getPath('appData'),
  'Mendeley Ltd',
  'Mendeley Desktop',
  'Downloaded'
)

const DEFAULT_FONT_SIZE = 15

export function loadConfig(): Config {
  const fallback = { pdfDir: DEFAULT_PDF_DIR, fontSize: DEFAULT_FONT_SIZE }
  try {
    const raw = JSON.parse(fs.readFileSync(cfgFile(), 'utf-8')) as Record<string, unknown>
    // A hand-edited or half-written config used to overwrite the defaults
    // with `pdfDir: 123` and make path.join throw deep inside a handler.
    if (raw.pdfDir !== undefined && typeof raw.pdfDir !== 'string') delete raw.pdfDir
    if (raw.fontSize !== undefined && typeof raw.fontSize !== 'number') delete raw.fontSize
    return { ...fallback, ...raw } as Config
  } catch {
    return fallback
  }
}

/** Atomic, like every other write in this file: a process killed mid-write
 *  used to leave half a JSON behind and silently lose every setting.  Kept
 *  inline because the smoke run asserts this exact tmp-then-rename shape. */
export function saveConfig(c: Config) {
  const tmp = cfgFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf-8')
  fs.renameSync(tmp, cfgFile())
}

/**
 * The parsed library, reused only while disk still holds the exact file that
 * was parsed. `library.json` is over twelve megabytes and 35 call sites read
 * it, so a metadata edit used to parse the whole file twice in one handler.
 *
 * This is not the snapshot that made `reading:set` go stale (HANDOFF §4).
 * Every read checks the file's identity, every write drops the entry, and the
 * returned rows are copies: an edit a caller never saves cannot linger here
 * and be handed to the next channel. A second window or a hand edit changes
 * the stamp, so the next read reparses.
 */
let libCache: { stamp: string; lib: Library } | null = null

function libStamp(): string | null {
  try {
    const s = fs.statSync(libFile(), { bigint: true })
    // Nanosecond mtime, not the millisecond one: two atomic writes in the
    // same millisecond must not look like the same file.
    return `${s.mtimeNs}:${s.ctimeNs}:${s.size}`
  } catch {
    return null
  }
}

function cloneDoc(d: Doc): Doc {
  const out: Doc = { ...d }
  // The nested containers are copied too. Callers replace `folder_uuids`
  // wholesale today, but a shallow row copy would let an unsaved in-place
  // edit reach the cached object and be handed to the next channel.
  if (d.authors) out.authors = d.authors.map((a) => ({ ...a }))
  if (d.editors) out.editors = d.editors.map((a) => ({ ...a }))
  if (d.identifiers) out.identifiers = { ...d.identifiers }
  if (d.folder_uuids) out.folder_uuids = [...d.folder_uuids]
  if (d.websites) out.websites = [...d.websites]
  if (d.keywords) out.keywords = [...d.keywords]
  if (d.tags) out.tags = [...d.tags]
  return out
}

function libraryCopy(lib: Library): Library {
  return {
    docs: lib.docs.map(cloneDoc),
    folders: lib.folders.map((f) => ({ ...f })),
    syncedAt: lib.syncedAt
  }
}

export function loadLibrary(): Library | null {
  // The stamp is taken before the read. If the file changes in between, the
  // stamp stored with the answer describes the older file, so the next read
  // misses and reparses instead of serving stale rows as current ones.
  const stamp = libStamp()
  if (stamp === null) {
    libCache = null
    return null
  }
  if (libCache?.stamp === stamp) return libraryCopy(libCache.lib)
  try {
    const raw = fs.readFileSync(libFile(), 'utf-8')
    const lib = JSON.parse(raw) as Library
    // `folders: null` used to pass this check and then throw in every
    // handler that calls lib.folders.map/filter; the bad value was even
    // written straight back, so it kept itself alive.
    if (!Array.isArray(lib.docs) || !Array.isArray(lib.folders)) return null
    if (lib.syncedAt !== undefined && typeof lib.syncedAt !== 'string') return null
    libCache = { stamp, lib }
    return libraryCopy(lib)
  } catch {
    libCache = null
    return null
  }
}

function writeLibrary(docs: Doc[], folders: Folder[], syncedAt: string) {
  const lib: Library = { docs, folders, syncedAt }
  atomicWriteJson(libFile(), lib)
  // The rename gives the file a new stamp, but drop the entry explicitly:
  // a coarse filesystem clock must never be able to make a write invisible.
  libCache = null
}

/**
 * A local edit, not a sync.
 *
 * `syncedAt` is the watermark the next incremental pull starts from. Every
 * local write used to stamp it with "now", so trashing a paper, editing a
 * field or dropping a PDF silently told the next pull "everything before
 * this moment is already known" — the 60 s overlap was the only thing left
 * covering changes made on another machine. A cache with no real sync yet
 * gets the epoch, which `sync()` reads as "do a full pull".
 */
export function saveLibrary(docs: Doc[], folders: Folder[]) {
  const prev = loadLibrary()
  writeLibrary(docs, folders, prev?.syncedAt ?? new Date(0).toISOString())
}

/** Only a completed pull is allowed to advance the incremental watermark. */
export function saveLibraryFromSync(docs: Doc[], folders: Folder[]) {
  writeLibrary(docs, folders, new Date().toISOString())
}

export function loadAnnotations(): Annotation[] {
  try {
    const raw = JSON.parse(fs.readFileSync(annFile(), 'utf-8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((a) => !!a && typeof a === 'object') as Annotation[]
  } catch {
    return []
  }
}

/** Document-level notes.  Mendeley has no /notes endpoint — it answers 404
 *  "No service found" — so these can only ever live here, and the UI says so. */
export function loadNotes(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(notesFile(), 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function saveNotes(notes: Record<string, string>) {
  atomicWriteJson(notesFile(), notes, 1)
}

/**
 * Where in each document the reader was last left: document id to page.
 *
 * There is no endpoint for this either — Mendeley Reference Manager does not
 * sync reading position across devices — so it lives here like the notes.
 * Values are validated on the way in because the page a document was closed
 * at says nothing about the page count of the file that is there now, and a
 * stale one would open a document on a page that does not exist.
 */
export function loadReading(): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(readFile(), 'utf-8')) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v)
      if (Number.isFinite(n) && n >= 1) out[k] = Math.floor(n)
    }
    return out
  } catch {
    return {}
  }
}

export function saveReading(m: Record<string, number>) {
  atomicWriteJson(readFile(), m)
}

export function saveAnnotations(list: Annotation[]) {
  atomicWriteJson(annFile(), list, 1)
}
