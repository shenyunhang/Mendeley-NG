import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  clampFullTextPages,
  FULL_TEXT_MAX_PAGES,
  FULL_TEXT_MIN_PAGES
} from '../shared/fullTextPages'
import { clampToRange } from '../shared/clamp'
import { DEFAULT_FT_PAGES } from '../shared/types'
import { normaliseQuery } from '../src/lib/searchScope'
import { markAll, matchDoc, snippet } from '../src/lib/match'
import type { Doc } from '../shared/types'

/**
 * Regression cover for the 2026-11-16 optimisation pass.
 *
 * HANDOFF §4 "测试纪律" is explicit: before a shared rule replaces an inline
 * one, copy the old expression into a test and compare the two value by value
 * over a large batch of inputs, and separately prove that any intended
 * divergence is real. This file is that comparison for the page budget and
 * for the query normalisation, plus the source-string guards that keep the
 * removed attack surface and the deduplicated scripts from coming back.
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

describe('page budget: the shared clamp is the old expression', () => {
  /** Copied verbatim from shared/fullTextPages.ts before the change. */
  const legacy = (n: unknown): number => {
    const whole = Math.floor(Number(n)) || DEFAULT_FT_PAGES
    return Math.max(FULL_TEXT_MIN_PAGES, Math.min(FULL_TEXT_MAX_PAGES, whole))
  }

  const inputs: unknown[] = [
    undefined, null, NaN, Infinity, -Infinity, 0, -0, 1, 2, 3, 3.9, 50, 50.9,
    51, 100, -1, -100, 1e12, -1e12,
    '', '3', '50', '50.9', 'not a number', '  ', '0', '-7',
    true, false, {}, [], ['7'], () => 3
  ]
  for (let i = -60; i <= 120; i++) inputs.push(i, i + 0.25, i + 0.75)

  it('matches the old expression over the whole input batch', () => {
    for (const n of inputs) {
      expect(clampFullTextPages(n), `input=${String(n)}`).toBe(legacy(n))
    }
  })

  it('is exactly clampToRange applied after the floor/default', () => {
    for (const n of inputs) {
      const whole = Math.floor(Number(n)) || DEFAULT_FT_PAGES
      expect(clampFullTextPages(n), `input=${String(n)}`).toBe(
        clampToRange(whole, FULL_TEXT_MIN_PAGES, FULL_TEXT_MAX_PAGES)
      )
    }
  })

  it('keeps the boundary behaviour that the settings panel relies on', () => {
    expect(clampFullTextPages(0)).toBe(DEFAULT_FT_PAGES)
    expect(clampFullTextPages(NaN)).toBe(DEFAULT_FT_PAGES)
    expect(clampFullTextPages(Infinity)).toBe(FULL_TEXT_MAX_PAGES)
    expect(clampFullTextPages(-Infinity)).toBe(FULL_TEXT_MIN_PAGES)
    expect(clampFullTextPages(50.9)).toBe(50)
  })
})

describe('query normalisation: one rule, and the divergence is intentional', () => {
  /** The expression four components and SearchResults used to write inline. */
  const legacy = (s: string): string => s.trim().toLowerCase()

  it('agrees with the old rule on inputs without repeated or exotic whitespace', () => {
    const plain = [
      '', ' ', 'Deep Learning', '  Deep Learning  ', 'DEEP LEARNING',
      'object detection', '中文检索', 'a1 b2 c3', '10.1000/xyz',
      'arXiv:2401.00001', 'Alpha', '  mixed Case words  '
    ]
    for (const s of plain) {
      expect(normaliseQuery(s), `input=${JSON.stringify(s)}`).toBe(legacy(s))
    }
  })

  it('proves the old rule really did diverge on folded whitespace', () => {
    expect(legacy('deep  learning')).toBe('deep  learning')
    expect(normaliseQuery('deep  learning')).toBe('deep learning')
    expect(normaliseQuery('deep\tlearning')).toBe('deep learning')
    expect(normaliseQuery('deep\nlearning')).toBe('deep learning')
    expect(normaliseQuery('deep  learning')).not.toBe(legacy('deep  learning'))
  })

  it('marks a hit that the old query.trim() left unmarked', () => {
    const title = 'Deep Learning'
    const fixed = normaliseQuery('deep  learning')
    const old = 'deep  learning'.trim()
    // The defect, captured before the fix: the list matched but no card did.
    expect(markAll(title, old).some((p) => p.hit)).toBe(false)
    expect(markAll(title, fixed).some((p) => p.hit)).toBe(true)
    expect(snippet('We study Deep Learning here', fixed)).not.toBeNull()
    const doc: Doc = { id: 'd1', title, abstract: 'Deep Learning is here' }
    const m = matchDoc(doc, fixed)
    expect(m.title.some((p) => p.hit)).toBe(true)
    expect(m.fields.some((f) => f.label === '摘要')).toBe(true)
  })
})

