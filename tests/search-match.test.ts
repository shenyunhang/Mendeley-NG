import { describe, expect, it } from 'vitest'

import type { Doc } from '../shared/types'
import {
  allowNearFor,
  foldSeparators,
  fullTextQueryWords,
  matchQuery,
  matchWords,
  MAX_NEAR_WORDS,
  nearSpans,
  queryMatches,
  queryTokens,
  SHORT_WORD_LENGTH,
  spanBounds,
  tokensNear,
  wordBoundaryMatch,
  wordSpans
} from '../src/lib/searchMatch'
import { matchDoc, markAllTerms, partsToPlainText, snippetTerms } from '../src/lib/match'
import { normaliseQuery, scopeHay } from '../src/lib/searchScope'

/**
 * Approximate matching for bibliography fields. The driving case is a reader
 * typing "qwen cud" when the paper is called "Qwen-CUA": the hyphen breaks a
 * plain substring test and the last letter is a typo.
 */

const hayOf = (s: string) => normaliseQuery(s)
const qOf = (s: string) => normaliseQuery(s)

describe('foldSeparators and queryTokens', () => {
  it('treats punctuation and separators as spaces, keeping CJK characters', () => {
    expect(foldSeparators('Qwen-CUA: A_Framework')).toBe('qwen cua a framework')
    expect(foldSeparators('Deep  Learning')).toBe('deep learning')
    expect(foldSeparators('深度-学习')).toBe('深度 学习')
  })

  it('splits a query into words without empty tokens', () => {
    expect(queryTokens('  qwen   cud  ')).toEqual(['qwen', 'cud'])
    expect(queryTokens('...')).toEqual([])
  })
})

describe('fullTextQueryWords splits a query once for every pass', () => {
  it('keeps punctuation in a coverage word and folds it for the near pass', () => {
    expect(fullTextQueryWords('qwen3.5 te')).toEqual({
      coverageWords: ['qwen3.5', 'te'],
      nearWords: ['qwen3', '5', 'te']
    })
    expect(fullTextQueryWords('qwen3 te')).toEqual({
      coverageWords: ['qwen3', 'te'],
      nearWords: ['qwen3', 'te']
    })
    expect(fullTextQueryWords('qwen-cua agents').nearWords).toEqual(['qwen', 'cua', 'agents'])
  })
})

describe('wordBoundaryMatch keeps short tokens out of the middle of words', () => {
  it('a short word matches a word start but not a substring inside one', () => {
    expect(SHORT_WORD_LENGTH).toBe(3)
    const text = 'attention state later technical text te'
    const insideAttention = text.indexOf('te')
    expect(wordBoundaryMatch(text, insideAttention, 'te')).toBe(false)
    const startTechnical = text.indexOf('technical')
    expect(wordBoundaryMatch(text, startTechnical, 'te')).toBe(true)
    const alone = text.lastIndexOf('te')
    expect(wordBoundaryMatch(text, alone, 'te')).toBe(true)
  })

  it('a full-length word has to end where the corpus word ends', () => {
    expect(wordBoundaryMatch('qwen3.5-omni model', 0, 'qwen3.5')).toBe(true)
    expect(wordBoundaryMatch('qwen30 model', 0, 'qwen3')).toBe(false)
    expect(wordBoundaryMatch('a qwen3 model', 2, 'qwen3')).toBe(true)
    expect(wordBoundaryMatch('qwen3 深度', 0, 'qwen3')).toBe(true)
    expect(wordBoundaryMatch('qwen3深度', 0, 'qwen3')).toBe(false)
  })
})

describe('tokensNear', () => {
  it('accepts one substitution, insertion, deletion or transposition', () => {
    expect(tokensNear('cud', 'cua')).toBe(true)
    expect(tokensNear('cua', 'cau')).toBe(true)
    expect(tokensNear('qwen', 'qwens')).toBe(true)
    expect(tokensNear('qwens', 'qwen')).toBe(true)
    expect(tokensNear('qwen', 'qwen')).toBe(true)
  })

  it('rejects short words, larger edits and unrelated words', () => {
    expect(tokensNear('a', 'b')).toBe(false)
    expect(tokensNear('cat', 'dog')).toBe(false)
    expect(tokensNear('qwen', 'quenx')).toBe(false)
    expect(tokensNear('deep', 'learning')).toBe(false)
    expect(tokensNear('cu', 'cua')).toBe(false)
  })
})

