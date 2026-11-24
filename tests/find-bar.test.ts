import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Wiring guards for the find bar.  The behaviour it protects is geometric
 * (the bar must not overlap the page) and is measured in smoke.ts by the two
 * rectangles; this file only keeps the markup, the stylesheet and that
 * assertion from drifting apart.
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

describe('the find bar has a row of its own', () => {
  it('sits above .pdf-body in the JSX, not inside it', () => {
    const viewer = read('src/components/PdfViewer.tsx')
    expect(viewer.indexOf('className="pdf-find"')).toBeLessThan(
      viewer.indexOf('className="pdf-body"')
    )
  })

  it('the stylesheet gives it a row, not a floating box', () => {
    const css = read('src/styles/pdf.css')
    const block = css.slice(css.indexOf('.pdf-find {'), css.indexOf('.pdf-find input'))
    expect(block).toContain('flex: 0 0 auto')
    expect(block).toContain('border-bottom: 1px solid var(--border)')
    expect(block).toContain('background: var(--panel-head)')
    expect(block).not.toContain('position: absolute')
    expect(block).not.toContain('z-index')
  })

  it('smoke still measures the two rectangles, with the same strictness', () => {
    const smoke = read('electron/main/smoke.ts')
    expect(smoke).toContain('overlap:a.bottom>b.top+1&&a.top<b.bottom-1')
    expect(smoke).toContain('findBox.overlap === false')
    expect(smoke).not.toContain('floats over the top right of the page')
  })
})
