import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Annotation, AppConfig, Doc, Folder, Library } from '../../shared/types'

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

export const DEFAULT_FONT_SIZE = 15

export function loadConfig(): Config {
  try {
    return {
      pdfDir: DEFAULT_PDF_DIR,
      fontSize: DEFAULT_FONT_SIZE,
      ...JSON.parse(fs.readFileSync(cfgFile(), 'utf-8'))
    }
  } catch {
    return { pdfDir: DEFAULT_PDF_DIR, fontSize: DEFAULT_FONT_SIZE }
  }
}

export function saveConfig(c: Config) {
  fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2), 'utf-8')
}

export function loadLibrary(): Library | null {
  try {
    const raw = fs.readFileSync(libFile(), 'utf-8')
    const lib = JSON.parse(raw) as Library
    if (!Array.isArray(lib.docs)) return null
    return lib
  } catch {
    return null
  }
}

export function saveLibrary(docs: Doc[], folders: Folder[]) {
  // write-then-rename so an interrupted write cannot leave a half file behind
  const tmp = libFile() + '.tmp'
  const lib: Library = {
    docs,
    folders,
    syncedAt: new Date().toISOString()
  }
  fs.writeFileSync(tmp, JSON.stringify(lib), 'utf-8')
  fs.renameSync(tmp, libFile())
}

export function loadAnnotations(): Annotation[] {
  try {
    return JSON.parse(fs.readFileSync(annFile(), 'utf-8')) as Annotation[]
  } catch {
    return []
  }
}

/** Document-level notes.  Mendeley has no /notes endpoint — it answers 404
 *  "No service found" — so these can only ever live here, and the UI says so. */
export function loadNotes(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(notesFile(), 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

export function saveNotes(notes: Record<string, string>) {
  const tmp = notesFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 1), 'utf-8')
  fs.renameSync(tmp, notesFile())
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
  const tmp = readFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(m), 'utf-8')
  fs.renameSync(tmp, readFile())
}

export function saveAnnotations(list: Annotation[]) {
  const tmp = annFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1), 'utf-8')
  fs.renameSync(tmp, annFile())
}
