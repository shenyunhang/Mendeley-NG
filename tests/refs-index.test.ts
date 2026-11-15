import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * refsindex.ts is exercised with everything on its input side replaced:
 * Electron, pdf.js and the store.  No real PDF is opened; getDocument returns
 * a tiny fake document whose getTextContent() hands back the lines we choose.
 * Each case re-imports the module so its in-memory cache starts clean.
 */
const m = vi.hoisted(() => ({
  dataDir: vi.fn(),
  loadLibrary: vi.fn(),
  getDocument: vi.fn(),
  numPages: 1,
  // fake pdf.js documents created during a run, so page-count and paired
  // destroy() can be asserted from outside
  docs: [] as any[]
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => '', getPath: () => '' }
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: m.getDocument
}))

vi.mock('../electron/main/store', () => ({
  dataDir: m.dataDir,
  loadLibrary: m.loadLibrary
}))

const ITEMS_WITH_REFS = [
  { str: 'Introduction', hasEOL: true },
  { str: 'Some body text about retrieval.', hasEOL: true },
  { str: 'References', hasEOL: true },
  { str: '[1] A. Author. Deep Learning for Retrieval. 2020', hasEOL: true },
  { str: '[2] B. Author. Neural Networks. 2019', hasEOL: true }
]

const ITEMS_NO_REFS = [
  { str: 'Introduction', hasEOL: true },
  { str: 'Only body text here, no bibliography.', hasEOL: true }
]

function fakeDoc(numPages: number, items: { str: string; hasEOL: boolean }[]) {
  const doc = {
    numPages,
    getPage: vi.fn(async (_n: number) => ({
      getTextContent: async () => ({ items }),
      cleanup: () => undefined
    })),
    destroy: vi.fn(async () => undefined)
  }
  m.docs.push(doc)
  return doc
}

let dir = ''
let cachePath = ''
let mod!: typeof import('../electron/main/refsindex')

const doc = (id: string) => ({ id, localPdf: path.join(dir, id + '.pdf') })

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-index-'))
  cachePath = path.join(dir, 'references.json')
  m.numPages = 1
  m.docs.length = 0
  m.dataDir.mockReturnValue(dir)
  m.loadLibrary.mockReturnValue({ docs: [], folders: [], syncedAt: '' })
  m.getDocument.mockImplementation((params: { url?: string }) => {
    const u = String(params?.url ?? '')
    if (u.includes('bad')) return { promise: Promise.reject(new Error('boom')) }
    const items = u.includes('norefs') ? ITEMS_NO_REFS : ITEMS_WITH_REFS
    return { promise: Promise.resolve(fakeDoc(m.numPages, items)) }
  })
  mod = await import('../electron/main/refsindex')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('buildRefsIndex', () => {
  it('skips an unchanged document and only reads the new one', async () => {
    const a = doc('d1')
    const b = doc('d2')
    fs.writeFileSync(a.localPdf, 'x')
    fs.writeFileSync(b.localPdf, 'xx')
    const st = fs.statSync(a.localPdf)
    // a valid cached section for d1 with the exact mtime/size of its file
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: {
          d1: { mtime: Math.floor(st.mtimeMs), size: st.size, text: 'seeded references', page: 3 }
        }
      })
    )
    m.loadLibrary.mockReturnValue({ docs: [a, b], folders: [], syncedAt: '' })

    const r = await mod.buildRefsIndex()
    expect(r.total).toBe(2)
    expect(r.skipped).toEqual([])
    expect(r.indexed).toBe(2) // seeded d1 kept + newly read d2
    expect(m.getDocument).toHaveBeenCalledTimes(1) // only d2, never d1
    const calledUrl = String((m.getDocument.mock.calls[0][0] as { url: string }).url)
    expect(calledUrl).toContain('d2.pdf')
    // every opened document is destroyed exactly once (paired cleanup)
    expect(m.docs).toHaveLength(1)
    expect(m.docs[0].destroy).toHaveBeenCalledTimes(1)
    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    expect(saved.entries.d1.text).toBe('seeded references') // untouched
    expect(saved.entries.d2.text).toContain('Deep Learning')
  })

  it('continues after one document fails and records it in skipped', async () => {
    const a = doc('d1')
    const bad = doc('bad')
    fs.writeFileSync(a.localPdf, 'x')
    fs.writeFileSync(bad.localPdf, 'x')
    m.loadLibrary.mockReturnValue({ docs: [a, bad], folders: [], syncedAt: '' })

    const r = await mod.buildRefsIndex()
    expect(r.total).toBe(2)
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]).toContain('bad')
    expect(r.indexed).toBeGreaterThanOrEqual(1) // d1 was still read
    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    expect(saved.entries.d1.text).toContain('Deep Learning')
    expect(saved.entries.bad).toBeUndefined() // no entry -> retried next run
  })

  it('records a skipped reason and stores an empty string when no References heading exists', async () => {
    m.numPages = 25 // forces the trailing-20-pages window
    const a = doc('norefs')
    fs.writeFileSync(a.localPdf, 'x')
    m.loadLibrary.mockReturnValue({ docs: [a], folders: [], syncedAt: '' })

    const r = await mod.buildRefsIndex()
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]).toContain('norefs')
    expect(r.indexed).toBe(0)
    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    expect(saved.entries.norefs.text).toBe('') // nothing invented
    // only the last 20 of the 25 pages were asked for, starting at page 6
    expect(m.docs[0].getPage).toHaveBeenCalledTimes(20)
    expect(m.docs[0].getPage.mock.calls[0][0]).toBe(6)
  })

  it('tolerates a broken cache file', async () => {
    const a = doc('d1')
    fs.writeFileSync(a.localPdf, 'x')
    fs.writeFileSync(cachePath, '{ this is not json')
    m.loadLibrary.mockReturnValue({ docs: [a], folders: [], syncedAt: '' })

    // reading a corrupt cache must not throw, and it is treated as empty
    expect(mod.searchRefs('deep')).toEqual([])
    const r = await mod.buildRefsIndex()
    expect(r.total).toBe(1)
    expect(r.skipped).toEqual([])
    // the build overwrote the broken file with a valid, usable one
    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    expect(saved.version).toBe(1)
    expect(saved.entries.d1.text).toContain('Deep Learning')
    expect(mod.searchRefs('Deep')).toHaveLength(1)
  })
})

describe('searchRefs', () => {
  it('is case-insensitive, rejects empty/short queries, and centers the snippet on the hit', () => {
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: {
          d1: {
            mtime: 1,
            size: 1,
            text: 'A. Author. Deep Learning for Retrieval. 2020 with more context here.',
            page: 5
          }
        }
      })
    )

    expect(mod.searchRefs('')).toEqual([])
    expect(mod.searchRefs('   ')).toEqual([])
    expect(mod.searchRefs('a')).toEqual([]) // length < 2
    expect(mod.searchRefs('zzzz')).toEqual([])

    const hit = mod.searchRefs('DEEP LEARNING') // case-insensitive phrase
    expect(hit).toHaveLength(1)
    expect(hit[0].docId).toBe('d1')
    expect(hit[0].page).toBe(5)
    expect(hit[0].snippet.toLowerCase()).toContain('deep') // snippet contains the hit
    expect(mod.searchRefs('deep')[0].docId).toBe('d1')
  })
})
