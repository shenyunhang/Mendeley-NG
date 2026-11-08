import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { atomicWriteJson } from '../shared/atomicJson'
import { clampToRange } from '../shared/clamp'
import {
  FAILURE,
  failureCounts,
  ignoreFailure,
  reportFailure,
  resetFailureCounts,
  setFailureSink,
  type FailureKind,
  type FailureReason
} from '../shared/failures'
import { collectFileDocumentIds, type FilePageRow } from '../shared/filePages'
import {
  FULL_TEXT_MAX_PAGES,
  FULL_TEXT_MIN_PAGES,
  clampFullTextPages,
  restoredPageBudget
} from '../shared/fullTextPages'
import { mergeDocFields, reconcileSyncWrite } from '../shared/libraryReconcile'
import { collectPaged } from '../shared/paged'
import { shortDate } from '../shared/shortDate'
import { createSyncQueue } from '../shared/syncQueue'
import { acceptable, norm, ratio } from '../shared/text'
import { uniquePdfPath } from '../shared/uniquePdfPath'
import { UA } from '../shared/userAgent'
import {
  DEFAULT_FT_PAGES,
  DEFAULT_PDF_TEMPLATE,
  OAUTH_REDIRECT,
  PROJECT_URL
} from '../shared/types'
import { docsWithAllWords, type WordOccurrence } from '../shared/wordCoverage'

// Helpers --------------------------------------------------------------------

/** Settle promise chains without depending on wall-clock timers. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** A promise resolved or rejected explicitly by the test. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Isolated temp dir, always removed even when an assertion throws. */
function withTmpDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendeley-ng-shared-'))
  try {
    run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Reset the module-level failure state and install a recording sink. */
function freshFailures() {
  resetFailureCounts()
  const sink = vi.fn((_reason: FailureReason, _kind: FailureKind): void => {})
  setFailureSink(sink)
  return sink
}

/** A file-page fetcher that replays fixed pages and records each marker. */
function filePageSource(pages: (FilePageRow[] | null | undefined)[]) {
  const markers: (string | undefined)[] = []
  const fetchPage = vi.fn(
    async (marker?: string): Promise<FilePageRow[] | null | undefined> => {
      markers.push(marker)
      return pages.shift()
    }
  )
  return { fetchPage, markers }
}

interface PagedRow {
  id?: string | null
  tag?: string
}

/** A generic paged fetcher that replays fixed pages and records each marker. */
function pagedSource(pages: (PagedRow[] | null | undefined)[]) {
  const markers: (string | undefined)[] = []
  const fetchPage = vi.fn(
    async (marker?: string): Promise<PagedRow[] | null | undefined> => {
      markers.push(marker)
      return pages.shift()
    }
  )
  return { fetchPage, markers }
}

interface TestDoc {
  id: string
  title?: string
  star?: boolean
  tags?: string[]
  localPdf?: string
  score?: number
}

// atomicJson.ts --------------------------------------------------------------

describe('atomicWriteJson', () => {
  it('writes a JSON value that reads back unchanged', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'config.json')
      atomicWriteJson(file, { a: 1, b: ['x', true, null] })
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
      expect(parsed).toEqual({ a: 1, b: ['x', true, null] })
    })
  })

  it('renames the temp file away, leaving no .tmp beside the destination', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'config.json')
      atomicWriteJson(file, { ok: true })
      expect(fs.existsSync(file)).toBe(true)
      expect(fs.existsSync(file + '.tmp')).toBe(false)
    })
  })

  it('writes compact JSON when no space argument is given', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'compact.json')
      atomicWriteJson(file, { a: 1, b: 2 })
      expect(fs.readFileSync(file, 'utf-8')).toBe('{"a":1,"b":2}')
    })
  })

  it('honours a numeric space argument with indented output', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'pretty.json')
      atomicWriteJson(file, { a: 1 }, 2)
      const raw = fs.readFileSync(file, 'utf-8')
      expect(raw).toContain('\n')
      expect(raw).toContain('  "a": 1')
      const parsed: unknown = JSON.parse(raw)
      expect(parsed).toEqual({ a: 1 })
    })
  })

  it('honours a string space argument (a tab)', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'tab.json')
      atomicWriteJson(file, { a: 1 }, '\t')
      expect(fs.readFileSync(file, 'utf-8')).toContain('\t"a": 1')
    })
  })

  it('overwrites an existing file with the new complete value', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'library.json')
      fs.writeFileSync(file, '{"stale":true}', 'utf-8')
      atomicWriteJson(file, { fresh: [1, 2, 3] })
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
      expect(parsed).toEqual({ fresh: [1, 2, 3] })
    })
  })

  it('serialises null, numbers, booleans and strings as JSON literals', () => {
    withTmpDir((dir) => {
      const cases: { value: unknown; raw: string }[] = [
        { value: null, raw: 'null' },
        { value: 0, raw: '0' },
        { value: false, raw: 'false' },
        { value: 'hi', raw: '"hi"' }
      ]
      cases.forEach(({ value, raw }, i) => {
        const file = path.join(dir, `v${i}.json`)
        atomicWriteJson(file, value)
        expect(fs.readFileSync(file, 'utf-8')).toBe(raw)
      })
    })
  })

  it('propagates a circular-reference error before creating any file', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'cyclic.json')
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      expect(() => atomicWriteJson(file, cyclic)).toThrow()
      expect(fs.existsSync(file)).toBe(false)
      expect(fs.existsSync(file + '.tmp')).toBe(false)
    })
  })
})

