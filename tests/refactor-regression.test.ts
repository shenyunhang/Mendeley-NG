import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { collectFileDocumentIds, type FilePageRow } from '../shared/filePages'
import {
  pdfCandidates,
  uniquePdfPath,
  writeUniquePdf
} from '../shared/uniquePdfPath'

/**
 * Regression cover for the shared-rule refactor.
 *
 * The rule in HANDOFF is explicit: before a shared rule replaces an inline
 * one, copy the old expression verbatim into a test and compare the two value
 * by value over a large batch of inputs. The walk in filePages.ts used to be
 * its own loop; it now delegates to paged.ts. This is that comparison.
 */

type FetchPage = (marker?: string) => Promise<FilePageRow[] | null | undefined>

/** The old loop, copied line for line from filePages.ts before the change. */
async function legacyCollectFileDocumentIds(
  fetchPage: FetchPage,
  limit = 200,
  maxPages = 200
): Promise<Set<string>> {
  const ids = new Set<string>()
  const seenFiles = new Set<string>()
  let marker: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchPage(marker)
    if (!rows || rows.length === 0) break
    let fresh = 0
    for (const row of rows) {
      if (row.id && !seenFiles.has(row.id)) {
        seenFiles.add(row.id)
        fresh++
      }
      if (row.document_id) ids.add(row.document_id)
    }
    if (fresh === 0) break
    if (rows.length < limit) break
    const next = rows[rows.length - 1]?.id
    if (!next || next === marker) break
    marker = next
  }
  return ids
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A page source with the awkward shapes the live API produced: repeated file
 *  ids, rows without ids, short pages, empty pages and a stuck marker. */
function generatedPages(rand: () => number): {
  pages: (FilePageRow[] | null)[]
  limit: number
} {
  const limit = 2 + Math.floor(rand() * 4)
  const count = 1 + Math.floor(rand() * 8)
  const pages: (FilePageRow[] | null)[] = []
  for (let p = 0; p < count; p++) {
    const roll = rand()
    if (roll < 0.08) {
      pages.push(null)
      continue
    }
    const size = Math.floor(rand() * (limit + 2))
    const rows: FilePageRow[] = []
    for (let i = 0; i < size; i++) {
      const r = rand()
      const fileId = r < 0.12 ? undefined : `f${p}-${i % 3}`
      const docId = r > 0.9 ? undefined : `d${p}-${i}`
      rows.push({ id: fileId, document_id: docId })
    }
    pages.push(rows)
  }
  return { pages, limit }
}

function pageFetcher(pages: (FilePageRow[] | null)[]) {
  const calls: (string | undefined)[] = []
  const fetchPage: FetchPage = async (marker) => {
    calls.push(marker)
    return pages[calls.length - 1] ?? null
  }
  return { fetchPage, calls }
}

function sorted(ids: Set<string>): string[] {
  return [...ids].sort()
}

function sameResult(a: Set<string>, b: Set<string>): boolean {
  const x = sorted(a)
  const y = sorted(b)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

describe('shared marker walk', () => {
  it('the comparison can actually see a difference', async () => {
    const { fetchPage } = pageFetcher([
      [{ id: 'f1', document_id: 'd1' }]
    ])
    const whole = await collectFileDocumentIds(fetchPage, 200)
    const missing = new Set<string>()
    expect(sameResult(whole, missing)).toBe(false)
  })

  it('matches the old loop value by value over 400 generated page streams', async () => {
    const rand = mulberry32(20261109)
    for (let n = 0; n < 400; n++) {
      const { pages, limit } = generatedPages(rand)
      const a = pageFetcher(pages)
      const b = pageFetcher(pages)
      const [next, legacy] = await Promise.all([
        collectFileDocumentIds(a.fetchPage, limit, 12),
        legacyCollectFileDocumentIds(b.fetchPage, limit, 12)
      ])
      expect(sameResult(next, legacy), `case ${n} ids`).toBe(true)
      expect(a.calls.length, `case ${n} page count`).toBe(b.calls.length)
      expect(a.calls, `case ${n} markers`).toEqual(b.calls)
    }
  })
})

describe('atomic PDF name claim', () => {
  function withTmpDir<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendeley-ng-pdf-'))
    try {
      return fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('keeps the naming rule shared between the question and the write', () => {
    const names = [...pdfCandidates('/x', 'paper.pdf')]
    expect(names[0]).toBe(path.join('/x', 'paper.pdf'))
    expect(names[1]).toBe(path.join('/x', 'paper (2).pdf'))
    expect(names).toHaveLength(49)
    expect(uniquePdfPath('/x', 'paper.pdf', () => false)).toBe(names[0])
    expect(uniquePdfPath('/x', 'paper.pdf', () => true)).toBeNull()
  })

  it('never overwrites the first paper when two imports want the same name', () => {
    withTmpDir((dir) => {
      const first = writeUniquePdf(dir, 'paper.pdf', Buffer.from('first bytes'))
      const second = writeUniquePdf(dir, 'paper.pdf', Buffer.from('second bytes'))
      expect(first).toBe(path.join(dir, 'paper.pdf'))
      expect(second).toBe(path.join(dir, 'paper (2).pdf'))
      expect(fs.readFileSync(first!, 'utf-8')).toBe('first bytes')
      expect(fs.readFileSync(second!, 'utf-8')).toBe('second bytes')
    })
  })

  it('takes the next free name when a candidate was claimed out of band', () => {
    withTmpDir((dir) => {
      fs.writeFileSync(path.join(dir, 'paper.pdf'), 'somebody else')
      fs.writeFileSync(path.join(dir, 'paper (2).pdf'), 'also taken')
      const dest = writeUniquePdf(dir, 'paper.pdf', Buffer.from('mine'))
      expect(dest).toBe(path.join(dir, 'paper (3).pdf'))
      expect(fs.readFileSync(path.join(dir, 'paper.pdf'), 'utf-8')).toBe('somebody else')
    })
  })

  it('gives up rather than clobbering when all 49 candidates are taken', () => {
    withTmpDir((dir) => {
      for (const p of pdfCandidates(dir, 'paper.pdf')) {
        fs.writeFileSync(p, 'taken')
      }
      expect(writeUniquePdf(dir, 'paper.pdf', Buffer.from('mine'))).toBeNull()
      expect(fs.readFileSync(path.join(dir, 'paper (49).pdf'), 'utf-8')).toBe('taken')
    })
  })

  it('lets a real write error escape instead of hiding it as a collision', () => {
    const missing = path.join(os.tmpdir(), 'mendeley-ng-no-such-dir-' + Date.now())
    // ENOENT is not EEXIST, so it must reach the IPC handler's catch rather
    // than being retried 49 times and reported as "no free name".
    expect(() => writeUniquePdf(missing, 'paper.pdf', Buffer.from('mine'))).toThrow()
  })
})
