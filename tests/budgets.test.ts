import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  BATCH_PROGRESS_STEPS,
  DOWNLOAD_FLUSH_EVERY,
  DOWNLOAD_LANES
} from '../src/lib/budgets'

/**
 * Three bulk-work budgets used to be literals inside the loops they bounded.
 * Naming them is only safe if no number moved: every old expression is kept
 * here as a control and compared over a large batch of sizes.
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

describe('the named budgets are the old literals', () => {
  it('the values did not change', () => {
    expect(DOWNLOAD_LANES).toBe(3)
    expect(DOWNLOAD_FLUSH_EVERY).toBe(10)
    expect(BATCH_PROGRESS_STEPS).toBe(20)
  })

  it('lane count, flush points and progress steps match for every size', () => {
    for (let n = 0; n <= 500; n++) {
      expect(Math.min(DOWNLOAD_LANES, n), `lanes/${n}`).toBe(Math.min(3, n))
      expect(n % DOWNLOAD_FLUSH_EVERY === 0, `flush/${n}`).toBe(n % 10 === 0)
      expect(Math.max(1, Math.floor(n / BATCH_PROGRESS_STEPS)), `steps/${n}`).toBe(
        Math.max(1, Math.floor(n / 20))
      )
    }
  })

  it('a batch still reports progress at least once and at the last item', () => {
    for (const total of [1, 2, 20, 21, 100]) {
      const every = Math.max(1, Math.floor(total / BATCH_PROGRESS_STEPS))
      const points: number[] = []
      for (let i = 0; i < total; i++) {
        if (i % every === 0 || i === total - 1) points.push(i + 1)
      }
      expect(points[0]).toBe(1)
      expect(points[points.length - 1]).toBe(total)
      expect(points.length).toBeLessThanOrEqual(BATCH_PROGRESS_STEPS + 2)
    }
  })
})

describe('the call sites use the names', () => {
  it('the detector can see the old literals', () => {
    expect('const lanes = Math.min(3, queue.length)').toContain('Math.min(3, queue.length)')
    expect('if (done % 10 === 0) flush()').toContain('done % 10 === 0')
    expect('Math.floor(items.length / 20)').toContain('items.length / 20')
  })

  it('App.tsx and batch.ts no longer carry the bare numbers', () => {
    const app = read('src/App.tsx')
    const batch = read('src/lib/batch.ts')
    expect(app).toContain('Math.min(DOWNLOAD_LANES, queue.length)')
    expect(app).toContain('done % DOWNLOAD_FLUSH_EVERY === 0')
    expect(app).not.toContain('Math.min(3, queue.length)')
    expect(app).not.toContain('done % 10 === 0')
    expect(batch).toContain('Math.floor(items.length / BATCH_PROGRESS_STEPS)')
    expect(batch).not.toContain('items.length / 20)')
  })
})
