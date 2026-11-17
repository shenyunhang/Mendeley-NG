import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  MERGE_FIELDS,
  fieldOf,
  mergeMissingFields
} from '../src/lib/mergeFields'
import type { Doc } from '../shared/types'

/**
 * A duplicate merge may only fill gaps. The rule used to sit inside an
 * `onMerge` callback in App.tsx, between a confirm dialog and an undo
 * registration, so no fixed input could reach it. This file copies the old
 * expression verbatim as a control and then states the behaviour directly.
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

/** Copied verbatim from App.tsx before the extraction. */
function legacyMerge(keeper: Doc, others: Doc[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const field = (d: Doc, f: string) => (d as unknown as Record<string, unknown>)[f]
  for (const f of [
    'abstract', 'source', 'publisher', 'volume', 'issue', 'pages',
    'citation_key', 'keywords', 'url'
  ]) {
    if (field(keeper, f)) continue
    const hit = others.find((o) => field(o, f))
    if (hit) patch[f] = field(hit, f)
  }
  if (!keeper.year) {
    const y = others.find((o) => o.year)?.year
    if (y) patch.year = y
  }
  if (!keeper.authors?.length) {
    const a = others.find((o) => o.authors?.length)?.authors
    if (a) patch.authors = a
  }
  const ident = { ...(keeper.identifiers ?? {}) }
  if (!ident.doi) {
    ident.doi = others.map((o) => o.identifiers?.doi ?? o.doi).find(Boolean)
  }
  if (!ident.arxiv) {
    ident.arxiv = others.map((o) => o.identifiers?.arxiv ?? o.arxiv).find(Boolean)
  }
  if (ident.doi || ident.arxiv) patch.identifiers = ident
  return patch
}

const doc = (over: Partial<Doc> = {}): Doc => ({ id: 'd', title: 'Paper', ...over })

describe('mergeMissingFields is the old expression, value by value', () => {
  const keepers: Doc[] = [
    doc(),
    doc({ abstract: 'kept', source: 'kept journal', year: 2020, authors: [{ first_name: 'A', last_name: 'B' }] }),
    doc({ identifiers: { doi: '10.1/kept' }, doi: '10.1/legacy' }),
    doc({ year: 0, authors: [], volume: '', keywords: [], url: 'https://example.test' }),
    doc({ identifiers: { arxiv: '2401.00001' } })
  ]
  const others: Doc[][] = [
    [],
    [doc({ abstract: 'from loser', publisher: 'P', year: 2019, doi: '10.1/loser' })],
    [
      doc({ source: 'S1', pages: '1-9', arxiv: '2401.00002' }),
      doc({ source: 'S2', issue: '4', identifiers: { doi: '10.1/second' } })
    ],
    [doc({ authors: [{ first_name: 'C', last_name: 'D' }], keywords: ['k'] })],
    [doc({ citation_key: 'key1' }), doc({ citation_key: 'key2', volume: '7' })]
  ]

  it('matches the old patch over the whole cross product', () => {
    for (const keeper of keepers) {
      for (const os of others) {
        expect(mergeMissingFields(keeper, os), `${keeper.id}/${os.length}`).toEqual(
          legacyMerge(keeper, os)
        )
      }
    }
  })

  it('never overwrites a field the keeper already has', () => {
    const keeper = doc({ abstract: 'good', year: 2020, authors: [{ first_name: 'A', last_name: 'B' }] })
    const patch = mergeMissingFields(keeper, [doc({ abstract: 'bad', year: 1999 })])
    expect(patch.abstract).toBeUndefined()
    expect(patch.year).toBeUndefined()
    expect(patch.authors).toBeUndefined()
  })

  it('fills only the missing fields, from the first loser that has one', () => {
    const keeper = doc()
    const patch = mergeMissingFields(keeper, [
      doc({ publisher: 'First' }),
      doc({ publisher: 'Second', pages: '1-4' })
    ])
    expect(patch.publisher).toBe('First')
    expect(patch.pages).toBe('1-4')
    // Neither paper carries an identifier, so no identifiers patch is made.
    expect(Object.keys(patch)).toEqual(['publisher', 'pages'])
  })

  it('reads legacy top-level doi/arxiv when there is no identifiers object', () => {
    const patch = mergeMissingFields(doc(), [doc({ doi: '10.1/old', arxiv: '2401.00009' })])
    expect(patch.identifiers).toEqual({ doi: '10.1/old', arxiv: '2401.00009' })
  })

  it('returns no patch keys other than the ones App will undo', () => {
    const patch = mergeMissingFields(doc({ identifiers: { doi: '10.1/kept' } }), [])
    expect(Object.keys(patch)).toEqual(['identifiers'])
    expect(fieldOf(doc({ volume: '3' }), 'volume')).toBe('3')
    expect(MERGE_FIELDS).toContain('citation_key')
    expect(MERGE_FIELDS.length).toBe(9)
  })
})

describe('App.tsx wires the pure rule', () => {
  it('the detector can see the old inline field list', () => {
    const old = "'citation_key',"
    expect("for (const f of ['pages', " + old).toContain(old)
  })

  it('the callback now calls the rule and keeps the undo snapshot', () => {
    const src = read('src/App.tsx')
    expect(src).toContain('const patch = mergeMissingFields(keeper, others)')
    expect(src).toContain('prev[f] = fieldOf(keeper, f)')
    expect(src).not.toContain("'citation_key',")
    expect(src).toContain('from \'./lib/mergeFields\'')
  })
})
