import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  progressAllowed,
  sameIndexedFile,
  snippetAround,
  type IndexedFileStamp
} from '../shared/indexedFileRules'

/**
 * HANDOFF 4 "测试纪律": before a shared rule replaces an inline one, copy
 * the old expression here verbatim and compare the two value by value. The
 * two PDF indexes wrote three of these rules each, with different constants
 * but the same intent, so each old copy is kept as a control.
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

/** The full-text index, verbatim before the extraction. `body` was the corpus. */
const legacyFullTextSnippet = (body: string, off: number, len: number): string => {
  const from = Math.max(0, off - 60)
  const to = Math.min(body.length, off + len + 140)
  return (
    (from > 0 ? '…' : '') +
    body.slice(from, to).replace(/\s+/g, ' ').trim() +
    (to < body.length ? '…' : '')
  )
}

/** The references index, verbatim before the extraction. */
const legacyRefsSnippet = (text: string, at: number, len: number): string => {
  const from = Math.max(0, at - 80)
  const to = Math.min(text.length, at + len + 80)
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim()
  return (from > 0 ? '…' : '') + body + (to < text.length ? '…' : '')
}

const corpus = [
  '',
  'Deep Learning',
  'a  b\t c\n\nd',
  '中文 检索 与 İ 转码',
  'x'.repeat(400),
  '  leading and trailing   ',
  'one two three four five six seven eight nine ten'.repeat(12)
]

describe('snippetAround agrees with both old implementations', () => {
  it('matches the full-text version over a large input batch', () => {
    for (const text of corpus) {
      for (let off = 0; off <= text.length; off += 7) {
        for (const len of [0, 1, 2, 5, 40, 200]) {
          expect(snippetAround(text, off, len, 60, 140), `${text.length}/${off}/${len}`).toBe(
            legacyFullTextSnippet(text, off, len)
          )
        }
      }
    }
  })

  it('matches the references version over a large input batch', () => {
    for (const text of corpus) {
      for (let off = 0; off <= text.length; off += 7) {
        for (const len of [0, 1, 2, 5, 40, 200]) {
          expect(snippetAround(text, off, len, 80, 80), `${text.length}/${off}/${len}`).toBe(
            legacyRefsSnippet(text, off, len)
          )
        }
      }
    }
  })

  it('keeps the two windows different, and folds whitespace only after slicing', () => {
    const text = 'A'.repeat(200) + 'deep learning' + 'B'.repeat(200)
    const full = snippetAround(text, 200, 13, 60, 140)
    const refs = snippetAround(text, 200, 13, 80, 80)
    expect(full).not.toBe(refs)
    expect(full).toContain('deep learning')
    expect(full.startsWith('…')).toBe(true)
    expect(full.endsWith('…')).toBe(true)
    expect(snippetAround('a  b\tc', 0, 7, 0, 0)).toBe('a b c')
  })
})

/** The rebuild path and the references cache: moment plus size only. */
const legacyBuildSame = (prev: IndexedFileStamp | null, mtime: number, size: number): boolean =>
  !!prev && prev.mtime === mtime && prev.size === size

/** The append path also demanded the path, because offsets describe a file. */
const legacyAppendSame = (
  prev: IndexedFileStamp | null,
  mtime: number,
  size: number,
  file: string
): boolean =>
  !!prev && prev.file === file && prev.mtime === mtime && prev.size === size

describe('sameIndexedFile agrees with all three old checks', () => {
  const stamps: (IndexedFileStamp | null)[] = [
    null,
    { mtime: 100, size: 20 },
    { mtime: 100, size: 20, file: 'a.pdf' },
    { mtime: 101, size: 20, file: 'a.pdf' },
    { mtime: 100, size: 21, file: 'a.pdf' },
    { mtime: 100, size: 20, file: 'b.pdf' },
    { mtime: 0, size: 0 },
    { mtime: NaN, size: NaN }
  ]
  const numbers = [0, 1, 20, 21, 99, 100, 101, 1e12, NaN]

  it('matches the loose rule for every stamp and number pair', () => {
    for (const prev of stamps) {
      for (const mtime of numbers) {
        for (const size of numbers) {
          expect(sameIndexedFile(prev, mtime, size), `${JSON.stringify(prev)}/${mtime}/${size}`).toBe(
            legacyBuildSame(prev, mtime, size)
          )
        }
      }
    }
  })

  it('matches the strict rule and proves the path check is real', () => {
    for (const prev of stamps) {
      for (const mtime of numbers) {
        for (const size of numbers) {
          for (const file of ['a.pdf', 'b.pdf', '']) {
            expect(
              sameIndexedFile(prev, mtime, size, file),
              `${JSON.stringify(prev)}/${mtime}/${size}/${file}`
            ).toBe(legacyAppendSame(prev, mtime, size, file))
          }
        }
      }
    }
    expect(sameIndexedFile({ mtime: 100, size: 20, file: 'a.pdf' }, 100, 20)).toBe(true)
    expect(sameIndexedFile({ mtime: 100, size: 20, file: 'a.pdf' }, 100, 20, 'a.pdf')).toBe(true)
    expect(sameIndexedFile({ mtime: 100, size: 20, file: 'a.pdf' }, 100, 20, 'b.pdf')).toBe(false)
    // An entry written before `file` existed cannot satisfy the strict rule.
    expect(sameIndexedFile({ mtime: 100, size: 20 }, 100, 20, 'a.pdf')).toBe(false)
  })
})

/** The references index before the extraction. */
const legacyRefsProgress = (lastPing: number, now: number, force: boolean): boolean =>
  force || now - lastPing >= 200

/** The full-text index before the extraction. */
const legacyFullTextProgress = (lastPing: number, now: number): boolean => now - lastPing >= 300

describe('progressAllowed agrees with both old throttles', () => {
  const times = [0, 1, 199, 200, 201, 299, 300, 301, 1000, 10000]
  it('matches the references rule, including the forced final message', () => {
    for (const last of times) {
      for (const now of times) {
        for (const force of [false, true]) {
          expect(progressAllowed(last, now, 200, force), `${last}/${now}/${force}`).toBe(
            legacyRefsProgress(last, now, force)
          )
        }
      }
    }
  })
  it('matches the full-text rule', () => {
    for (const last of times) {
      for (const now of times) {
        expect(progressAllowed(last, now, 300), `${last}/${now}`).toBe(
          legacyFullTextProgress(last, now)
        )
      }
    }
  })
})

describe('the two indexes no longer keep a private copy', () => {
  const oldFullText = 'body.slice(from, to).replace(/\\s+/g, \' \').trim()'
  const oldRefs = 'text.slice(from, to).replace(/\\s+/g, \' \').trim()'
  const oldStamp = 'prev.mtime === Math.floor(st.mtimeMs)'

  it('the detector can see the old shape', () => {
    // A guard that cannot find the old code proves nothing.
    expect('const body = ' + oldFullText).toContain(oldFullText)
    expect('return ' + oldRefs).toContain(oldRefs)
    expect('if (prev && ' + oldStamp + ')').toContain(oldStamp)
  })

  it('both indexes now call the shared rules', () => {
    const full = read('electron/main/fulltext.ts')
    const refs = read('electron/main/refsindex.ts')
    for (const src of [full, refs]) {
      expect(src).not.toContain(oldFullText)
      expect(src).not.toContain(oldRefs)
      expect(src).not.toContain(oldStamp)
      expect(src).toContain('snippetAround(')
      expect(src).toContain('sameIndexedFile(')
      expect(src).toContain('progressAllowed(')
    }
  })
})
