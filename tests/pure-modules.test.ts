import { describe, expect, it } from 'vitest'

import type { Annotation, Doc, UpdateState } from '../shared/types'
import {
  humanBytes,
  toAnnotationsMarkdown,
  toBibtex,
  toEndnoteXml,
  toExitReadme,
  toNotesMarkdown,
  toRis,
  todayIso
} from '../src/lib/export'
import { parseBibtex, parseRis, safeType } from '../src/lib/importText'
import { DOC_TYPES, DOC_TYPE_LABELS } from '../src/lib/doctypes'
import { updateLine } from '../src/lib/updateText'

/**
 * Pure-Node coverage for four modules that carry real rules but were only
 * exercised by the real-window smoke suite (or, for updateText and doctypes,
 * by nothing at all). None of these imports React, Electron or a DOM.
 */

const doc: Doc = {
  id: 'd1',
  title: 'Deep {Learning} & \\TeX',
  type: 'journal',
  year: 2024,
  authors: [
    { first_name: 'Jane', last_name: 'Doe' },
    { first_name: 'Alan', last_name: 'Smith' }
  ],
  source: 'J. of Tests',
  citation_key: 'doe2024deep',
  doi: '10.1000/xyz',
  keywords: ['alpha', 'beta'],
  abstract: 'An abstract with <tags> & ampersands',
  pages: '1-10',
  volume: '7',
  issue: '2',
  publisher: 'Test Press',
  url: 'https://example.test/x'
}