describe('matchQuery', () => {
  const paper = hayOf('Qwen-CUA: A Framework for Computer Use Agents')

  it('finds Qwen-CUA from "qwen cud" and returns the real words for marking', () => {
    const hit = matchQuery(paper, qOf('qwen cud'))
    expect(hit?.kind).toBe('near')
    expect(hit?.terms).toEqual(['qwen', 'cua'])
  })

  it('bridges a hyphen when the query is spelled correctly', () => {
    const hit = matchQuery(paper, qOf('qwen cua'))
    expect(hit?.kind).toBe('near')
    expect(hit?.terms).toEqual(['qwen', 'cua'])
  })

  it('keeps an ordinary substring match exact', () => {
    expect(matchQuery(hayOf('deep learning'), qOf('deep'))).toEqual({
      kind: 'exact',
      terms: ['deep']
    })
  })

  it('matches a space-free script when the query adds a space', () => {
    expect(matchQuery(hayOf('深度学习'), qOf('深度 学习'))?.kind).toBe('near')
  })

  it('requires every query word and at least one exact word', () => {
    expect(matchQuery(paper, qOf('qwen zzzqqq'))).toBeNull()
    // every word is a near miss: nothing anchors the result to the paper
    expect(matchQuery(paper, qOf('xwen cud'))).toBeNull()
    expect(matchQuery(paper, qOf('zzzz'))).toBeNull()
    expect(matchQuery(paper, '')).toBeNull()
  })

  it('keeps the words together so a short typo cannot match a distant word', () => {
    expect(matchQuery(hayOf('Qwen-CUA agent'), qOf('qwen cud'))?.kind).toBe('near')
    // A three-letter typo is one edit away from many words in a long
    // abstract. Without the span check this returned unrelated Qwen reports.
    const distant = hayOf('Qwen agent ' + 'the model can act '.repeat(12) + 'cua')
    expect(matchQuery(distant, qOf('qwen cud'))).toBeNull()
  })

  it('uses a precomputed folded haystack without changing the answer', () => {
    const folded = foldSeparators(paper)
    expect(matchQuery(paper, qOf('qwen cud'), folded)).toEqual(
      matchQuery(paper, qOf('qwen cud'))
    )
  })

  it('works on a real scopeHay, not just a hand-made string', () => {
    const doc: Doc = { id: 'd1', title: 'Qwen-CUA: A Framework' }
    expect(matchQuery(scopeHay(doc, 'title'), qOf('qwen cud'))?.kind).toBe('near')
    expect(matchQuery(scopeHay(doc, 'abstract'), qOf('qwen cud'))).toBeNull()
  })

  it('finds the paper the reader was actually looking for', () => {
    const doc: Doc = {
      id: 'qwen-cua',
      title: 'Qwen-CUA: Native Computer Use for (almost) Everything'
    }
    const hay = scopeHay(doc, 'all')
    const q = qOf('qwen cud')
    // The detector has to see the old failure before the new answer means
    // anything: a plain substring search returns nothing for this title.
    expect(hay.includes(q)).toBe(false)
    const hit = matchQuery(hay, q)
    expect(hit?.kind).toBe('near')
    expect(hit?.terms).toContain('cua')
    expect(matchDoc(doc, q, undefined, hit?.terms).title.some((p) => p.hit)).toBe(true)
  })
})

describe('allowNearFor and queryMatches', () => {
  it('only opens near matching when nothing matched exactly', () => {
    const q = qOf('qwen cud')
    expect(allowNearFor([hayOf('qwen cud exact paper')], q)).toBe(false)
    expect(allowNearFor([hayOf('Qwen-CUA')], q)).toBe(true)
    expect(allowNearFor([], '')).toBe(false)
  })

  it('reproduces the list a reader sees for "qwen cud"', () => {
    const q = qOf('qwen cud')
    const rows = [
      { id: 'exact', hay: hayOf('qwen cud exact paper') },
      { id: 'near', hay: hayOf('Qwen-CUA: A Framework') }
    ]
    const withExact = rows.filter((r) => queryMatches(r.hay, q, allowNearFor(rows.map((r) => r.hay), q)))
    expect(withExact.map((r) => r.id)).toEqual(['exact'])

    const onlyNear = rows.slice(1)
    const fellBack = onlyNear.filter((r) => queryMatches(r.hay, q, allowNearFor(onlyNear.map((r) => r.hay), q)))
    expect(fellBack.map((r) => r.id)).toEqual(['near'])
  })

  it('never lets the near flag override an exact miss check', () => {
    expect(queryMatches(hayOf('nothing here'), qOf('qwen'), false)).toBe(false)
    expect(queryMatches(hayOf('nothing here'), qOf('qwen'), true)).toBe(false)
    expect(queryMatches(hayOf('qwen cud'), '', true)).toBe(true)
  })
})

