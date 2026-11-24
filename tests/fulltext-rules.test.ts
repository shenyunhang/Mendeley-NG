import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  docAt,
  endOf,
  isFullTextMetaShape,
  isReaderFailure,
  pageOf,
  type FullTextEntry,
  type FullTextMeta
} from '../shared/fulltextRules'

/**
 * The full-text index keeps a state machine that owns fs, a worker and an
 * append-only corpus. Its read-only rules used to live inside that module,
 * reachable only through a real build and a real PDF. These are fixed-input
 * cases for the boundaries that matter: a malformed meta table, an offset
 * that falls exactly on an entry boundary, and a worker error that is really
 * an installation fault.
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

const entry = (start: number, len: number, bounds: number[] = [start + len]): FullTextEntry => ({
  start,
  len,
  bounds,
  mtime: 100,
  size: 20
})

const meta = (over: Partial<FullTextMeta> = {}): FullTextMeta => ({
  version: 2,
  pages: 3,
  bytes: 100,
  entries: { a: entry(0, 10), b: entry(10, 20) },
  ...over
})

describe('isFullTextMetaShape refuses a table the reader would crash on', () => {
  const good = meta()
  const bad: unknown[] = [
    null,
    undefined,
    'meta',
    3,
    [],
    { ...good, version: 1 },
    { ...good, version: undefined },
    { ...good, bytes: NaN },
    { ...good, bytes: Infinity },
    { ...good, bytes: -1 },
    { ...good, bytes: '100' },
    { ...good, entries: null },
    { ...good, entries: [] },
    { ...good, entries: { a: null } },
    { ...good, entries: { a: { ...entry(0, 1), start: NaN } } },
    { ...good, entries: { a: { ...entry(0, 1), len: Infinity } } },
    { ...good, entries: { a: { ...entry(0, 1), bounds: null } } },
    { ...good, entries: { a: { ...entry(0, 1), bounds: [1, NaN] } } }
  ]

  it('accepts the shape loadMeta would cache', () => {
    expect(isFullTextMetaShape(good)).toBe(true)
    expect(isFullTextMetaShape(meta({ entries: {}, bytes: 0 }))).toBe(true)
  })

  it('rejects every malformed shape', () => {
    for (const m of bad) expect(isFullTextMetaShape(m), JSON.stringify(m)).toBe(false)
  })

  it('the version check narrows the standalone rule but not loadMeta', () => {
    // loadMeta already asked for version === 2 before calling the shape rule,
    // so the extra check cannot change what the index accepts on disk.
    const src = read('electron/main/fulltext.ts')
    expect(src).toContain('const sameFormat = m?.version === 2 && m?.pages === pages')
    expect(src).toContain('if (sameFormat && isFullTextMetaShape(m))')
    expect(isFullTextMetaShape({ ...good, version: 3 })).toBe(false)
  })
})

describe('endOf and docAt agree with the offsets in the table', () => {
  /** Copied verbatim from fulltext.ts before the extraction. */
  const legacyEndOf = (m: FullTextMeta): number => {
    let at = 0
    for (const e of Object.values(m.entries)) {
      if (e.start + e.len > at) at = e.start + e.len
    }
    return at
  }
  /** Copied verbatim from fulltext.ts before the extraction. */
  const legacyDocAt = (
    sorted: [string, FullTextEntry][],
    off: number
  ): [string, FullTextEntry] | null => {
    let lo = 0
    let hi = sorted.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const e = sorted[mid][1]
      if (off < e.start) hi = mid - 1
      else if (off >= e.start + e.len) lo = mid + 1
      else return sorted[mid]
    }
    return null
  }

  const tables: FullTextMeta[] = [
    meta(),
    meta({ entries: {} }),
    meta({ entries: { z: entry(50, 5), a: entry(0, 10), m: entry(20, 30) } })
  ]

  it('endOf matches the old walk on unordered and empty tables', () => {
    const samples = [
      meta(),
      meta({ entries: {} }),
      meta({ entries: { z: entry(50, 5), a: entry(0, 10), m: entry(20, 30) } })
    ]
    for (const m of samples) expect(endOf(m)).toBe(legacyEndOf(m))
    expect(endOf(meta({ entries: {} }))).toBe(0)
  })

  it('docAt matches the old binary search at every boundary', () => {
    for (const entries of tables.map((m) => m.entries)) {
      const sorted = Object.entries(entries).sort((a, b) => a[1].start - b[1].start)
      for (let off = -2; off <= 80; off++) {
        expect(docAt(sorted, off), `off=${off}`).toEqual(legacyDocAt(sorted, off))
      }
    }
    expect(docAt([], 0)).toBeNull()
    expect(docAt([['a', entry(0, 10)]], 9)?.[0]).toBe('a')
    expect(docAt([['a', entry(0, 10)]], 10)).toBeNull()
  })
})

