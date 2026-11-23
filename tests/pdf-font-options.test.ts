import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  PDF_CMAP_DIR,
  PDF_STANDARD_FONT_DIR,
  pdfFontOptionsFromPath,
  pdfFontOptionsFromUrl
} from '../shared/pdfFontOptions'

/**
 * A CID font with a predefined ordering and no /ToUnicode is not translatable
 * without the matching CMap.  pdf.js then substitutes an ErrorFont and the
 * canvas silently drops the glyphs, so a figure looks like empty boxes.  The
 * two derivations below are the whole fix; the source-string guards keep every
 * pdf.js document load and the build chain that ships the files from drifting.
 */
function repoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

const ROOT = repoRoot()
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8')

describe('pdf.js font resources: both derivations', () => {
  it('resolves the asset directories beside a file:// index.html', () => {
    const o = pdfFontOptionsFromUrl('file:///C:/Program Files/Mendeley NG/resources/app.asar/out/renderer/index.html')
    expect(o).toEqual({
      cMapUrl: 'file:///C:/Program%20Files/Mendeley%20NG/resources/app.asar/out/renderer/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'file:///C:/Program%20Files/Mendeley%20NG/resources/app.asar/out/renderer/standard_fonts/'
    })
  })

  it('resolves the same relative paths against the dev server', () => {
    const o = pdfFontOptionsFromUrl('http://localhost:5173/')
    expect(o.cMapUrl).toBe('http://localhost:5173/cmaps/')
    expect(o.standardFontDataUrl).toBe('http://localhost:5173/standard_fonts/')
  })

  it('strips any number of trailing separators before appending the directory', () => {
    for (const base of [
      'D:/app/out/renderer',
      'D:/app/out/renderer/',
      'D:/app/out/renderer///'
    ]) {
      expect(pdfFontOptionsFromPath(base)).toEqual({
        cMapUrl: 'D:/app/out/renderer/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'D:/app/out/renderer/standard_fonts/'
      })
    }
  })

  it('keeps Windows backslashes intact and still ends with a single slash', () => {
    const o = pdfFontOptionsFromPath('D:\\app\\out\\renderer\\')
    expect(o.cMapUrl).toBe('D:\\app\\out\\renderer/cmaps/')
    expect(o.standardFontDataUrl).toBe('D:\\app\\out\\renderer/standard_fonts/')
  })

  it('both derivations agree on the option shape and the directory names', () => {
    const fromUrl = pdfFontOptionsFromUrl('http://localhost:5173/')
    const fromPath = pdfFontOptionsFromPath('any/base')
    expect(Object.keys(fromUrl).sort()).toEqual(Object.keys(fromPath).sort())
    expect(fromUrl.cMapUrl.endsWith('/' + PDF_CMAP_DIR + '/')).toBe(true)
    expect(fromUrl.standardFontDataUrl.endsWith('/' + PDF_STANDARD_FONT_DIR + '/')).toBe(true)
    expect(fromPath.cMapUrl.endsWith('/' + PDF_CMAP_DIR + '/')).toBe(true)
    expect(fromPath.standardFontDataUrl.endsWith('/' + PDF_STANDARD_FONT_DIR + '/')).toBe(true)
    expect(fromPath.cMapPacked).toBe(true)
  })
})

describe('every pdf.js document load carries the options', () => {
  const callSites: [string, string][] = [
    ['src/components/PdfViewer.tsx', 'pdfFontOptionsFromUrl(document.baseURI)'],
    ['src/lib/pdfmeta.ts', 'pdfFontOptionsFromUrl(document.baseURI)'],
    ['electron/main/fulltext.ts', '...pdfFontOptions()'],
    ['electron/main/refsindex.ts', '...pdfFontOptions()'],
    ['electron/main/smoke.ts', '...pdfFontOptions()']
  ]
  for (const [file, token] of callSites) {
    it(file, () => expect(read(file), file).toContain(token))
  }

  it('the smoke suite does not leave one of its three loads behind', () => {
    const src = read('electron/main/smoke.ts')
    const uses = src.match(/getDocument\({ data, useSystemFonts: false, \.\.\.pdfFontOptions\(\) \}/g) ?? []
    expect(uses).toHaveLength(3)
  })

  it('the main-process helper derives its path from out/renderer', () => {
    const src = read('electron/main/pdfFonts.ts')
    expect(src).toContain("path.join(__dirname, '..', 'renderer')")
    expect(src).toContain('pdfFontOptionsFromPath')
  })
})

describe('the assets reach both the dev server and the installed app', () => {
  it('prebuild and predev populate Vite publicDir', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts.prebuild).toContain('copy-pdf-assets.mjs')
    expect(pkg.scripts.predev).toContain('copy-pdf-assets.mjs')
    expect(read('electron.vite.config.ts')).toContain(".pdfjs-assets")
    expect(read('.gitignore')).toContain('.pdfjs-assets/')
  })

  it('the installed app unpacks both directories out of the asar', () => {
    const pkg = JSON.parse(read('package.json'))
    const rules: string[] = pkg.build?.asarUnpack ?? []
    expect(rules.some((r) => r.includes('out/renderer/cmaps'))).toBe(true)
    expect(rules.some((r) => r.includes('out/renderer/standard_fonts'))).toBe(true)
  })

  it('the copy script takes the files from pdfjs-dist itself', () => {
    const src = read('scripts/copy-pdf-assets.mjs')
    expect(src).toContain("'pdfjs-dist'")
    expect(src).toContain("'cmaps'")
    expect(src).toContain("'standard_fonts'")
  })
})