describe('export.ts: bibliographies round-trip and escape their formats', () => {
  it('todayIso is injectable and UTC-stable', () => {
    expect(todayIso(new Date('2026-11-16T23:59:00Z'))).toBe('2026-11-16')
  })

  it('BibTeX escapes braces and backslashes, and parses back unchanged', () => {
    const bib = toBibtex([doc])
    expect(bib.startsWith('@article{doe2024deep,')).toBe(true)
    expect(bib).toContain('title     = {Deep \\{Learning\\} & \\\\TeX}')
    expect(bib).toContain('author    = {Jane Doe and Alan Smith}')
    expect(bib).toContain('doi       = {10.1000/xyz}')
    const back = parseBibtex(bib)
    expect(back).toHaveLength(1)
    expect(back[0]!.title).toBe('Deep {Learning} & \\TeX')
    expect(back[0]!.type).toBe('journal')
    expect(back[0]!.citation_key).toBe('doe2024deep')
  })

  it('a newline in a BibTeX value becomes a space, not a broken record', () => {
    const back = parseBibtex(toBibtex([{ ...doc, title: 'First\nSecond' }]))
    expect(back[0]!.title).toBe('First Second')
  })

  it('RIS is line oriented and parses back', () => {
    const ris = toRis([doc])
    expect(ris.startsWith('TY  - JOUR')).toBe(true)
    expect(ris).toContain('AU  - Doe, Jane')
    expect(ris.trimEnd().endsWith('ER  -')).toBe(true)
    for (const line of ris.split('\n')) expect(/^[A-Z][A-Z0-9]  - /.test(line)).toBe(true)
    const back = parseRis(toRis([{ ...doc, title: 'One\nTwo' }]))
    expect(back[0]!.title).toBe('One Two')
    expect(back[0]!.type).toBe('journal')
    expect(back[0]!.authors).toHaveLength(2)
    expect(back[0]!.year).toBe(2024)
  })

  it('EndNote XML escapes markup and always emits a ref-id', () => {
    const xml = toEndnoteXml([doc])
    expect(xml).toContain('<ref-type name="Journal Article">17</ref-type>')
    expect(xml).toContain('<title>Deep {Learning} &amp; \\TeX</title>')
    expect(xml).toContain('<abstract>An abstract with &lt;tags&gt; &amp; ampersands</abstract>')
    expect(xml).toContain('<electronic-resource-num>10.1000/xyz</electronic-resource-num>')
    expect(xml).toContain('<ref-id>doe2024deep</ref-id>')
    const noKey = toEndnoteXml([{ ...doc, citation_key: undefined }])
    expect(noKey).toMatch(/<ref-id>[^<]+<\/ref-id>/)
  })

  it('notes export keeps only papers that actually have a note', () => {
    const out = toNotesMarkdown([doc], { d1: '  my note  ' })
    expect(out).toContain('# 笔记导出')
    expect(out).toContain('1 条 · ')
    expect(out).toContain('## Deep {Learning} & \\TeX')
    expect(out).toContain('- DOI：10.1000/xyz')
    expect(out).toContain('my note')
    const empty = toNotesMarkdown([doc], { d1: '   ' })
    expect(empty).toContain('0 条 · ')
    expect(empty).not.toContain('## ')
  })

  it('annotations export orders by page and keeps orphans in their own section', () => {
    const anns: Annotation[] = [
      { id: 'a1', docId: 'd1', page: 2, type: 'highlight', color: 'yellow', rects: [], text: 'second page', created: '2026-01-02' },
      { id: 'a2', docId: 'd1', page: 1, type: 'highlight', color: 'yellow', rects: [], text: 'first page', created: '2026-01-01' },
      { id: 'a3', docId: 'gone', page: 3, type: 'note', color: 'blue', rects: [], text: 'orphan', note: 'orphan', created: '2026-01-03' }
    ]
    const out = toAnnotationsMarkdown([doc], anns, [doc])
    expect(out).toContain('3 条 · 2 篇 · ')
    expect(out).toContain('## Deep {Learning} & \\TeX')
    expect(out).toContain('## （已不在库中）')
    expect(out.indexOf('first page')).toBeLessThan(out.indexOf('second page'))
    // A cloud note carries the same sentence twice; it must be printed once.
    expect((out.match(/> orphan/g) ?? []).length).toBe(1)
    expect(out).toContain('> — p3 · 笔记')
  })

  it('the exit readme says out loud what has no import format', () => {
    const full = toExitReadme({ docs: 2, notes: 1, anns: 3, pdfs: 4 })
    expect(full).toContain('2 篇文献')
    expect(full).toContain('notes.md')
    expect(full).toContain('annotations.md')
    expect(full).toContain('pdf/')
    expect(full).toContain('两件没有导入格式的事')
    expect(full).toContain('这次导出没有改动库里的任何东西，也没有联网。')
    const lean = toExitReadme({ docs: 1, notes: 0, anns: 0, pdfs: 0 })
    expect(lean).not.toContain('notes.md')
    expect(lean).not.toContain('两件没有导入格式的事')
  })

  it('humanBytes never reports zero for a real file', () => {
    expect(humanBytes(0)).toBe('1 KB')
    expect(humanBytes(1500)).toBe('2 KB')
    expect(humanBytes(1e6)).toBe('1 MB')
    expect(humanBytes(1.5e9)).toBe('1.5 GB')
    expect(humanBytes(NaN)).toBe('0 KB')
    expect(humanBytes(Infinity)).toBe('0 KB')
  })
})

