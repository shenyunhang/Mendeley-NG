import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Annotation, AppConfig, Doc, Folder, Library } from '../../shared/types'

function dir() {
  const d = path.join(app.getPath('userData'), 'library')
  fs.mkdirSync(d, { recursive: true })
  return d
}

const libFile = () => path.join(dir(), 'library.json')
const annFile = () => path.join(dir(), 'annotations.json')
const cfgFile = () => path.join(dir(), 'config.json')

export type Config = AppConfig


export const DEFAULT_PDF_DIR =
  'C:\\Users\\shenyunhang\\AppData\\Local\\Mendeley Ltd\\Mendeley Desktop\\Downloaded'

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

export function saveAnnotations(list: Annotation[]) {
  const tmp = annFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1), 'utf-8')
  fs.renameSync(tmp, annFile())
}
