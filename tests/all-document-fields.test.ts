import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { allDocumentFields } from '../src/lib/allDocumentFields'
import type { Doc } from '../shared/types'

const paper = (patch: Record<string, unknown>): Doc => ({ id: 'paper-1', ...patch } as Doc)
const names = (d: Doc): string[] => allDocumentFields(d).map((f) => f.name)
const valueOf = (d: Doc, name: string): string | undefined =>
  allDocumentFields(d).find((f) => f.name === name)?.value

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
/** Source-string guards must survive a CRLF checkout on windows-latest. */
const read = (p: string): string =>
  fs.readFileSync(path.join(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')

describe('every cached field becomes a row', () => {
  it('keeps scalar fields in cache order, including booleans and numbers', () => {
    const d = paper({ title: 'A Paper', year: 2025, hidden: false, file_attached: true })
    expect(names(d)).toEqual(['id', 'title', 'year', 'hidden', 'file_attached'])
    expect(valueOf(d, 'year')).toBe('2025')
    expect(valueOf(d, 'hidden')).toBe('false')
    expect(valueOf(d, 'file_attached')).toBe('true')
  })

  it('expands identifiers into dotted names, including ones the type used to miss', () => {
    const d = paper({
      identifiers: {
        doi: '10.1000/a',
        arxiv: '2511.20347',
        pmid: '12345',
        isbn: '9781479951178',
        issn: '10636919',
        scopus: 'S1',
        sgr: 'G1',
        pui: 'P1'
      }
    })
    expect(names(d)).toEqual([
      'id',
      'identifiers.doi',
      'identifiers.arxiv',
      'identifiers.pmid',
      'identifiers.isbn',
      'identifiers.issn',
      'identifiers.scopus',
      'identifiers.sgr',
      'identifiers.pui'
    ])
    expect(valueOf(d, 'identifiers.scopus')).toBe('S1')
  })

  it('expands scalar arrays into indexed names and marks empty ones', () => {
    const d = paper({ websites: ['https://example.org/a', 'https://example.org/b'], tags: [] })
    expect(names(d)).toEqual(['id', 'websites[0]', 'websites[1]', 'tags'])
    expect(valueOf(d, 'websites[1]')).toBe('https://example.org/b')
    expect(valueOf(d, 'tags')).toBe('[]')
  })

  it('keeps arrays of people on one row but lists every member', () => {
    const d = paper({
      authors: [
        { first_name: 'Tiezheng', last_name: 'Ge' },
        { first_name: 'Kaiming', last_name: 'He' },
        { last_name: 'Anonymous' }
      ],
      editors: [{ first_name: 'Gang', last_name: 'Hua' }]
    })
    expect(names(d)).toEqual(['id', 'authors', 'editors'])
    expect(valueOf(d, 'authors')).toBe('Ge, Tiezheng; He, Kaiming; Anonymous')
    expect(valueOf(d, 'editors')).toBe('Hua, Gang')
  })

  it('marks missing, empty and object-shaped values instead of hiding them', () => {
    const d = paper({ abstract: '', year: null, identifiers: {}, medium: '\\url{x}' })
    expect(valueOf(d, 'abstract')).toBe('—')
    expect(valueOf(d, 'year')).toBe('—')
    expect(valueOf(d, 'identifiers')).toBe('{}')
    expect(valueOf(d, 'medium')).toBe('\\url{x}')
  })

  it('covers every field kind the real catalogue carries', () => {
    const d = paper({
      title: 't',
      type: 'journal',
      created: '2026-11-17T06:29:53.631Z',
      last_modified: '2026-11-17T06:29:58.458Z',
      file_attached: true,
      profile_id: 'profile-1',
      read: false,
      starred: false,
      authored: false,
      confirmed: true,
      hidden: false,
      private_publication: false,
      folder_uuids: ['folder-1'],
      year: 2025,
      source: 'arXiv',
      authors: [{ first_name: 'Chang', last_name: 'Gao' }],
      abstract: 'a',
      identifiers: { arxiv: '2511.20347', isbn: '2511.20347v2', pmid: '1', issn: '2', scopus: '3', sgr: '4', pui: '5' },
      websites: ['https://arxiv.org/pdf/2511.20347'],
      citation_key: 'Gao2025a',
      accessed: '2026-11-17',
      month: 11,
      day: 25,
      pages: '1-12',
      publisher: 'IEEE',
      keywords: ['cs.AI'],
      city: 'Columbus',
      volume: '381',
      issue: '23',
      genre: 'Computer Vision',
      source_type: 'article',
      institution: 'IEEE',
      series: 'Lecture Notes',
      editors: [{ first_name: 'Gang', last_name: 'Hua' }],
      notes: 'SI: Stereo Data',
      medium: '\\url{https://example.org}',
      localPdf: 'paper.pdf'
    })
    const got = new Set(names(d))
    const expected = [
      'id', 'title', 'type', 'created', 'last_modified', 'file_attached',
      'profile_id', 'read', 'starred', 'authored', 'confirmed', 'hidden',
      'private_publication', 'folder_uuids[0]', 'year', 'source', 'authors',
      'abstract', 'identifiers.arxiv', 'identifiers.isbn', 'identifiers.pmid',
      'identifiers.issn', 'identifiers.scopus', 'identifiers.sgr',
      'identifiers.pui', 'websites[0]', 'citation_key', 'accessed', 'month',
      'day', 'pages', 'publisher', 'keywords[0]', 'city', 'volume', 'issue',
      'genre', 'source_type', 'institution', 'series', 'editors', 'notes',
      'medium', 'localPdf'
    ]
    for (const name of expected) expect(got.has(name), name).toBe(true)
  })
})

describe('the details pane draws the full record', () => {
  const panel = () => read('src/components/DetailsPanel.tsx')

  it('uses the pure rule and marks the block read-only', () => {
    expect(panel()).toContain('allDocumentFields(doc)')
    expect(panel()).toContain('className="all-fields"')
    expect(panel()).toContain('className="all-fields-name" title={f.name}')
    expect(panel()).toContain('项 · 只读')
  })

  it('stays visible below the scrolling form and can be folded away', () => {
    expect(panel()).toContain('Outside `.details` on purpose')
    expect(panel()).toContain('setFieldsOpen((v) => !v)')
    expect(panel()).toContain('className="all-fields-toggle"')
    expect(read('src/styles/details.css')).toContain('flex: 0 0 auto')
  })

  it('keeps every row outside the editable form', () => {
    expect(panel()).toContain('It is not a `.field`')
    expect(read('src/styles/details.css')).toContain('.all-fields-row')
  })

  it('the type declares the fields that used to be invisible', () => {
    const types = read('shared/types.ts')
    expect(types).toContain('accessed?: string')
    expect(types).toContain('editors?: Author[]')
    expect(types).toContain('scopus?: string')
    expect(types).toContain('private_publication?: boolean')
  })

  it('the pure rule is listed in the node project whitelist', () => {
    expect(read('tsconfig.node.json')).toContain('src/lib/allDocumentFields.ts')
  })
})
