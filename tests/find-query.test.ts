import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { MIN_FIND_QUERY_LENGTH, normaliseQuery } from '../src/lib/searchScope'

/**
 * Finding a word inside one PDF walks every page through pdf.js. Its word,
 * the key an answer is filed under, and the needle handed to findInPage must
 * be the same normalisation: a mismatch means an answer can never match the
 * word it belongs to. The key and the needle used to be two private copies
 * of `trim().toLowerCase()`, outside the source-string guard that covers the
 * search UIs.
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

/** Copied verbatim from usePdfFind.ts before the change. */
const legacyKey = (s: string): string => s.trim().toLowerCase()

describe('the find word is the one shared normalisation', () => {
  const plain = [
    '', ' ', 'Deep Learning', '  Deep Learning  ', 'DEEP LEARNING',
    '中文检索', 'a1 b2 c3', 'arXiv:2401.00001', 'Alpha',
    '  mixed Case words  ', 'Back propagation'
  ]

  it('agrees with the old key on ordinary input', () => {
    for (const s of plain) {
      expect(normaliseQuery(s), JSON.stringify(s)).toBe(legacyKey(s))
    }
  })

  it('proves the old key really diverged on folded whitespace', () => {
    expect(legacyKey('deep  learning')).toBe('deep  learning')
    expect(normaliseQuery('deep  learning')).toBe('deep learning')
    expect(normaliseQuery('deep\tlearning')).toBe('deep learning')
    expect(normaliseQuery('deep\nlearning')).toBe('deep learning')
  })

  it('folding the needle finds a hit the old needle missed', () => {
    // findInPage searches `hay.toLowerCase().indexOf(needle)`. Feeding the
    // folded needle is a real widening, not a cosmetic rewrite.
    const hay = 'We study Deep Learning here'
    const typed = 'DEEP  LEARNING'
    expect(hay.toLowerCase().indexOf(legacyKey(typed))).toBe(-1)
    expect(hay.toLowerCase().indexOf(normaliseQuery(typed))).toBeGreaterThanOrEqual(0)
    // rectsForRange uses needle.length for the marked range, which is still
    // exactly the length of the substring that was found.
    const needle = normaliseQuery(typed)
    const at = hay.toLowerCase().indexOf(needle)
    expect(hay.toLowerCase().slice(at, at + needle.length)).toBe(needle)
  })

  it('names the two-character floor instead of a literal', () => {
    expect(MIN_FIND_QUERY_LENGTH).toBe(2)
    expect(normaliseQuery('中').length).toBeLessThan(MIN_FIND_QUERY_LENGTH)
    expect(normaliseQuery('中文').length).toBeGreaterThanOrEqual(MIN_FIND_QUERY_LENGTH)
  })
})

describe('the hook no longer keeps a private normalisation', () => {
  const oldKey = '.trim().toLowerCase()'
  it('the detector can see the old shape', () => {
    expect('const key = findQ' + oldKey).toContain(oldKey)
  })

  it('key, needle and the length check all use the shared rule', () => {
    const src = read('src/lib/hooks/usePdfFind.ts')
    expect(src).not.toContain(oldKey)
    expect(src).toContain('const key = normaliseQuery(findQ)')
    expect(src).toContain('const needle = normaliseQuery(q)')
    expect(src).toContain('const q = normaliseQuery(raw)')
    expect(src).toContain('q.length < MIN_FIND_QUERY_LENGTH')
    expect(src).toContain('needle.length < MIN_FIND_QUERY_LENGTH')
    // Smoke (164) asserts that the named delay replaced the old literal:
    // the constant must be wired and the bare 250 must be gone.
    expect(src).toContain('FIND_QUERY_DEBOUNCE_MS')
    expect(src).not.toContain('runFind(findQ), 250)')
    // The box still shows the word the reader searched for.
    expect(src).toContain('setFindQ(raw)')
  })

  it('the references index keeps its own one-character floor on purpose', () => {
    expect(read('electron/main/refsindex.ts')).toContain('const MIN_QUERY = 1')
  })
})
