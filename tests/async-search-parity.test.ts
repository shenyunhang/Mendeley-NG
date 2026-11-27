import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The full-text and reference scans each have one algorithm and two drivers.
 * A synchronous driver is what the smoke suite and the older behaviour tests
 * call; an asynchronous one is what the IPC handler calls across event-loop
 * turns. These cases prove the two answers are the same hit for hit, that the
 * generator really yields, and that the event loop is free while a scan runs.
 */
const m = vi.hoisted(() => ({
  dataDir: vi.fn(),
  loadLibrary: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => '', getPath: () => '' }
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn()
}))

vi.mock('../electron/main/store', () => ({
  dataDir: m.dataDir,
  loadLibrary: m.loadLibrary
}))

let dir = ''
let ft!: typeof import('../electron/main/fulltext')
let refs!: typeof import('../electron/main/refsindex')

const QUERIES = ['network', 'alpha beta', 'qwen cud', 'qwen3.5 te', 'zzzzqqq', 'paper 7 model']

function manyDocIndex(count = 96) {
  const chunks: string[] = []
  const entries: Record<string, unknown> = {}
  let at = 0
  for (let i = 0; i < count; i++) {
    const text =
      `paper ${i} alpha beta network model qwen-cua retrieval words. `
      + `a second sentence for the coverage pass and the near fallback. `
    entries['d' + i] = {
      start: at,
      len: text.length,
      bounds: [at + 23, at + text.length],
      mtime: 1,
      size: 1,
      file: `d${i}.pdf`
    }
    at += text.length
    chunks.push(text)
  }
  const body = chunks.join('')
  fs.writeFileSync(path.join(dir, 'fulltext.dat'), body, 'utf8')
  fs.writeFileSync(
    path.join(dir, 'fulltext.json'),
    JSON.stringify({
      version: 2,
      // The offset table is only read when its budget matches the module's.
      // Ask for it instead of pinning 3, the default before whole-document
      // indexing became the starting point.
      pages: ft.fullTextPages(),
      bytes: Buffer.byteLength(body, 'utf8'),
      entries
    }),
    'utf8'
  )
}

function refsIndex(count = 96) {
  const entries: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    const text = `[${i}] A. Author. Deep Learning for Retrieval and network models. 2020`
    entries['d' + i] = { mtime: 1, size: 1, text, hay: text.toLowerCase(), page: 2 }
  }
  fs.writeFileSync(
    path.join(dir, 'references.json'),
    JSON.stringify({ version: 1, entries }),
    'utf8'
  )
}

function yieldedSteps<T>(it: Generator<void, T, void>): number {
  let n = 0
  let r = it.next()
  while (!r.done) {
    n++
    r = it.next()
  }
  return n
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-search-'))
  m.dataDir.mockReturnValue(dir)
  m.loadLibrary.mockReturnValue({ docs: [], folders: [], syncedAt: '' })
  ft = await import('../electron/main/fulltext')
  refs = await import('../electron/main/refsindex')
  ft.initFullText(dir)
  manyDocIndex()
  refsIndex()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('full-text scan, two drivers', () => {
  it('returns the same hits synchronously and asynchronously', async () => {
    for (const q of QUERIES) {
      expect(await ft.ftSearchAsync(q), q).toEqual(ft.ftSearch(q))
    }
  })

  it('yields more than once over a corpus of many papers', () => {
    expect(yieldedSteps(ft.ftSearchSteps('qwen cud'))).toBeGreaterThan(1)
    expect(yieldedSteps(ft.ftSearchSteps('alpha beta'))).toBeGreaterThan(1)
  })

  it('leaves the event loop free while a scan is running', async () => {
    let fired = false
    const running = ft.ftSearchAsync('qwen cud')
    setTimeout(() => {
      fired = true
    }, 0)
    const hits = await running
    expect(fired).toBe(true)
    expect(hits).toEqual(ft.ftSearch('qwen cud'))
  })

  it('abandons a superseded query at the next slice', async () => {
    const older = ft.ftSearchAsync('alpha beta')
    const newer = ft.ftSearchAsync('alpha beta')
    const [a, b] = await Promise.all([older, newer])
    expect(a).toEqual([])
    expect(b).toEqual(ft.ftSearch('alpha beta'))
  })

  it('does not read the corpus for a query below the length floor', async () => {
    expect(await ft.ftSearchAsync('z')).toEqual([])
    expect(ft.ftSearch('z')).toEqual([])
  })
})

describe('reference scan, two drivers', () => {
  it('returns the same hits synchronously and asynchronously', async () => {
    for (const q of ['deep', 'deep learning', 'DEEP LEARNING', 'qwen cud', 'zzzz', 'a']) {
      expect(await refs.searchRefsAsync(q), q).toEqual(refs.searchRefs(q))
    }
  })

  it('yields before walking the whole table', () => {
    expect(yieldedSteps(refs.searchRefsSteps('zzzz'))).toBeGreaterThan(1)
  })

  it('abandons a superseded query at the next slice', async () => {
    const older = refs.searchRefsAsync('deep')
    const newer = refs.searchRefsAsync('deep')
    const [a, b] = await Promise.all([older, newer])
    expect(a).toEqual([])
    expect(b).toEqual(refs.searchRefs('deep'))
  })
})