describe('offset-preserving tokens for the two indexes', () => {
  it('keeps real code-unit offsets without rewriting the text', () => {
    const text = 'Qwen-CUA: 深度学习 2025'
    const spans = wordSpans(text)
    expect(spans.map((s) => s.word)).toEqual(['qwen', 'cua', '深度学习', '2025'])
    expect(spans[0]!.at).toBe(0)
    expect(spans[1]!.at).toBe(5) // the hyphen is still there in the source
    for (const s of spans) {
      expect(text.slice(s.at, s.at + s.len).toLowerCase()).toBe(s.word)
    }
  })

  it('finds qwen cud and returns spans that point at real words', () => {
    const text = 'Qwen-CUA: Native Computer Use Agents'
    const near = nearSpans(wordSpans(text), 'qwen cud')
    expect(near?.map((s) => s.word)).toEqual(['qwen', 'cua'])
    for (const s of near!) {
      expect(text.slice(s.at, s.at + s.len).toLowerCase()).toBe(s.word)
    }
  })

  it('spanBounds covers every hit word even when query order differs', () => {
    const text = 'alpha qwen cua omega'
    const near = nearSpans(wordSpans(text), 'cud qwen')!
    expect(near.map((s) => s.word)).toEqual(['cua', 'qwen'])
    const b = spanBounds(near)
    expect(text.slice(b.at, b.at + b.len)).toBe('qwen cua')
  })

  it('matchWords rejects a long phrase and a word salad', () => {
    const words = wordSpans('qwen cua native computer use').map((s) => s.word)
    expect(matchWords(words, ['xwen', 'cud'])).toBeNull()
    const long = Array.from({ length: MAX_NEAR_WORDS + 1 }, (_, i) => 'word' + i)
    expect(nearSpans(wordSpans('qwen cua'), long.join(' '))).toBeNull()
  })
})

describe('marking a near match', () => {
  it('marks every word that actually occurs, not the mistyped query', () => {
    const parts = markAllTerms('Qwen-CUA: A Framework', ['qwen', 'cua'])
    expect(parts.filter((p) => p.hit).map((p) => p.t).join('|')).toBe('Qwen|CUA')
  })

  it('merges overlapping words into one mark', () => {
    const parts = markAllTerms('deep learning', ['deep', 'deep learning'])
    expect(parts.filter((p) => p.hit).map((p) => p.t).join('|')).toBe('deep learning')
  })

  it('still maps a Unicode lower-case expansion back to the source offset', () => {
    // 'İ'.toLowerCase() is two code units; the mark must still cover the one
    // source character. This is the same offset rule markAll has always used.
    expect(markAllTerms('İstanbul', ['i'])).toEqual([
      { t: 'İ', hit: true },
      { t: 'stanbul', hit: false }
    ])
  })

  it('snippetTerms centers on the first of several words', () => {
    const parts = snippetTerms('A long sentence about Qwen-CUA agents', ['qwen', 'cua'], 4, 8)
    expect(parts).not.toBeNull()
    expect(parts!.some((p) => p.hit)).toBe(true)
  })

  it('matchDoc with terms marks the title and keeps the abstract as a field', () => {
    const d: Doc = {
      id: 'd1',
      title: 'Qwen-CUA: A Framework',
      abstract: 'We study Qwen-CUA agents.'
    }
    const m = matchDoc(d, 'qwen cud', undefined, ['qwen', 'cua'])
    expect(m.title.filter((p) => p.hit).map((p) => p.t).join('|')).toBe('Qwen|CUA')
    expect(m.fields.some((f) => f.label === '摘要')).toBe(true)
  })

  it('matchDoc without terms keeps the old single-word behaviour', () => {
    const d: Doc = { id: 'd1', title: 'Deep Learning' }
    const m = matchDoc(d, 'deep')
    expect(m.title.filter((p) => p.hit).map((p) => p.t)).toEqual(['Deep'])
  })

  it('partsToPlainText rebuilds the unmarked sentence behind a tooltip', () => {
    expect(partsToPlainText([])).toBe('')
    expect(partsToPlainText([{ t: 'Qwen', hit: true }, { t: '-CUA', hit: false }])).toBe(
      'Qwen-CUA'
    )
    const parts = snippetTerms('a very long abstract about Qwen', ['qwen'])
    expect(parts).not.toBeNull()
    expect(partsToPlainText(parts!)).toContain('Qwen')
  })
})
