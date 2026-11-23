import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { TITLE_BAR_HEIGHT, titleBarColorsFor } from '../shared/titleBarTheme'

/**
 * The window controls are OS chrome, so their colours cannot come from CSS
 * variables.  The main process and the stylesheet must still describe the
 * same two palettes, and every link in the chain -- hidden frame, Chinese
 * menu, theme repaint, drag strip -- has to stay wired.
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
/** Git on Windows checks text files out with CRLF.  A source-string guard
 *  that assumes LF only fails on CI, where the same bytes are correct. */
const read = (p: string): string =>
  fs.readFileSync(path.join(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')

describe('title bar colours', () => {
  it('dark is the default and light is the only alternative', () => {
    expect(titleBarColorsFor()).toEqual({
      color: '#212121',
      symbolColor: '#e8e8e8',
      height: TITLE_BAR_HEIGHT
    })
    expect(titleBarColorsFor(undefined)).toEqual(titleBarColorsFor())
    expect(titleBarColorsFor('dark')).toEqual(titleBarColorsFor())
    expect(titleBarColorsFor('light')).toEqual({
      color: '#ffffff',
      symbolColor: '#1c1e21',
      height: TITLE_BAR_HEIGHT
    })
    expect(TITLE_BAR_HEIGHT).toBe(34)
  })

  it('the shared colours are exactly the CSS --bg-2 and --fg values', () => {
    const css = read('src/styles/base.css')
    const bg2 = [...css.matchAll(/--bg-2:\s*(#[0-9a-fA-F]{6});/g)].map((m) => m[1])
    const fg = [...css.matchAll(/--fg:\s*(#[0-9a-fA-F]{6});/g)].map((m) => m[1])
    expect(bg2).toEqual([titleBarColorsFor().color, titleBarColorsFor('light').color])
    expect(fg).toEqual([titleBarColorsFor().symbolColor, titleBarColorsFor('light').symbolColor])
  })
})

describe('source-string guards survive a Windows checkout', () => {
  it('no guard matches a literal LF inside a toContain string', () => {
    // GitHub's windows-latest runner checks out CRLF.  One guard that looked
    // for '.title-bar {\n  display: none;' passed locally and failed every
    // CI run for five commits.  Normalising in read() fixes this file; the
    // guard below stops the same assumption appearing in any other one.
    const offenders: string[] = []
    for (const name of fs.readdirSync(path.join(ROOT, 'tests'))) {
      if (!name.endsWith('.test.ts')) continue
      const src = fs.readFileSync(path.join(ROOT, 'tests', name), 'utf-8')
      src.split(/\r?\n/).forEach((line, i) => {
        for (const match of line.matchAll(/toContain\(([^)]*)\)/g)) {
          const arg = match[1]
          if (!arg.includes('\\n')) continue
          // a bare newline literal is fine: CRLF still contains \n
          if (/^\s*['"]\\n['"]\s*$/.test(arg)) continue
          offenders.push(`${name}:${i + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('the custom chrome stays wired end to end', () => {
  it('the Windows frame is hidden and the overlay uses the shared colours', () => {
    const src = read('electron/main/window.ts')
    expect(src).toContain("process.platform === 'win32'")
    expect(src).toContain("titleBarStyle: 'hidden'")
    expect(src).toContain('titleBarColorsFor')
    expect(src).toContain('autoHideMenuBar: true')
    expect(src).toContain('w.setTitleBarOverlay(')
    expect(src).toContain('w.setBackgroundColor(')
  })

  it('a theme write repaints the OS controls too', () => {
    const src = read('electron/main/ipc/library.ts')
    expect(src).toContain('applyTitleBarOverlay')
    expect(src).toContain('if (patch.theme) applyTitleBarOverlay(patch.theme)')
  })

  it('the default English menu is replaced by a hidden Chinese role menu', () => {
    expect(read('electron/main/index.ts')).toContain('installAppMenu()')
    const menu = read('electron/main/menu.ts')
    expect(menu).toContain('Menu.setApplicationMenu')
    expect(menu).toContain("role: 'toggleDevTools'")
    expect(menu).toContain("role: 'copy'")
    expect(menu).not.toContain("label: 'File'")
  })

  it('the strip is rendered only where the frame is hidden', () => {
    expect(read('src/App.tsx')).toContain('<TitleBar />')
    const preload = read('electron/preload/index.ts')
    expect(preload).toContain("process.platform === 'win32'")
    expect(preload).toContain("'custom-title-bar'")
    const css = read('src/styles/titlebar.css')
    expect(css).toMatch(/\.title-bar\s*\{\s*display:\s*none/)
    expect(css).toContain('html.custom-title-bar .title-bar')
    expect(css).toContain('-webkit-app-region: drag')
    expect(css).toContain('flex: 0 0 138px')
    expect(read('src/styles.css')).toContain("@import './styles/titlebar.css';")
  })
})
