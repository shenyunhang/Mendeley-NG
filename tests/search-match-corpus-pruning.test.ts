/**
 * The corpus-word shortcut in `matchQuery` is a necessary-condition check,
 * not a heuristic. This file proves it by differential comparison: an exact
 * copy of the pre-change expression is run beside the current one over the
 * same large input set, with and without the shortcut, value by value.
 *
 * It also proves the detector can see a difference at all, and that the
 * shortcut does not suppress the word-level near match it is allowed to skip.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  compactForComparison,
  foldSeparators,
  matchQuery,
  matchWords,
  queryMatches,
  queryTokens,
  type QueryMatch
} from '../src/lib/searchMatch'
import { normaliseQuery } from '../src/lib/searchScope'

function rootUp(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}
const read = (p: string): string =>
  fs.readFileSync(path.join(rootUp(), p), 'utf-8').replace(/\r\n/g, '\n')

/** The expression before the shortcut was added, copied line for line. */
function legacyMatchQuery(hay: string, q: string, foldedHay?: string): QueryMatch | null {
  if (!q) return null
  if (hay.includes(q)) return { kind: 'exact', terms: [q] }

  const folded = foldedHay ?? foldSeparators(hay)
  const want = foldSeparators(q)
  if (!want) return null
  if (folded.includes(want)) return { kind: 'near', terms: queryTokens(q) }
  const compactOld = (s: string) => s.replace(/ /g, '')
  if (compactOld(folded).includes(compactOld(want))) {
    return { kind: 'near', terms: queryTokens(q) }
  }

  const wanted = queryTokens(q)
  const words = folded.split(' ').filter(Boolean)
  const positions = matchWords(words, wanted)
  if (!positions) return null
  return { kind: 'near', terms: [...new Set(positions.map((i) => words[i]!))] }
}

const HAYSTACKS = [
  'Attention Is All You Need 2017 Vaswani arXiv',
  'Qwen3.5 Technical Report qwen cua computer use agents',
  'A Survey of Computer-Use Agents and GUI Grounding',
  'Deep Residual Learning for Image Recognition 2016 He Zhang',
  'BERT Pre-training of Deep Bidirectional Transformers for Language Understanding',
  'qwen cud exact paper',
  'qwen cua exact paper',
  '中文文献 标题 摘要 神经网络 模型 训练',
  'Language Models are Few-Shot Learners',
  'Scaling Laws for Neural Language Models',
  'a b c d e f g h i j',
  'zzzz unrelated words sitting in an abstract',
  '',
  '   ',
  'One single word',
  'technical te attention transformer',
  'Qwen-CUA: Scaling Verifiable Training Environments and Tasks',
  'network network network'
]

const QUERIES = [
  'zzzzqqq', 'zzz', 'zz', 'z', 'q', 'a', 'e',
  'network', 'attention', 'attention is all', 'qwen cud', 'qwen cua',
  'qwen3.5 te', 'qwen3.5', 'qwen 3.5', 'qwen', 'cud', 'cua', 'te',
  'xwen cud', 'notpresent', 'nonsense words', 'deep residual',
  'transformer', 'bert', 'BERT', '中文', '神经网络 模型',
  '  qwen   cud  ', 'GUI Grounding', 'grounding gui', 'single',
  'technical', 'scaling laws', 'few shot learners', 'zzzzqqq extra',
  'qwen cud exact paper', 'image recognition he'
]

const foldedHaystacks = HAYSTACKS.map(foldSeparators)

/** The union of every word in the corpus, built the way App builds it. */
function buildCorpusWords(hays: string[]): Set<string> {
  const words = new Set<string>()
  for (const folded of hays) {
    for (const word of folded.split(' ')) if (word) words.add(word)
  }
  return words
}

const corpusWords = buildCorpusWords(foldedHaystacks)
const extendedCorpusWords = buildCorpusWords([...foldedHaystacks, 'completely separate vocabulary'])

const serialise = (value: QueryMatch | null): string => JSON.stringify(value)

/** True only when the shortcut is the reason a word-level walk is skipped. */
function shortcutApplies(hay: string, q: string): boolean {
  if (!q) return false
  if (hay.includes(q)) return false
  const folded = foldSeparators(hay)
  const want = foldSeparators(q)
  if (!want) return false
  if (folded.includes(want)) return false
  const compactOld = (s: string) => s.replace(/ /g, '')
  if (compactOld(folded).includes(compactOld(want))) return false
  return !queryTokens(q).some((word) => corpusWords.has(word))
}

