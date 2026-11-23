import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Wiring guards for the status row.  The rule itself (which update phases
 * retire on their own) has behaviour tests in pure-modules.test.ts; these
 * assertions only keep the row and the removal of the old ellipsis from
 * drifting apart.
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

describe('status prose has a row of its own', () => {
  it('the app renders the row and retires only the idle answer', () => {
    const app = read('src/App.tsx')
    expect(app).toContain('<StatusBar upd={upd} status={status} />')
    expect(app).toContain('updateIdleDelayMs(s.phase)')
    expect(app).toContain('window.clearTimeout(updateIdleTimer.current)')
  })

  it('the toolbar no longer carries either status span', () => {
    const toolbar = read('src/components/Toolbar.tsx')
    expect(toolbar).not.toContain('className="status"')
    expect(toolbar).not.toContain('status: SyncStatus')
    expect(toolbar).not.toContain('updateLine')
  })

  it('no rule can put the ellipsis back', () => {
    const css = read('src/styles/statusbar.css')
    expect(css).toContain('overflow-wrap: anywhere')
    expect(css).not.toContain('text-overflow')
    expect(css).not.toMatch(/white-space:\s*nowrap/)
    expect(read('src/styles/settings.css')).not.toContain('max-width: 44%')
    expect(read('src/styles/layout.css')).not.toContain('.toolbar > .status')
    expect(read('src/styles.css')).toContain("@import './styles/statusbar.css';")
  })

  it('the real-window smoke suite looks for the new row', () => {
    const smoke = read('electron/main/smoke.ts')
    expect(smoke).toContain('querySelectorAll(".status-line")')
    expect(smoke).not.toContain('querySelector(".toolbar .status")')
  })
})