describe('source-string guards for the optimisation pass', () => {
  it('does not register the unguarded pdf:read channel anywhere', () => {
    const files = [
      'electron/main/ipc/files.ts',
      'electron/preload/index.ts',
      'src/global.d.ts'
    ]
    for (const f of files) expect(read(f), f).not.toContain('pdf:read')
  })

  it('deleted the unused PDF_NAME_FIELDS constant', () => {
    expect(read('electron/main/pdfname.ts')).not.toContain('PDF_NAME_FIELDS')
  })

  it('the four search UIs and the result cards now use normaliseQuery', () => {
    const files = [
      'src/components/SearchResults.tsx',
      'src/components/TrashView.tsx',
      'src/components/NotesView.tsx',
      'src/components/FolderTree.tsx',
      'src/components/AddByIdView.tsx',
      'src/lib/hooks/usePdfFind.ts'
    ]
    for (const f of files) {
      const src = read(f)
      expect(src, f).toContain('normaliseQuery')
      expect(src, f).not.toContain('.trim().toLowerCase()')
    }
    expect(read('src/components/SearchResults.tsx')).not.toContain('query.trim()')
  })

  it('refs query and status rejections reach refsError', () => {
    const app = read('src/App.tsx')
    expect(app).toContain("setRefsError('参考文献查询失败：'")
    expect(app).toContain("setRefsError('参考文献索引状态读取失败：'")
  })

  it('the UA literal is one string across the TypeScript and script halves', () => {
    const literal = (src: string): string => {
      const m = src.match(
        /export const UA\s*=\s*\n?\s*'([^']*)'\s*\+\s*\n?\s*'([^']*)'/
      )
      if (!m) throw new Error('UA literal is missing or has an unexpected shape')
      return m[1]! + m[2]!
    }
    const ts = literal(read('shared/userAgent.ts'))
    const mjs = literal(read('scripts/_shared.mjs'))
    expect(ts).toContain('Chrome/124.0.0.0')
    expect(mjs).toBe(ts)
    expect(read('scripts/get-token.mjs')).not.toContain('Mozilla/5.0')
    expect(read('scripts/check-api.mjs')).not.toContain('Mozilla/5.0')
  })

  it('both workflows call the one artifact verifier', () => {
    for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const src = read(f)
      expect(src, f).toContain('node scripts/verify-build.mjs')
      // The 39-line inline artifact check used to be duplicated in both
      // workflows. release.yml still has a separate, tag-only `node -e` gate.
      expect(src, f).not.toContain('build artifact check FAILED')
    }
    expect(read('package.json')).toContain('"verify:build"')
  })

  it('the launchers and the tooling scripts share the helpers', () => {
    const users = [
      'scripts/start.mjs',
      'scripts/demo.mjs',
      'scripts/copy-worker.mjs',
      'scripts/make-icon.mjs',
      'scripts/get-token.mjs',
      'scripts/check-api.mjs',
      'scripts/signcheck.mjs'
    ]
    for (const f of users) expect(read(f), f).toContain("from './_shared.mjs'")
    expect(read('scripts/signcheck.mjs')).not.toContain("path.resolve('dist')")
  })
})
