import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The polish pass is deliberately token-driven: one radius scale, one soft
 * selection wash, one focus ring and one floating-panel shadow, defined for
 * both palettes.  These guards stop a future edit from reintroducing the
 * saturated blue selection or a hard-coded shadow in one theme only.
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
const read = (p: string): string =>
  fs.readFileSync(path.join(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')

const dark = () => {
  const css = read('src/styles/base.css')
  return css.slice(0, css.indexOf(":root[data-theme='light']"))
}
const light = () => {
  const css = read('src/styles/base.css')
  return css.slice(css.indexOf(":root[data-theme='light']"))
}

describe('both palettes carry the same polish tokens', () => {
  for (const token of ['--radius', '--radius-sm', '--accent-soft', '--accent-ring', '--shadow-pop', '--t']) {
    it(`${token} is defined in :root`, () => expect(dark()).toContain(`${token}:`))
  }

  for (const token of ['--accent-soft', '--accent-ring', '--shadow-pop']) {
    it(`${token} is redefined for the light theme`, () => expect(light()).toContain(`${token}:`))
  }

  it('the OS title bar colours stay mirrored with shared/titleBarTheme.ts', () => {
    expect(dark()).toContain('--bg-2: #212121;')
    expect(dark()).toContain('--fg: #e8e8e8;')
    expect(light()).toContain('--bg-2: #ffffff;')
    expect(light()).toContain('--fg: #1c1e21;')
  })

  it('the two palettes are genuinely different', () => {
    expect(dark()).toContain('--row-line: #2c2f35;')
    expect(light()).toContain('--row-line: #e6e9ef;')
  })
})

describe('selection stays a soft wash with an edge, not a filled blue row', () => {
  const selected: [string, string][] = [
    ['src/styles/overlays.css', '.row.sel'],
    ['src/styles/results.css', '.res-row.sel'],
    ['src/styles/tree.css', '.folder-row.sel']
  ]
  for (const [file, selector] of selected) {
    it(`${selector} uses the soft token`, () => {
      const css = read(file)
      const block = css.slice(css.indexOf(selector))
      expect(block.slice(0, block.indexOf('}'))).toContain('var(--accent-soft)')
      expect(block.slice(0, block.indexOf('}'))).toContain('inset 2px 0 0 var(--accent)')
    })
  }

  it('the active paper tab uses a top edge', () => {
    const css = read('src/styles/panes.css')
    expect(css).toContain('inset 0 2px 0 var(--accent)')
  })

  it('the primary command is emphasised with colour, not a size of its own', () => {
    const css = read('src/styles/layout.css')
    const block = css.slice(css.indexOf('.toolbar > .reading-button'))
    const rule = block.slice(0, block.indexOf('}'))
    expect(rule).toContain('var(--accent-soft)')
    // the smoke test measures this button; it must use the shared button
    // geometry so the font-size knob moves it with the rest of the bar
    expect(rule).not.toMatch(/font-size|font-weight|padding|min-width|height|width/)
  })
})

describe('the second pass keeps the same visual language', () => {
  it('column headers separate themselves from the data', () => {
    const table = read('src/components/DocTable.tsx')
    expect(table).toContain("background: 'var(--panel-head)'")
    expect(table).toContain("boxShadow: sort.key === c.sort ? 'inset 0 -2px 0 var(--accent)'")
    expect(read('src/styles/table.css')).toContain('.col-head > div:hover')
  })

  it('labels and pane headers gain hierarchy without new colours', () => {
    const details = read('src/styles/details.css')
    expect(details.slice(details.indexOf('.field label'), details.indexOf('.field input')))
      .toContain('letter-spacing: 0.02em')
    const panes = read('src/styles/panes.css')
    expect(panes.slice(panes.indexOf('.pane-head {')).slice(0, 260)).toContain('font-weight: 600')
    expect(panes).toContain('.pane-head button.primary')
    expect(panes).toContain('inset 0 -2px 0 var(--accent)')
  })

  it('full-pane empty states are cards and compact hints stay compact', () => {
    const results = read('src/styles/results.css')
    expect(results).toContain('.empty:not([style])')
    expect(results.slice(results.indexOf('.empty:not([style])')).slice(0, 180))
      .toContain('var(--radius)')
  })

  it('the update status line carries the same accent edge', () => {
    expect(read('src/styles/statusbar.css')).toContain('inset 2px 0 0 var(--accent)')
  })
})

describe('interaction details', () => {
  it('focus uses a ring and motion can be turned off', () => {
    const css = read('src/styles/base.css')
    expect(css).toContain('box-shadow: 0 0 0 2px var(--accent-ring)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('floating panels share one shadow', () => {
    for (const file of [
      'src/styles/layout.css',
      'src/styles/overlays.css',
      'src/styles/settings.css',
      'src/styles/first-run.css'
    ]) {
      expect(read(file), file).toContain('box-shadow: var(--shadow-pop)')
    }
  })
})
