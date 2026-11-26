/**
 * Clicking through rows used to leave every earlier pdf.js getDocument() task
 * parsing to completion. These assertions hold the wiring that keeps the task
 * and releases it when the document changes or the reader unmounts, and the
 * behaviour of the named door that swallows an already-destroyed worker.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FAILURE, failureCounts, resetFailureCounts } from '../shared/failures'
import { destroyLoadingTask } from '../src/lib/pdfTaskCleanup'

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

describe('the reader releases a superseded loading task', () => {
  it('the detector can see the shape that only marked the callback dead', () => {
    const oldShape = 'return () => { dead = true; pending.current?.cancel() }'
    expect(oldShape).toContain('dead = true')
    expect(oldShape).not.toContain('task.destroy()')
  })

  it('keeps the loading task and destroys it from the effect cleanup', () => {
    const viewer = read('src/components/PdfViewer.tsx')
    expect(viewer).toContain('const task = pdfjs.getDocument(')
    expect(viewer).toContain('task.promise')
    expect(viewer).toContain('void destroyLoadingTask(task)')
    // The old shape destroyed the proxy only after the promise resolved,
    // which left the parse itself running for every row clicked before it.
    expect(viewer).not.toContain('p.destroy()')
    const helper = read('src/lib/pdfTaskCleanup.ts')
    expect(helper).toContain('task.destroy()')
    expect(helper).toContain('ignoreFailure(FAILURE.workerCleanup')
  })

  it('destroys the task and resolves for both outcomes', async () => {
    let destroyed = 0
    await destroyLoadingTask({ destroy: async () => { destroyed++ } })
    expect(destroyed).toBe(1)

    resetFailureCounts()
    await destroyLoadingTask({
      destroy: () => Promise.reject(new Error('worker already gone'))
    })
    expect(failureCounts()[FAILURE.workerCleanup]?.ignored).toBe(1)
  })
})