describe('the corpus-word shortcut in matchQuery', () => {
  it('detects a real difference before being trusted', () => {
    // A deliberately wrong implementation must make the comparison fail.
    // Without this, "both returned null" would prove nothing.
    const wrong = (hay: string, q: string): QueryMatch | null => {
      const real = legacyMatchQuery(hay, q, foldSeparators(hay))
      return real && real.kind === 'near' ? { kind: 'near', terms: ['injected'] } : real
    }
    let caught = 0
    for (const hay of HAYSTACKS) {
      for (const raw of QUERIES) {
        const q = normaliseQuery(raw)
        if (serialise(wrong(hay, q)) !== serialise(matchQuery(hay, q, foldSeparators(hay)))) {
          caught++
        }
      }
    }
    expect(caught).toBeGreaterThan(0)
  })

  it('matches the old expression on every input without the shortcut', () => {
    for (const [index, hay] of HAYSTACKS.entries()) {
      const folded = foldedHaystacks[index]!
      for (const raw of QUERIES) {
        const q = normaliseQuery(raw)
        expect(serialise(matchQuery(hay, q, folded)))
          .toBe(serialise(legacyMatchQuery(hay, q, folded)))
        expect(serialise(matchQuery(hay, q)))
          .toBe(serialise(legacyMatchQuery(hay, q)))
      }
    }
  })

  it('matches the unshortened result on every input with both accelerators', () => {
    for (const [index, hay] of HAYSTACKS.entries()) {
      const folded = foldedHaystacks[index]!
      const compactFolded = compactForComparison(folded)
      for (const raw of QUERIES) {
        const q = normaliseQuery(raw)
        const withoutShortcut = matchQuery(hay, q, folded)
        expect(serialise(matchQuery(hay, q, folded, corpusWords)))
          .toBe(serialise(withoutShortcut))
        expect(serialise(matchQuery(hay, q, folded, extendedCorpusWords)))
          .toBe(serialise(withoutShortcut))
        expect(serialise(matchQuery(hay, q, folded, corpusWords, compactFolded)))
          .toBe(serialise(withoutShortcut))
        for (const allowNear of [true, false]) {
          expect(queryMatches(hay, q, allowNear, folded, corpusWords))
            .toBe(queryMatches(hay, q, allowNear, folded))
          expect(queryMatches(hay, q, allowNear, folded, corpusWords, compactFolded))
            .toBe(queryMatches(hay, q, allowNear, folded))
        }
      }
    }
  })

  it('produces the cached space-free form for every haystack', () => {
    const inPlace = (s: string) => s.replace(/ /g, '')
    for (const folded of foldedHaystacks) {
      expect(compactForComparison(folded)).toBe(inPlace(folded))
    }
  })

  it('actually exercises the shortcut, and only where it is sound', () => {
    let exercised = 0
    for (const [index, hay] of HAYSTACKS.entries()) {
      const folded = foldedHaystacks[index]!
      for (const raw of QUERIES) {
        const q = normaliseQuery(raw)
        if (!shortcutApplies(hay, q)) continue
        exercised++
        // The expensive word-level pass cannot have succeeded here: not one
        // query word exists anywhere in the corpus, and matchWords requires
        // at least one exact word.
        expect(legacyMatchQuery(hay, q, folded)).toBe(null)
        expect(matchQuery(hay, q, folded, corpusWords)).toBe(null)
      }
    }
    expect(exercised).toBeGreaterThan(0)
  })

  it('does not suppress a word-level near match when a query word is in the corpus', () => {
    // "cud" is not in the hay, "cua" is, and "qwen" is the exact anchor that
    // matchWords requires. The shortcut must let this one through.
    const hay = 'qwen cua exact paper'
    const q = normaliseQuery('qwen cud')
    const folded = foldSeparators(hay)
    expect(matchWords(folded.split(' ').filter(Boolean), queryTokens(q))).not.toBe(null)
    expect(matchQuery(hay, q, folded, corpusWords))
      .toEqual(matchQuery(hay, q, folded))
    expect(queryMatches(hay, q, true, folded, corpusWords)).toBe(true)
  })

  it('keeps the necessary condition the shortcut relies on', () => {
    const source = read('src/lib/searchMatch.ts')
    expect(source).toContain('if (exactWords === 0) return null')
    expect(source).toContain('if (corpusWords && !wanted.some(')
    expect(source).toContain('const compactFolded = compactFoldedHay ?? compactForComparison(folded)')
    const app = read('src/App.tsx')
    expect(app).toContain('const corpusWords = useMemo(')
    expect(app).toContain('const compactFoldedHay = useMemo(')
    expect(app).toContain('computeLibrarySearch({')
    expect(app).toContain('compactFoldedHay,')
    // The three inline call sites moved into the one place that walks the
    // library. Both accelerators now reach the predicate from there, so the
    // wiring to check is a single call rather than three copies of it.
    const search = read('src/lib/librarySearch.ts')
    const wiring = search.match(/compactFoldedHay\.get\(r\.doc\.id\)/g) ?? []
    expect(wiring.length).toBe(1)
    // The detector can still see the old inline predicate: it lives in the
    // verbatim legacy expression used for the differential test.
    expect((read('tests/library-search.test.ts').match(/queryMatches\(/g) ?? []).length)
      .toBeGreaterThan(0)
    expect((app.match(/queryMatches\(/g) ?? []).length).toBe(0)
  })
})
