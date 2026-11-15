import { describe, expect, it } from 'vitest'

import type { Doc } from '../shared/types'
import {
  SCOPE_LABEL,
  SEARCH_SCOPES,
  isMetadataScope,
  isSearchScope,
  normaliseQuery,
  scopeHay,
  type SearchScope
} from '../src/lib/searchScope'

/**
 * The old hay() lived inline in App.tsx. Copying it here is intentional: the
 * whole point of `all` is that narrowing to a scope must not change the
 * default answer by so much as a character.
 */
function oldHay(d: Doc, note?: string): string {
  return [
    d.title,
    d.source,
    d.citation_key,
    d.doi,
    d.abstract,
    d.type,
    (d.authors ?? []).map((a) => `${a.first_name ?? ''} ${a.last_name ?? ''}`).join(' '),
    (d.keywords ?? []).join(' '),
    (d.tags ?? []).join(' '),
    note ?? ''
  ]
    .join(' ')
    .toLowerCase()
}

const doc: Doc = {
  id: 'd1',
  title: 'Deep Learning for Cats',
  abstract: 'We study feline vision and contrastive learning.',
  source: 'Journal of Small Mammals',
  citation_key: 'smith2020cats',
  doi: '10.1000/cats',
  type: 'journal_article',
  authors: [{ first_name: 'Jane', last_name: 'Doe' }],
  keywords: ['vision', 'cats'],
  tags: ['to-read'],
  year: 2020
}

describe('the scope table', () => {
  it('names every scope and gives each one a label', () => {
    expect(SEARCH_SCOPES).toEqual([
      'all',
      'title',
      'abstract',
      'body',
      'references'
    ])
    for (const s of SEARCH_SCOPES) expect(SCOPE_LABEL[s]).toBeTruthy()
  })

  it('only accepts real scopes from untyped config', () => {
    for (const s of SEARCH_SCOPES) expect(isSearchScope(s)).toBe(true)
    for (const v of ['', 'TITLE', null, undefined, 3, {}, 'title ']) {
      expect(isSearchScope(v)).toBe(false)
    }
  })

  it('marks only the three haystack scopes as metadata', () => {
    expect(SEARCH_SCOPES.filter(isMetadataScope)).toEqual([
      'all',
      'title',
      'abstract'
    ])
  })

  it('normalises a query the way all four old call sites did', () => {
    expect(normaliseQuery('  Deep  Learning ')).toBe('deep  learning')
    expect(normaliseQuery('')).toBe('')
    expect(normaliseQuery('   ')).toBe('')
  })
})

describe('scopeHay', () => {
  it('all is byte-for-byte the old haystack', () => {
    const cases: Doc[] = [
      doc,
      { id: 'bare', title: 'Only a title' },
      { ...doc, authors: undefined, keywords: undefined, tags: undefined }
    ]
    for (const d of cases) {
      for (const note of [undefined, '', 'my note']) {
        expect(scopeHay(d, 'all', note), `${d.id}/${note}`).toBe(oldHay(d, note))
      }
    }
  })

  it('title sees the title and nothing else', () => {
    const h = scopeHay(doc, 'title')
    expect(h).toContain('deep learning for cats')
    expect(h).not.toContain('feline vision')
    expect(h).not.toContain('jane doe')
    expect(h).not.toContain('journal of small mammals')
    expect(h).not.toContain('to-read')
  })

  it('abstract sees the abstract and nothing else', () => {
    const h = scopeHay(doc, 'abstract')
    expect(h).toContain('feline vision')
    expect(h).not.toContain('deep learning for cats')
    expect(h).not.toContain('jane doe')
  })

  it('a missing field stays empty rather than becoming the word undefined', () => {
    expect(scopeHay({ id: 'x' } as Doc, 'title')).toBe('')
    expect(scopeHay({ id: 'x' } as Doc, 'abstract')).toBe('')
    expect(scopeHay({ id: 'x' } as Doc, 'all')).not.toContain('undefined')
  })

  it('body and references keep the full haystack so the table does not go blank', () => {
    for (const s of ['body', 'references'] as SearchScope[]) {
      expect(scopeHay(doc, s, 'note')).toBe(oldHay(doc, 'note'))
    }
  })

  it('a word living in one field is found only by a scope that reads it', () => {
    const inSource = normaliseQuery('JOURNAL')
    expect(scopeHay(doc, 'all').includes(inSource)).toBe(true)
    expect(scopeHay(doc, 'title').includes(inSource)).toBe(false)
    expect(scopeHay(doc, 'abstract').includes(inSource)).toBe(false)

    const inAbstract = normaliseQuery('FELINE')
    expect(scopeHay(doc, 'all').includes(inAbstract)).toBe(true)
    expect(scopeHay(doc, 'abstract').includes(inAbstract)).toBe(true)
    expect(scopeHay(doc, 'title').includes(inAbstract)).toBe(false)

    const inTitle = normaliseQuery('DEEP LEARNING')
    expect(scopeHay(doc, 'title').includes(inTitle)).toBe(true)
    expect(scopeHay(doc, 'abstract').includes(inTitle)).toBe(false)
  })
})
