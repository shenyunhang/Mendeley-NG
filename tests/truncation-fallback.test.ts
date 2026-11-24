import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Every ellipsis in the UI is a layout decision, not a decision about what the
 * reader may read.  These guards keep the full-string tooltip wired to each
 * clipped element; the behaviour of the one pure helper involved (turning
 * marked runs back into a sentence) is tested in search-match.test.ts.
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
/** Comments explain why a rule is absent; they must not satisfy a guard that
 *  is looking for the rule itself. */
const codeOnly = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('every clipped string still has a way to be read', () => {
  const sites: [string, string][] = [
    ['src/components/SearchResults.tsx', 'className="res-title" title={partsToPlainText(m.title)}'],
    ['src/components/SearchResults.tsx', 'partsToPlainText(m.authors)'],
    ['src/components/SearchResults.tsx', 'title={`${f.label} ${partsToPlainText(f.parts)}`}'],
    ['src/components/FullTextView.tsx', 'className="ft-snip" title={h.snippet}'],
    ['src/components/RefsView.tsx', 'className="ft-snip" title={h.snippet}'],
    ['src/components/FullTextView.tsx', 'title={status.skipped.map((s) => s.name).join'],
    ['src/components/NotesView.tsx', 'className="notes-text" title={label(a)}'],
    ['src/components/RowMenu.tsx', 'className="row-menu-head" title={head}'],
    ['src/components/AddByIdView.tsx', 'className="t" title={c.title}'],
    ['src/components/Settings.tsx', 'title={nameTemplate || DEFAULT_PDF_TEMPLATE}'],
    ['src/components/ColumnPicker.tsx', 'title={`${v.name} · ${v.cols.join'],
    ['src/components/PdfViewer.tsx', 'title={justMade ? \'已高亮\' : readerHint(marking'],
    ['src/components/FullTextView.tsx', 'title={`${s.name} · ${s.why}`}'],
    ['src/components/DetailsPanel.tsx', 'className="source-link"'],
    ['src/components/DetailsPanel.tsx', 'title={link.url}']
  ]

  for (const [file, needle] of sites) {
    it(`${file} keeps ${needle.slice(0, 40)}`, () => {
      expect(read(file), file).toContain(needle)
    })
  }

  it('the already-covered clipped rows keep their tooltips', () => {
    expect(read('src/components/DetailsPanel.tsx')).toContain('className="t" title={c.title}')
    expect(read('src/components/NotesView.tsx')).toContain('className="notes-doc" title=')
    expect(read('src/components/ColumnPicker.tsx')).toContain('className="name" title={v.name}')
    expect(read('src/components/FullTextView.tsx')).toContain('title={status?.current}')
  })
})

describe('long prose gets lines, and cards stop clipping silently', () => {
  it('titles and snippets are two-line clamps, not single clipped lines', () => {
    const results = codeOnly(read('src/styles/results.css'))
    const overlays = codeOnly(read('src/styles/overlays.css'))
    expect(results).toContain('-webkit-line-clamp: 2')
    expect(overlays).toContain('-webkit-line-clamp: 2')
    expect(results).not.toMatch(/\.res-title\s*\{[^}]*white-space:\s*nowrap/)
    // the two long prose blocks, not the short labels
    expect(overlays.match(/-webkit-line-clamp: 2/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('the result card no longer hides its last line without saying so', () => {
    const results = codeOnly(read('src/styles/results.css'))
    expect(results).not.toMatch(/\.res-row\s*\{[^}]*overflow:\s*hidden/)
    const base = read('src/styles/base.css')
    expect(base).toMatch(/--res-h:\s*6\.4rem/)
  })
})
