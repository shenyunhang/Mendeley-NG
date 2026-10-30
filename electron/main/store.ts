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

export function saveAnnotations(list: Annotation[]) {
  const tmp = annFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1), 'utf-8')
  fs.renameSync(tmp, annFile())
}
