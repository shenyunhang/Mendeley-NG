/**
 * The import dialog returns two different payloads: UTF-8 text for a
 * bibliography preview, untouched bytes for a PDF that has to reach the
 * server. These cases hold that split and the wiring behind it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  isPdfImportFileName,
  splitPickedImportFiles,
  type PickedImportFile
} from '../shared/importFileRules'

function rootUp(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}
const read = (p: string): string =>
  fs.readFileSync(path.join(rootUp(), p), 'utf-8').replace(/\r\n/g, '\n')

const bytesOf = (n: number): ArrayBuffer => new Uint8Array(n).buffer

describe('a picked file is routed by its name', () => {
  it('recognises a PDF in any letter case', () => {
    for (const name of ['paper.pdf', 'Paper.PDF', 'A.Pdf', '.pdf']) {
      expect(isPdfImportFileName(name)).toBe(true)
    }
  })

  it('does not mistake a bibliography or a doubled extension for a PDF', () => {
    for (const name of [
      'refs.bib', 'refs.bibtex', 'refs.ris', 'refs.xml', 'refs.enw',
      'refs.txt', 'paper.pdf.txt', 'pdf', 'paper.pdf ', 'paper.pdf.bak'
    ]) {
      expect(isPdfImportFileName(name)).toBe(false)
    }
  })

  it('the detector can see a wrong rule before being trusted', () => {
    const alwaysPdf = (_name: string) => true
    expect(alwaysPdf('refs.bib')).toBe(true)
    expect(isPdfImportFileName('refs.bib')).toBe(false)
  })
})

describe('the two payloads are split without losing either', () => {
  it('keeps both kinds in the order they were returned', () => {
    const pdfBytes = bytesOf(4)
    const files: PickedImportFile[] = [
      { name: 'a.bib', text: '@article{a}' },
      { name: 'b.pdf', bytes: pdfBytes },
      { name: 'c.ris', text: 'TY  - JOUR' },
      { name: 'd.PDF', bytes: bytesOf(0) }
    ]
    const { pdfs, bibliographies } = splitPickedImportFiles(files)
    expect(pdfs.map((f) => f.name)).toEqual(['b.pdf', 'd.PDF'])
    expect(pdfs[0]?.bytes).toBe(pdfBytes)
    expect(bibliographies.map((f) => f.name)).toEqual(['a.bib', 'c.ris'])
    expect(bibliographies[0]?.text).toBe('@article{a}')
  })

  it('treats an empty PDF as bytes, not as an empty bibliography', () => {
    const { pdfs, bibliographies } = splitPickedImportFiles([
      { name: 'empty.pdf', bytes: bytesOf(0) }
    ])
    expect(pdfs).toHaveLength(1)
    expect(pdfs[0]?.bytes.byteLength).toBe(0)
    expect(bibliographies).toHaveLength(0)
  })

  it('answers nothing for a cancelled dialog', () => {
    expect(splitPickedImportFiles([])).toEqual({ pdfs: [], bibliographies: [] })
  })

  it('the comparison can see a payload being sent down the wrong path', () => {
    const wrong = splitPickedImportFiles([
      { name: 'a.pdf', bytes: bytesOf(1) }
    ])
    expect(wrong.bibliographies).not.toHaveLength(1)
    expect(wrong.pdfs).toHaveLength(1)
  })
})

describe('the wiring keeps one dialog, one rule and one import path', () => {
  it('the dialog offers PDFs and reads them as bytes', () => {
    const source = read('electron/main/ipc/system.ts')
    expect(source).toContain("{ name: '参考文献与 PDF', extensions: [...referenceFormats, 'pdf'] }")
    expect(source).toContain('isPdfImportFileName(name)')
    expect(source).toContain('const raw = fs.readFileSync(p)')
    expect(source).toContain("return { name, text: fs.readFileSync(p, 'utf-8') }")
  })

  it('the toolbar splits the answer and the app reuses the dropped-file path', () => {
    const toolbar = read('src/components/Toolbar.tsx')
    expect(toolbar).toContain('splitPickedImportFiles(files)')
    expect(toolbar).toContain('if (pdfs.length) await p.onImportPdfs(pdfs)')
    expect(toolbar).toContain('if (!bibliographies.length) return')
    expect(toolbar).toContain('导入 BibTeX / RIS / EndNote XML / PDF')
    const app = read('src/App.tsx')
    expect(app).toContain('const importPdfFiles = async (')
    expect(app).toContain('onImportPdfs={importPickedPdfs}')
    expect(app).toContain('isPdfImportFileName(f.name)')
  })

  it('the contract names the shared file shape once', () => {
    expect(read('src/global.d.ts')).toContain('Promise<PickedImportFile[]>')
    expect(read('electron/preload/index.ts')).toContain('Promise<PickedImportFile[]>')
  })
})