// clamp.ts -------------------------------------------------------------------

describe('clampToRange', () => {
  it('returns the value when it lies inside the inclusive range', () => {
    expect(clampToRange(5, 0, 10)).toBe(5)
  })

  it('returns the lower bound when the value is below min', () => {
    expect(clampToRange(-3, 0, 10)).toBe(0)
  })

  it('returns the upper bound when the value is above max', () => {
    expect(clampToRange(42, 0, 10)).toBe(10)
  })

  it('keeps values exactly on both boundaries', () => {
    expect(clampToRange(0, 0, 10)).toBe(0)
    expect(clampToRange(10, 0, 10)).toBe(10)
  })

  it('returns NaN unchanged because non-finite input is not special-cased', () => {
    expect(Number.isNaN(clampToRange(NaN, 0, 10))).toBe(true)
  })

  it('clamps +Infinity to max and -Infinity to min', () => {
    expect(clampToRange(Infinity, 0, 10)).toBe(10)
    expect(clampToRange(-Infinity, 0, 10)).toBe(0)
  })

  it('does not round fractional values', () => {
    expect(clampToRange(5.5, 0, 10)).toBe(5.5)
  })

  it('works with a negative range and resolves to max when min exceeds max', () => {
    expect(clampToRange(-20, -10, -1)).toBe(-10)
    expect(clampToRange(0, -10, -1)).toBe(-1)
    expect(clampToRange(5, 10, 0)).toBe(0)
  })
})

// failures.ts ----------------------------------------------------------------

describe('FAILURE and failure counters', () => {
  it('exposes distinct string reasons that avoid the word "error"', () => {
    const reasons = Object.values(FAILURE)
    expect(reasons.length).toBeGreaterThan(0)
    expect(new Set(reasons).size).toBe(reasons.length)
    for (const reason of reasons) {
      expect(typeof reason).toBe('string')
      expect(reason.toLowerCase()).not.toContain('error')
    }
  })

  it('starts with an empty snapshot after a reset', () => {
    freshFailures()
    expect(failureCounts()).toEqual({})
  })

  it('ignoreFailure increments only the ignored tally', () => {
    freshFailures()
    ignoreFailure(FAILURE.notesOptional)
    expect(failureCounts()).toEqual({
      [FAILURE.notesOptional]: { ignored: 1, reported: 0 }
    })
  })

  it('reportFailure increments only the reported tally', () => {
    freshFailures()
    reportFailure(FAILURE.readingPosition)
    expect(failureCounts()).toEqual({
      [FAILURE.readingPosition]: { ignored: 0, reported: 1 }
    })
  })

  it('accumulates tallies independently per reason and kind', () => {
    freshFailures()
    ignoreFailure(FAILURE.appVersionCosmetic)
    ignoreFailure(FAILURE.appVersionCosmetic)
    reportFailure(FAILURE.appVersionCosmetic)
    ignoreFailure(FAILURE.testPdfCleanup)
    expect(failureCounts()).toEqual({
      [FAILURE.appVersionCosmetic]: { ignored: 2, reported: 1 },
      [FAILURE.testPdfCleanup]: { ignored: 1, reported: 0 }
    })
  })

  it('reportFailure forwards reason and kind to the configured sink', () => {
    const sink = freshFailures()
    reportFailure(FAILURE.cloudHighlightRemoval, new Error('ignored argument'))
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith(FAILURE.cloudHighlightRemoval, 'reported')
  })

  it('ignoreFailure never calls the sink', () => {
    const sink = freshFailures()
    ignoreFailure(FAILURE.undoFolderAdd)
    expect(sink).not.toHaveBeenCalled()
  })

  it('failureCounts returns a snapshot that cannot mutate internal tallies', () => {
    freshFailures()
    ignoreFailure(FAILURE.notesOptional)
    const snapshot: Record<string, unknown> = failureCounts()
    const entry: unknown = snapshot[FAILURE.notesOptional]
    if (typeof entry === 'object' && entry !== null && 'ignored' in entry) {
      const mutable = entry as { ignored: number }
      mutable.ignored = 99
    }
    expect(failureCounts()[FAILURE.notesOptional]).toEqual({ ignored: 1, reported: 0 })
  })

  it('setFailureSink(null) restores the console.warn default', () => {
    resetFailureCounts()
    setFailureSink(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      reportFailure(FAILURE.appVersionCosmetic)
      expect(warn).toHaveBeenCalledWith('[mendeley-ng] ' + FAILURE.appVersionCosmetic)
    } finally {
      warn.mockRestore()
      setFailureSink(() => {})
    }
  })

  it('resetFailureCounts clears earlier tallies', () => {
    freshFailures()
    ignoreFailure(FAILURE.notesOptional)
    reportFailure(FAILURE.readingPosition)
    resetFailureCounts()
    expect(failureCounts()).toEqual({})
  })
})

// filePages.ts ---------------------------------------------------------------

