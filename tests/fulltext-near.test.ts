import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The full-text index owns UTF-16 offsets into fulltext.dat and a byte anchor
 * alongside them. A near match must never take an offset from a folded copy:
 * that would put a hit in the wrong paper, on the wrong page, or show a
 * snippet that is not the text it matched.
 */

vi.mock('electron', () => ({
  app: { getAppPath: () => '', getPath: () => '' }
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn()
}))

interface TestEntry {
  start: number
  len: number
  bounds: number[]
}

let dir = ''
let mod!: typeof import('../electron/main/fulltext')

// The corpus is lower-cased when it is written (fulltext.ts writes
// page.toLowerCase()), so a fixture has to look like the real .dat file.
const FIRST = 'alpha beta gamma delta '
const SECOND = 'first page words here. qwen-cua: native computer use agents'
const BODY = FIRST + SECOND
// 'first page words here. ' is 23 characters, so the Qwen hit falls on page 2.
const PAGE_BREAK = FIRST.length + 22

function writeIndex(body: string, entries: Record<string, TestEntry>) {
  fs.writeFileSync(path.join(dir, 'fulltext.dat'), body, 'utf8')
  const full: Record<string, unknown> = {}
  for (const [id, e] of Object.entries(entries)) {
    full[id] = { ...e, mtime: 1, size: 1, file: id + '.pdf' }
  }
  fs.writeFileSync(
    path.join(dir, 'fulltext.json'),
    JSON.stringify({
      version: 2,
      pages: 3,
      bytes: Buffer.byteLength(body, 'utf8'),
      entries: full
    }),
    'utf8'
  )
}

function twoPaperIndex() {
  writeIndex(BODY, {
    d1: { start: 0, len: FIRST.length, bounds: [FIRST.length] },
    d2: {
      start: FIRST.length,
      len: SECOND.length,
      bounds: [PAGE_BREAK, BODY.length]
    }
  })
}

beforeEach(async () => {
  vi.resetModules()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fulltext-near-'))
  mod = await import('../electron/main/fulltext')
  mod.initFullText(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('ftSearch near fallback', () => {
  it('finds Qwen-CUA from "qwen cud" with the right document and page', () => {
    twoPaperIndex()
    const hits = mod.ftSearch('qwen cud')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.docId).toBe('d2')
    expect(hits[0]!.page).toBe(2)
    expect(hits[0]!.near).toBe(true)
    expect(hits[0]!.terms).toEqual(['qwen', 'cua'])
    // The snippet is cut from the original corpus, not a folded copy: the
    // hyphen is still there.
    expect(hits[0]!.snippet).toContain('qwen-cua')
  })

  it('keeps an exact hit exact', () => {
    twoPaperIndex()
    const hits = mod.ftSearch('qwen')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.near === undefined)).toBe(true)
  })

  it('returns nothing for a word salad', () => {
    twoPaperIndex()
    expect(mod.ftSearch('zzzz qqqq')).toEqual([])
  })

  it('does not rewrite the corpus or the offset table', () => {
    twoPaperIndex()
    const beforeData = fs.readFileSync(path.join(dir, 'fulltext.dat'), 'utf8')
    const beforeMeta = fs.readFileSync(path.join(dir, 'fulltext.json'), 'utf8')
    mod.ftSearch('qwen cud')
    expect(fs.readFileSync(path.join(dir, 'fulltext.dat'), 'utf8')).toBe(beforeData)
    expect(fs.readFileSync(path.join(dir, 'fulltext.json'), 'utf8')).toBe(beforeMeta)
  })

  it('a separator-folded query also reaches a hyphenated title', () => {
    twoPaperIndex()
    const hits = mod.ftSearch('qwen cua')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.docId).toBe('d2')
    expect(hits[0]!.snippet).toContain('qwen-cua')
  })

  it('does not guess from a single mistyped word', () => {
    twoPaperIndex()
    // The shared rule needs one exact word to anchor the match.
    expect(mod.ftSearch('cud')).toEqual([])
  })
})