describe('importText.ts: parsing is a pure function of the text', () => {
  it('safeType only accepts the fixed Mendeley vocabulary', () => {
    expect(safeType('journal')).toBe('journal')
    expect(safeType('statute')).toBe('statute')
    expect(safeType('not-a-type')).toBe('generic')
    expect(safeType('')).toBe('generic')
  })

  it('BibTeX keeps commas inside nested braces and splits authors on "and"', () => {
    const entries = parseBibtex(`@article{key2020,
  title = {A {Nested} Title, With Comma},
  author = {Doe, Jane and Alan Smith},
  year = {2020},
  doi = {10.1000/abc},
  keywords = {vision, language}
}`)
    expect(entries).toHaveLength(1)
    const e = entries[0]!
    expect(e.type).toBe('journal')
    expect(e.citation_key).toBe('key2020')
    expect(e.title).toBe('A Nested Title, With Comma')
    expect(e.authors).toEqual([
      { last_name: 'Doe', first_name: 'Jane' },
      { last_name: 'Smith', first_name: 'Alan' }
    ])
    expect(e.year).toBe(2020)
    expect(e.doi).toBe('10.1000/abc')
    expect(e.keywords).toEqual(['vision', 'language'])
  })

  it('a literal backslash before a closing brace does not swallow the record', () => {
    const entries = parseBibtex('@misc{bad, title = {C:\\\\}, year = {2001}}')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.title).toBe('C:\\')
    expect(entries[0]!.year).toBe(2001)
  })

  it('RIS reads multiple records and maps their types', () => {
    const entries = parseRis(
      ['TY  - JOUR', 'TI  - One', 'AU  - Doe, Jane', 'PY  - 2019/05/01', 'ER  - ', '',
       'TY  - BOOK', 'TI  - Two', 'KW  - alpha', 'KW  - beta', 'ER  - '].join('\n')
    )
    expect(entries).toHaveLength(2)
    expect(entries[0]!.type).toBe('journal')
    expect(entries[0]!.title).toBe('One')
    expect(entries[0]!.year).toBe(2019)
    expect(entries[1]!.type).toBe('book')
    expect(entries[1]!.keywords).toEqual(['alpha', 'beta'])
  })

  it('an empty library exports and imports without inventing a record', () => {
    expect(toBibtex([])).toBe('')
    expect(toRis([])).toBe('')
    expect(parseBibtex('')).toEqual([])
    expect(parseRis('')).toEqual([])
  })
})

describe('doctypes.ts: the vocabulary and its labels cannot drift', () => {
  it('every type has exactly one label and vice versa', () => {
    expect(new Set(DOC_TYPES).size).toBe(DOC_TYPES.length)
    expect(Object.keys(DOC_TYPE_LABELS).sort()).toEqual([...DOC_TYPES].sort())
    expect(DOC_TYPES).toContain('generic')
    for (const t of DOC_TYPES) expect(DOC_TYPE_LABELS[t]).toBeTruthy()
  })
})

describe('updateText.ts: one wording for every updater phase', () => {
  const state = (phase: UpdateState['phase'], extra: Partial<UpdateState> = {}): UpdateState => ({
    phase,
    ...extra
  })

  it('says nothing when there is nothing to say', () => {
    expect(updateLine(null, '1.0.0')).toBeNull()
    expect(updateLine(undefined, '1.0.0')).toBeNull()
    expect(updateLine(state('idle'), '1.0.0')).toBeNull()
  })

  it('puts both version numbers side by side where the phase has one', () => {
    expect(updateLine(state('checking'), '1.0.0')).toBe('检查更新…（当前 1.0.0）')
    expect(updateLine(state('checking'), '')).toBe('检查更新…')
    expect(updateLine(state('available', { version: '2.0.0' }), '1.0.0')).toBe(
      '新版本 2.0.0（当前 1.0.0），开始下载'
    )
    expect(updateLine(state('not-available'), '1.0.0')).toBe('已是最新版本（当前 1.0.0）')
    expect(updateLine(state('downloading', { version: '2.0.0', percent: 42 }), '1.0.0')).toBe(
      '下载 2.0.0 42%'
    )
    expect(updateLine(state('downloaded', { version: '2.0.0' }), '1.0.0')).toBe(
      '2.0.0 已就绪（当前 1.0.0），重启安装'
    )
    expect(updateLine(state('error', { message: 'network down' }), '1.0.0')).toBe(
      '更新失败：network down'
    )
    expect(updateLine(state('unsupported', { message: 'portable build' }), '1.0.0')).toBe(
      'portable build'
    )
  })

  it('has a defined answer for all eight phases, including the degraded ones', () => {
    const phases: UpdateState['phase'][] = [
      'idle', 'checking', 'available', 'not-available',
      'downloading', 'downloaded', 'error', 'unsupported'
    ]
    for (const phase of phases) {
      const line = updateLine(state(phase), '')
      expect(line === null || typeof line === 'string', phase).toBe(true)
      if (phase !== 'idle') expect(line, phase).not.toBe('')
    }
  })
})