describe('collectFileDocumentIds', () => {
  it('collects every document_id from a single short page', async () => {
    const { fetchPage } = filePageSource([
      [
        { id: 'f1', document_id: 'd1' },
        { id: 'f2', document_id: 'd2' }
      ]
    ])
    const ids = await collectFileDocumentIds(fetchPage, 200)
    expect([...ids].sort()).toEqual(['d1', 'd2'])
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('de-duplicates document_id values through a Set', async () => {
    const { fetchPage } = filePageSource([
      [
        { id: 'f1', document_id: 'same' },
        { id: 'f2', document_id: 'same' }
      ]
    ])
    const ids = await collectFileDocumentIds(fetchPage, 200)
    expect(ids.size).toBe(1)
    expect(ids.has('same')).toBe(true)
  })

  it('uses the last row file id, not document_id, as the next marker', async () => {
    const { fetchPage, markers } = filePageSource([
      [
        { id: 'f1', document_id: 'd1' },
        { id: 'f2', document_id: 'd2' }
      ],
      [{ id: 'f3', document_id: 'd3' }]
    ])
    const ids = await collectFileDocumentIds(fetchPage, 2)
    expect(markers).toEqual([undefined, 'f2'])
    expect([...ids].sort()).toEqual(['d1', 'd2', 'd3'])
  })

  it('stops on a short page without fetching again', async () => {
    const { fetchPage } = filePageSource([[{ id: 'f1', document_id: 'd1' }]])
    await collectFileDocumentIds(fetchPage, 2)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('stops on a page whose file ids are all already seen', async () => {
    const { fetchPage } = filePageSource([
      [
        { id: 'f1', document_id: 'd1' },
        { id: 'f2', document_id: 'd2' }
      ],
      [
        { id: 'f1', document_id: 'dX' },
        { id: 'f2', document_id: 'dY' }
      ]
    ])
    const ids = await collectFileDocumentIds(fetchPage, 2)
    expect(fetchPage).toHaveBeenCalledTimes(2)
    // document_id values are still collected before the freshness check breaks.
    expect(ids.has('dX')).toBe(true)
    expect(ids.has('dY')).toBe(true)
  })

  it('treats null, undefined and empty pages as the end of the walk', async () => {
    const pages: (FilePageRow[] | null | undefined)[] = [null, undefined, []]
    for (const page of pages) {
      const { fetchPage } = filePageSource([page])
      await expect(collectFileDocumentIds(fetchPage, 2)).resolves.toEqual(new Set())
      expect(fetchPage).toHaveBeenCalledTimes(1)
    }
  })

  it('stops when the marker does not move forward', async () => {
    const { fetchPage } = filePageSource([
      [
        { id: 'f2', document_id: 'd2' },
        { id: 'f1', document_id: 'd1' }
      ],
      [
        { id: 'f3', document_id: 'd3' },
        { id: 'f1', document_id: 'd4' }
      ]
    ])
    const ids = await collectFileDocumentIds(fetchPage, 2)
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(ids.has('d3')).toBe(true)
    expect(ids.has('d4')).toBe(true)
  })

  it('stops when the last row has no file id', async () => {
    const { fetchPage } = filePageSource([
      [
        { id: 'f1', document_id: 'd1' },
        { document_id: 'd2' }
      ]
    ])
    const ids = await collectFileDocumentIds(fetchPage, 2)
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect([...ids].sort()).toEqual(['d1', 'd2'])
  })

  it('respects maxPages when every page is full', async () => {
    let n = 0
    const fetchPage = vi.fn(async (): Promise<FilePageRow[]> => {
      n++
      return [
        { id: `f${n}a`, document_id: `d${n}a` },
        { id: `f${n}b`, document_id: `d${n}b` }
      ]
    })
    const ids = await collectFileDocumentIds(fetchPage, 2, 3)
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(ids.size).toBe(6)
  })

  it('honours the default limit of 200', async () => {
    const rows: FilePageRow[] = Array.from({ length: 199 }, (_, i) => ({
      id: `f${i}`,
      document_id: `d${i}`
    }))
    const { fetchPage } = filePageSource([rows])
    const ids = await collectFileDocumentIds(fetchPage)
    expect(ids.size).toBe(199)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })
})

// fullTextPages.ts -----------------------------------------------------------

describe('clampFullTextPages', () => {
  it('passes through a whole number inside 1..50', () => {
    expect(clampFullTextPages(5)).toBe(5)
  })

  it('clamps values above the maximum to 50', () => {
    expect(clampFullTextPages(51)).toBe(50)
    expect(clampFullTextPages(999)).toBe(50)
  })

  it('clamps negative values to the minimum of 1', () => {
    expect(clampFullTextPages(-5)).toBe(1)
  })

  it('floors a fractional budget before clamping', () => {
    expect(clampFullTextPages(50.9)).toBe(50)
    expect(clampFullTextPages('7.9')).toBe(7)
  })

  it('falls back to the default for zero, NaN, null, undefined and empty string', () => {
    expect(clampFullTextPages(0)).toBe(DEFAULT_FT_PAGES)
    expect(clampFullTextPages(NaN)).toBe(DEFAULT_FT_PAGES)
    expect(clampFullTextPages(null)).toBe(DEFAULT_FT_PAGES)
    expect(clampFullTextPages(undefined)).toBe(DEFAULT_FT_PAGES)
    expect(clampFullTextPages('')).toBe(DEFAULT_FT_PAGES)
  })

  it('coerces numeric strings', () => {
    expect(clampFullTextPages('7')).toBe(7)
    expect(clampFullTextPages('50')).toBe(50)
  })

  it('falls back to the default for non-numeric strings and objects', () => {
    expect(clampFullTextPages('abc')).toBe(DEFAULT_FT_PAGES)
    expect(clampFullTextPages({})).toBe(DEFAULT_FT_PAGES)
  })

  it('falls back to the default for a positive fraction below one', () => {
    expect(clampFullTextPages(0.9)).toBe(DEFAULT_FT_PAGES)
  })

  it('clamps infinities and coerces booleans through Number', () => {
    expect(clampFullTextPages(Infinity)).toBe(50)
    expect(clampFullTextPages(-Infinity)).toBe(1)
    expect(clampFullTextPages(true)).toBe(1)
    expect(clampFullTextPages(false)).toBe(DEFAULT_FT_PAGES)
  })
})

describe('restoredPageBudget', () => {
  it('accepts a positive number and clamps it', () => {
    expect(restoredPageBudget(100)).toBe(50)
  })

  it('rejects numeric strings even though clampFullTextPages accepts them', () => {
    expect(restoredPageBudget('7')).toBe(DEFAULT_FT_PAGES)
  })

  it('rejects zero, negative numbers, NaN, null, undefined and objects', () => {
    expect(restoredPageBudget(0)).toBe(DEFAULT_FT_PAGES)
    expect(restoredPageBudget(-1)).toBe(DEFAULT_FT_PAGES)
    expect(restoredPageBudget(NaN)).toBe(DEFAULT_FT_PAGES)
    expect(restoredPageBudget(null)).toBe(DEFAULT_FT_PAGES)
    expect(restoredPageBudget(undefined)).toBe(DEFAULT_FT_PAGES)
    expect(restoredPageBudget({})).toBe(DEFAULT_FT_PAGES)
  })

  it('floors a positive fractional number', () => {
    expect(restoredPageBudget(5.9)).toBe(5)
  })

  it('accepts Infinity as a positive number and clamps it', () => {
    expect(restoredPageBudget(Infinity)).toBe(50)
  })

  it('exposes the shared bounds and default', () => {
    expect(FULL_TEXT_MIN_PAGES).toBe(1)
    expect(FULL_TEXT_MAX_PAGES).toBe(50)
    expect(DEFAULT_FT_PAGES).toBe(3)
  })
})

// libraryReconcile.ts --------------------------------------------------------

describe('mergeDocFields', () => {
  it('returns theirs unchanged when base or ours is missing', () => {
    const theirs: TestDoc = { id: '1', title: 'cloud' }
    expect(mergeDocFields<TestDoc>(undefined, { id: '1' }, theirs)).toBe(theirs)
    expect(mergeDocFields<TestDoc>({ id: '1' }, undefined, theirs)).toBe(theirs)
  })

  it('keeps a locally changed field when the cloud did not change it', () => {
    const base: TestDoc = { id: '1', star: false, title: 'T' }
    const ours: TestDoc = { id: '1', star: true, title: 'T' }
    const theirs: TestDoc = { id: '1', star: false, title: 'T' }
    expect(mergeDocFields(base, ours, theirs).star).toBe(true)
  })

  it('prefers the cloud value when only the cloud changed a field', () => {
    const base: TestDoc = { id: '1', title: 'Old' }
    const ours: TestDoc = { id: '1', title: 'Old' }
    const theirs: TestDoc = { id: '1', title: 'New' }
    expect(mergeDocFields(base, ours, theirs).title).toBe('New')
  })

  it('prefers the cloud value when both sides changed the same field', () => {
    const base: TestDoc = { id: '1', title: 'Old' }
    const ours: TestDoc = { id: '1', title: 'Local' }
    const theirs: TestDoc = { id: '1', title: 'Cloud' }
    expect(mergeDocFields(base, ours, theirs).title).toBe('Cloud')
  })

  it('carries over a field added locally that the cloud does not have', () => {
    const base: TestDoc = { id: '1' }
    const ours: TestDoc = { id: '1', tags: ['local'] }
    const theirs: TestDoc = { id: '1' }
    expect(mergeDocFields(base, ours, theirs).tags).toEqual(['local'])
  })

  it('keeps fields that exist only in theirs', () => {
    const base: TestDoc = { id: '1' }
    const ours: TestDoc = { id: '1' }
    const theirs: TestDoc = { id: '1', localPdf: 'p.pdf' }
    expect(mergeDocFields(base, ours, theirs).localPdf).toBe('p.pdf')
  })

  it('compares object fields structurally through JSON.stringify', () => {
    const base: TestDoc = { id: '1', tags: ['a'] }
    const ours: TestDoc = { id: '1', tags: ['a', 'b'] }
    expect(mergeDocFields(base, ours, { id: '1', tags: ['a'] }).tags).toEqual(['a', 'b'])
    expect(mergeDocFields(base, ours, { id: '1', tags: ['a', 'c'] }).tags).toEqual(['a', 'c'])
  })

  it('treats NaN as equal to itself via Object.is', () => {
    const base: TestDoc = { id: '1', score: 1 }
    const ours: TestDoc = { id: '1', score: NaN }
    const theirs: TestDoc = { id: '1', score: 1 }
    expect(Number.isNaN(mergeDocFields(base, ours, theirs).score)).toBe(true)
  })

  it('returns a new object and never mutates theirs', () => {
    const base: TestDoc = { id: '1', star: false }
    const ours: TestDoc = { id: '1', star: true }
    const theirs: TestDoc = { id: '1', star: false }
    const result = mergeDocFields(base, ours, theirs)
    expect(result).not.toBe(theirs)
    expect(theirs.star).toBe(false)
  })
})

describe('reconcileSyncWrite', () => {
  it('keeps proposed docs in their original order', () => {
    const proposed: TestDoc[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const result = reconcileSyncWrite({
      started: [],
      proposed,
      current: null,
      trashedIds: new Set<string>()
    })
    expect(result.map((d) => d.id)).toEqual(['a', 'b', 'c'])
  })

  it('removes trashed ids from the kept set', () => {
    const result = reconcileSyncWrite({
      started: [],
      proposed: [{ id: 'a' }, { id: 'b' }],
      current: null,
      trashedIds: new Set<string>(['a'])
    })
    expect(result.map((d) => d.id)).toEqual(['b'])
  })

  it('does not resurrect a doc deleted locally during the pull', () => {
    const result = reconcileSyncWrite({
      started: [{ id: 'a' }],
      proposed: [{ id: 'a' }],
      current: [],
      trashedIds: new Set<string>()
    })
    expect(result).toEqual([])
  })

  it('skips local-deletion detection when current is null', () => {
    const result = reconcileSyncWrite({
      started: [{ id: 'a' }],
      proposed: [{ id: 'a' }],
      current: null,
      trashedIds: new Set<string>()
    })
    expect(result.map((d) => d.id)).toEqual(['a'])
  })

  it('appends docs added locally during the pull', () => {
    const result = reconcileSyncWrite({
      started: [{ id: 'a' }],
      proposed: [{ id: 'a' }],
      current: [{ id: 'a' }, { id: 'b' }],
      trashedIds: new Set<string>()
    })
    expect(result.map((d) => d.id)).toEqual(['a', 'b'])
  })

  it('does not append a local addition that was trashed', () => {
    const result = reconcileSyncWrite({
      started: [{ id: 'a' }],
      proposed: [{ id: 'a' }],
      current: [{ id: 'a' }, { id: 'b' }],
      trashedIds: new Set<string>(['b'])
    })
    expect(result.map((d) => d.id)).toEqual(['a'])
  })

  it('does not duplicate a doc present in both proposed and current', () => {
    const result = reconcileSyncWrite({
      started: [{ id: 'a' }],
      proposed: [{ id: 'a' }],
      current: [{ id: 'a' }],
      trashedIds: new Set<string>()
    })
    expect(result.map((d) => d.id)).toEqual(['a'])
  })

  it('drops a cloud deletion even if the stale current file still has it', () => {
    const result = reconcileSyncWrite({
      started: [{ id: 'a' }],
      proposed: [],
      current: [{ id: 'a' }],
      trashedIds: new Set<string>()
    })
    expect(result).toEqual([])
  })

  it('merges field-level changes: a local star survives a cloud title edit', () => {
    const result = reconcileSyncWrite({
      started: [{ id: '1', star: false, title: 'Old' }],
      proposed: [{ id: '1', star: false, title: 'New' }],
      current: [{ id: '1', star: true, title: 'Old' }],
      trashedIds: new Set<string>()
    })
    expect(result).toEqual([{ id: '1', star: true, title: 'New' }])
  })

  it('keeps a proposed doc absent from started with all its cloud fields', () => {
    const result = reconcileSyncWrite({
      started: [],
      proposed: [{ id: 'x', title: 'New' }],
      current: [],
      trashedIds: new Set<string>()
    })
    expect(result).toEqual([{ id: 'x', title: 'New' }])
  })

  it('returns an empty array for empty inputs', () => {
    const result = reconcileSyncWrite({
      started: [],
      proposed: [],
      current: [],
      trashedIds: new Set<string>()
    })
    expect(result).toEqual([])
  })

  it('orders kept docs before local additions', () => {
    const result = reconcileSyncWrite({
      started: [{ id: 'b' }],
      proposed: [{ id: 'b' }],
      current: [{ id: 'a' }, { id: 'b' }],
      trashedIds: new Set<string>()
    })
    expect(result.map((d) => d.id)).toEqual(['b', 'a'])
  })
})

// paged.ts -------------------------------------------------------------------

describe('collectPaged', () => {
  it('returns all rows of a single short page and stops', async () => {
    const { fetchPage } = pagedSource([[{ id: 'a' }, { id: 'b' }]])
    const rows = await collectPaged(fetchPage, 3)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('walks full pages using the last row id as the marker', async () => {
    const { fetchPage, markers } = pagedSource([
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'c' }]
    ])
    const rows = await collectPaged(fetchPage, 2)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(markers).toEqual([undefined, 'b'])
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('drops rows whose ids were already seen', async () => {
    const { fetchPage, markers } = pagedSource([
      [
        { id: 'a', tag: 'A' },
        { id: 'b', tag: 'B' }
      ],
      [
        { id: 'a', tag: 'A2' },
        { id: 'c', tag: 'C' },
        { id: 'd', tag: 'D' }
      ]
    ])
    const rows = await collectPaged(fetchPage, 2)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(markers).toEqual([undefined, 'b', 'd'])
  })

  it('stops on a page whose ids are all already seen', async () => {
    const { fetchPage } = pagedSource([
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'a' }, { id: 'b' }]
    ])
    const rows = await collectPaged(fetchPage, 2)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('keeps id-less rows from a duplicate page before stopping', async () => {
    const { fetchPage } = pagedSource([
      [{ tag: 'x' }, { id: 'a' }],
      [{ id: 'a' }, { tag: 'y' }]
    ])
    const rows = await collectPaged(fetchPage, 2)
    expect(rows).toHaveLength(3)
    expect(rows[2]).toEqual({ tag: 'y' })
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('takes exactly one page when no row has an id', async () => {
    const { fetchPage } = pagedSource([[{ tag: 'x' }, { tag: 'y' }, { tag: 'z' }]])
    const rows = await collectPaged(fetchPage, 2)
    expect(rows).toHaveLength(3)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('treats an empty id string as no id', async () => {
    const { fetchPage } = pagedSource([[{ id: '' }, { id: '' }]])
    const rows = await collectPaged(fetchPage, 2)
    expect(rows).toHaveLength(2)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('treats null, undefined and empty pages as the end of the walk', async () => {
    const pages: (PagedRow[] | null | undefined)[] = [null, undefined, []]
    for (const page of pages) {
      const { fetchPage } = pagedSource([page])
      await expect(collectPaged(fetchPage, 2)).resolves.toEqual([])
      expect(fetchPage).toHaveBeenCalledTimes(1)
    }
  })

  it('stops when the marker does not advance', async () => {
    const { fetchPage } = pagedSource([
      [{ id: 'b' }, { id: 'a' }],
      [{ id: 'c' }, { id: 'a' }]
    ])
    const rows = await collectPaged(fetchPage, 2)
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('stops when the last row has no id', async () => {
    const { fetchPage } = pagedSource([[{ id: 'a' }, { tag: 'no-id' }]])
    const rows = await collectPaged(fetchPage, 2)
    expect(rows).toHaveLength(2)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('respects maxPages when every page is full', async () => {
    let n = 0
    const fetchPage = vi.fn(async (): Promise<PagedRow[]> => {
      n++
      return [{ id: `x${n}a` }, { id: `x${n}b` }]
    })
    const rows = await collectPaged(fetchPage, 2, 3)
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(rows).toHaveLength(6)
  })

  it('reports cumulative counts through onPage', async () => {
    const onPage = vi.fn((_count: number): void => {})
    const { fetchPage } = pagedSource([
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'c' }]
    ])
    await collectPaged(fetchPage, 2, 200, onPage)
    expect(onPage.mock.calls).toEqual([[2], [3]])
  })

  it('does not call onPage for a fully duplicate page', async () => {
    const onPage = vi.fn((_count: number): void => {})
    const { fetchPage } = pagedSource([
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'a' }, { id: 'b' }]
    ])
    await collectPaged(fetchPage, 2, 200, onPage)
    expect(onPage.mock.calls).toEqual([[2]])
  })
})

// shortDate.ts ---------------------------------------------------------------

describe('shortDate', () => {
  it('trims an ISO timestamp to its first ten characters', () => {
    expect(shortDate('2024-03-15T12:34:56.789Z')).toBe('2024-03-15')
  })

  it('returns an empty string for undefined', () => {
    expect(shortDate()).toBe('')
  })

  it('returns an empty string for null', () => {
    expect(shortDate(null)).toBe('')
  })

  it('returns an empty string for an empty input', () => {
    expect(shortDate('')).toBe('')
  })

  it('keeps strings shorter than ten characters unchanged', () => {
    expect(shortDate('2024')).toBe('2024')
  })

  it('keeps a ten-character day string unchanged', () => {
    expect(shortDate('2024-01-01')).toBe('2024-01-01')
  })

  it('does not parse the value as a date', () => {
    expect(shortDate('not-a-real-date-value')).toBe('not-a-real')
  })
})

// syncQueue.ts ---------------------------------------------------------------

describe('createSyncQueue', () => {
  it('runs a single pull and resolves with its result', async () => {
    const d = deferred<string>()
    const run = vi.fn((_full: boolean): Promise<string> => d.promise)
    const p = createSyncQueue(run)(true)
    await flush()
    expect(run).toHaveBeenCalledWith(true)
    d.resolve('answer')
    await expect(p).resolves.toBe('answer')
  })

  it('serialises a second pull until the first one settles', async () => {
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    const pending = [d1, d2]
    const run = vi.fn((_full: boolean): Promise<string> => {
      const d = pending.shift()
      if (!d) throw new Error('unexpected pull')
      return d.promise
    })
    const q = createSyncQueue(run)
    const p1 = q(true)
    const p2 = q(false)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    d1.resolve('first')
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
    d2.resolve('second')
    await expect(p1).resolves.toBe('first')
    await expect(p2).resolves.toBe('second')
  })

  it('keeps the full flag and call order of every queued pull', async () => {
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    const d3 = deferred<string>()
    const pending = [d1, d2, d3]
    const run = vi.fn((_full: boolean): Promise<string> => {
      const d = pending.shift()
      if (!d) throw new Error('unexpected pull')
      return d.promise
    })
    const q = createSyncQueue(run)
    const p1 = q(true)
    const p2 = q(false)
    const p3 = q(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    d1.resolve('ok')
    d2.resolve('ok')
    d3.resolve('ok')
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['ok', 'ok', 'ok'])
    expect(run.mock.calls.map((c) => c[0])).toEqual([true, false, true])
  })

  it('does not let a rejected pull poison later pulls', async () => {
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    const pending = [d1, d2]
    const run = vi.fn((_full: boolean): Promise<string> => {
      const d = pending.shift()
      if (!d) throw new Error('unexpected pull')
      return d.promise
    })
    const q = createSyncQueue(run)
    const p1 = q(true)
    const failed = expect(p1).rejects.toThrow('boom')
    const p2 = q(false)
    await flush()
    d1.reject(new Error('boom'))
    await failed
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
    d2.resolve('recovered')
    await expect(p2).resolves.toBe('recovered')
  })

  it('recovers when run throws synchronously', async () => {
    const d2 = deferred<string>()
    let call = 0
    const run = vi.fn((_full: boolean): Promise<string> => {
      call++
      if (call === 1) throw new Error('sync boom')
      return d2.promise
    })
    const q = createSyncQueue(run)
    const p1 = q(true)
    const failed = expect(p1).rejects.toThrow('sync boom')
    const p2 = q(false)
    await flush()
    await failed
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
    d2.resolve('ok')
    await expect(p2).resolves.toBe('ok')
  })

  it('remains usable after an earlier pull has settled', async () => {
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    const pending = [d1, d2]
    const run = vi.fn((_full: boolean): Promise<string> => {
      const d = pending.shift()
      if (!d) throw new Error('unexpected pull')
      return d.promise
    })
    const q = createSyncQueue(run)
    const p1 = q(false)
    await flush()
    d1.resolve('one')
    await expect(p1).resolves.toBe('one')
    const p2 = q(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
    d2.resolve('two')
    await expect(p2).resolves.toBe('two')
  })
})

// text.ts --------------------------------------------------------------------

describe('norm', () => {
  it('lowercases and reduces punctuation to single spaces', () => {
    expect(norm('Hello,  World!')).toBe('hello world')
  })

  it('collapses whitespace runs and trims edges', () => {
    expect(norm('  a   b  ')).toBe('a b')
  })

  it('maps punctuation-only and empty input to an empty string', () => {
    expect(norm('!!!')).toBe('')
    expect(norm('')).toBe('')
  })

  it('keeps digits while dropping non-ascii letters', () => {
    expect(norm('Café 2024')).toBe('caf 2024')
  })

  it('drops CJK characters entirely', () => {
    expect(norm('中文标题')).toBe('')
  })

  it('falls back to an empty string for a runtime null', () => {
    expect(norm(null as unknown as string)).toBe('')
  })
})

describe('ratio', () => {
  it('returns 1 for titles that normalise identically', () => {
    expect(ratio('Hello, World!', 'hello world')).toBe(1)
  })

  it('returns 0 when either normalised title is empty', () => {
    expect(ratio('', 'abc')).toBe(0)
    expect(ratio('!!!', 'abc')).toBe(0)
  })

  it('returns 0 for disjoint character sets', () => {
    expect(ratio('abc', 'xyz')).toBe(0)
  })

  it('computes 2*LCS/(lenA+lenB)', () => {
    expect(ratio('abc', 'abd')).toBeCloseTo(2 / 3)
    expect(ratio('abc', 'cba')).toBeCloseTo(1 / 3)
    expect(ratio('hello world', 'hello')).toBeCloseTo(0.625)
  })

  it('is symmetric', () => {
    expect(ratio('lifelong object detection', 'object detection')).toBeCloseTo(
      ratio('object detection', 'lifelong object detection')
    )
  })

  it('scores an appended subtitle at 32/41', () => {
    expect(ratio('object detection', 'lifelong object detection')).toBeCloseTo(32 / 41)
  })

  it('stays within 0..1', () => {
    const r = ratio('a longer title here', 'a longer title there')
    expect(r).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThanOrEqual(1)
  })
})

describe('acceptable', () => {
  it('accepts titles that normalise identically', () => {
    expect(acceptable('Deep Learning', 'deep learning!')).toBe(true)
  })

  it('accepts a high-similarity long title', () => {
    const a = 'abcdefghij'.repeat(5)
    const b = a.slice(0, 49) + 'z'
    expect(acceptable(a, b)).toBe(true)
  })

  it('rejects short titles that merely contain each other', () => {
    expect(acceptable('Object detection', 'Lifelong Object Detection')).toBe(false)
  })

  it('rejects completely different short titles', () => {
    expect(acceptable('abc', 'xyz')).toBe(false)
  })

  it('accepts long containment when ratio is at least 0.75', () => {
    const a = 'abcdefghij'.repeat(6)
    const b = a.slice(0, 40)
    expect(acceptable(a, b)).toBe(true)
  })

  it('rejects long containment when ratio is below 0.75', () => {
    const a = 'abcdefghij'.repeat(10)
    const b = a.slice(0, 40)
    expect(acceptable(a, b)).toBe(false)
  })

  it('rejects long titles with neither containment nor a high ratio', () => {
    expect(acceptable('a'.repeat(45), 'b'.repeat(45))).toBe(false)
  })

  it('rejects an empty title', () => {
    expect(acceptable('', 'x')).toBe(false)
  })
})

// uniquePdfPath.ts -----------------------------------------------------------

describe('uniquePdfPath', () => {
  const dir = path.join('library', 'pdfs')

  it('returns the wanted path when it is free', () => {
    const exists = vi.fn((_p: string): boolean => false)
    expect(uniquePdfPath(dir, 'paper.pdf', exists)).toBe(path.join(dir, 'paper.pdf'))
    expect(exists).toHaveBeenCalledTimes(1)
  })

  it('returns the (2) candidate when the wanted path is taken', () => {
    const first = path.join(dir, 'paper.pdf')
    const exists = vi.fn((p: string): boolean => p === first)
    expect(uniquePdfPath(dir, 'paper.pdf', exists)).toBe(path.join(dir, 'paper (2).pdf'))
  })

  it('skips occupied (2) and (3) candidates', () => {
    const occupied = new Set<string>([
      path.join(dir, 'paper.pdf'),
      path.join(dir, 'paper (2).pdf'),
      path.join(dir, 'paper (3).pdf')
    ])
    const exists = vi.fn((p: string): boolean => occupied.has(p))
    expect(uniquePdfPath(dir, 'paper.pdf', exists)).toBe(path.join(dir, 'paper (4).pdf'))
  })

  it('returns null after all 48 numbered candidates are exhausted', () => {
    const exists = vi.fn((_p: string): boolean => true)
    expect(uniquePdfPath(dir, 'paper.pdf', exists)).toBeNull()
    expect(exists).toHaveBeenCalledTimes(49)
  })

  it('never probes a (50) candidate', () => {
    const exists = vi.fn((p: string): boolean => !p.includes(' (50).pdf'))
    expect(uniquePdfPath(dir, 'paper.pdf', exists)).toBeNull()
    expect(exists.mock.calls.some((c) => c[0].includes(' (50).pdf'))).toBe(false)
  })

  it('returns the highest allowed (49) candidate when only that is free', () => {
    const exists = vi.fn((p: string): boolean => !p.endsWith(' (49).pdf'))
    expect(uniquePdfPath(dir, 'paper.pdf', exists)).toBe(path.join(dir, 'paper (49).pdf'))
  })

  it('does not rename a wanted name lacking a lowercase .pdf suffix', () => {
    const exists = vi.fn((_p: string): boolean => true)
    expect(uniquePdfPath(dir, 'paper.PDF', exists)).toBeNull()
    expect(new Set(exists.mock.calls.map((c) => c[0])).size).toBe(1)
  })

  it('replaces only the trailing .pdf when the name contains another .pdf', () => {
    const first = path.join(dir, 'a.pdf.pdf')
    const exists = vi.fn((p: string): boolean => p === first)
    expect(uniquePdfPath(dir, 'a.pdf.pdf', exists)).toBe(path.join(dir, 'a.pdf (2).pdf'))
  })
})

// userAgent.ts ---------------------------------------------------------------

describe('UA', () => {
  it('is a non-empty browser UA string without line breaks', () => {
    expect(typeof UA).toBe('string')
    expect(UA.length).toBeGreaterThan(0)
    expect(UA).not.toMatch(/[\r\n]/)
  })

  it('starts with Mozilla/5.0 and pins Chrome 124 with WebKit/Safari tokens', () => {
    expect(UA.startsWith('Mozilla/5.0')).toBe(true)
    expect(UA).toContain('Chrome/124.0.0.0')
    expect(UA).toContain('AppleWebKit/537.36')
    expect(UA).toContain('Safari/537.36')
  })

  it('equals the exact shared constant', () => {
    expect(UA).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    )
  })
})

// wordCoverage.ts ------------------------------------------------------------

describe('docsWithAllWords', () => {
  const occ = (docId: string, word: number, at: number): WordOccurrence => ({ docId, word, at })

  it('returns an empty Map for no occurrences', () => {
    expect(docsWithAllWords([], 3).size).toBe(0)
  })

  it('collects a doc that has every requested word', () => {
    const result = docsWithAllWords([occ('d1', 0, 10), occ('d1', 1, 20)], 2)
    expect(result.get('d1')).toBe(10)
    expect(result.size).toBe(1)
  })

  it('excludes a doc that is missing at least one word', () => {
    const result = docsWithAllWords([occ('d1', 0, 1), occ('d1', 1, 2), occ('d2', 0, 3)], 2)
    expect(result.has('d1')).toBe(true)
    expect(result.has('d2')).toBe(false)
  })

  it('deduplicates repeated word indices', () => {
    const result = docsWithAllWords([occ('d1', 0, 5), occ('d1', 0, 9), occ('d1', 1, 7)], 2)
    expect(result.get('d1')).toBe(5)
  })

  it('uses the smallest at value, including from a repeated word', () => {
    const result = docsWithAllWords([occ('d1', 0, 10), occ('d1', 1, 4), occ('d1', 0, 2)], 2)
    expect(result.get('d1')).toBe(2)
  })

  it('matches a 32-word query without bitmask overflow', () => {
    const occurrences = Array.from({ length: 32 }, (_, w) => occ('d1', w, 100 + w))
    const result = docsWithAllWords(occurrences, 32)
    expect(result.has('d1')).toBe(true)
    expect(result.get('d1')).toBe(100)
  })

  it('matches a 33-word query without bitmask overflow', () => {
    const occurrences = Array.from({ length: 33 }, (_, w) => occ('d1', w, 50 + w))
    const result = docsWithAllWords(occurrences, 33)
    expect(result.has('d1')).toBe(true)
    expect(result.get('d1')).toBe(50)
  })

  it('returns an empty Map when wordCount exceeds observed words', () => {
    expect(docsWithAllWords([occ('d1', 0, 1), occ('d1', 1, 2)], 5).size).toBe(0)
  })

  it('preserves first-seen doc order in the result keys', () => {
    const result = docsWithAllWords(
      [occ('d2', 0, 1), occ('d1', 0, 2), occ('d1', 1, 3), occ('d2', 1, 4)],
      2
    )
    expect([...result.keys()]).toEqual(['d2', 'd1'])
  })

  it('returns an empty Map when wordCount is zero', () => {
    expect(docsWithAllWords([occ('d1', 0, 1)], 0).size).toBe(0)
  })
})

// types.ts -------------------------------------------------------------------

describe('shared constants from types.ts', () => {
  it('defaults the full-text page budget to 3', () => {
    expect(DEFAULT_FT_PAGES).toBe(3)
  })

  it('pins the OAuth redirect', () => {
    expect(OAUTH_REDIRECT).toBe('http://localhost:8080/')
  })

  it('pins the project URL', () => {
    expect(PROJECT_URL).toBe('https://github.com/shenyunhang/Mendeley-NG')
  })

  it('pins the default PDF name template', () => {
    expect(DEFAULT_PDF_TEMPLATE).toBe('{authors} - {year} - {title}')
  })
})