describe('pageOf and isReaderFailure keep their old answers', () => {
  /** Copied verbatim from ftSearch before the extraction. */
  const legacyPageOf = (e: FullTextEntry, off: number): number => {
    for (let i = 0; i < e.bounds.length; i++) {
      if (off < e.bounds[i]) return i + 1
    }
    return e.bounds.length
  }
  const legacyReaderFailure = (err: string): boolean =>
    /fake worker|workerSrc|pdf\.worker|GlobalWorkerOptions/i.test(err)

  it('pageOf agrees on page bounds and trailing text', () => {
    const e = entry(0, 100, [20, 50, 100])
    for (const off of [0, 19, 20, 21, 49, 50, 99, 100, 500]) {
      expect(pageOf(e, off), `off=${off}`).toBe(legacyPageOf(e, off))
    }
    expect(pageOf(entry(0, 0, []), 0)).toBe(legacyPageOf(entry(0, 0, []), 0))
  })

  it('tells an install fault from one unreadable PDF', () => {
    const messages = [
      'Setting up fake worker failed',
      'No "GlobalWorkerOptions.workerSrc" specified',
      'Cannot load pdf.worker.mjs',
      'workerSrc is not set',
      'Invalid PDF structure',
      'XRef parsing failed',
      'password required',
      '',
      'PDF.JS WORKER MISSING'
    ]
    for (const m of messages) {
      expect(isReaderFailure(m), m).toBe(legacyReaderFailure(m))
    }
    expect(isReaderFailure('Setting up fake worker failed')).toBe(true)
    expect(isReaderFailure('Invalid PDF structure')).toBe(false)
  })
})

describe('the index module owns the state, not the rules', () => {
  it('the detector can see a locally defined rule', () => {
    const old = 'function isMetaShape(m: unknown): m is Meta {'
    expect('const x = 1\n' + old).toContain(old)
  })

  it('fulltext.ts imports the rules instead of defining them', () => {
    const src = read('electron/main/fulltext.ts')
    for (const name of ['function isMetaShape', 'function endOf', 'function docAt', 'function isReaderFailure', 'const pageOf =']) {
      expect(src, name).not.toContain(name)
    }
    expect(src).toContain("from '../../shared/fulltextRules'")
    expect(src).toContain("from '../../shared/indexedFileRules'")
    // The state machine that smoke asserts on is untouched.
    expect(src).toContain('clearedWhileBuilding = applyDeferred()')
    expect((src.match(/saveMeta\(fresh\)/g) ?? []).length).toBe(2)
  })

  it('both indexes take their query words from the same splitter', () => {
    const full = read('electron/main/fulltext.ts')
    const refs = read('electron/main/refsindex.ts')
    expect(full).toContain('fullTextQueryWords(needle)')
    expect(refs).toContain('fullTextQueryWords(needle)')
    // One pass must not invent its own tokenisation, and an exact phrase
    // must not cut the list short before the other passes have answered.
    expect(full).not.toContain("needle.split(' ')")
    expect(full).not.toContain('if (phrase.length) return phrase')
    expect(full).toContain('wordBoundaryMatch(body, at, t)')
  })
})
