import { beforeAll, describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { ipcMain } from 'electron'

/**
 * Behaviour cover for the main-side IPC clock.
 *
 * The point of the wrapper is that it measures without changing the shape of
 * an answer: a channel that used to return a plain value must still return a
 * plain value, a rejection must still reach the caller, and the reporter must
 * separate the part that occupied the event loop from the part that merely
 * waited on a promise. All three are asserted against captured handlers.
 */
const stub = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return { handlers }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      stub.handlers.set(channel, fn)
    }
  }
}))

import {
  getIpcTimings,
  installIpcTiming,
  resetIpcTimings,
  summariseIpcTimings,
  type IpcTimingRecord
} from '../electron/main/ipc/timing'

function call(channel: string, ...args: unknown[]): unknown {
  const h = stub.handlers.get(channel)
  if (!h) throw new Error('channel not registered: ' + channel)
  return h(null, ...args)
}

function spin(ms: number) {
  const t0 = performance.now()
  while (performance.now() - t0 < ms) {
    /* occupy the thread without yielding */
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeAll(() => {
  installIpcTiming()
  ipcMain.handle('test:sync', () => 42)
  ipcMain.handle('test:async', async () => {
    spin(3)
    await new Promise((r) => setTimeout(r, 10))
    return 'done'
  })
  ipcMain.handle('test:reject', async () => {
    throw new Error('boom')
  })
  ipcMain.handle('test:slow', () => {
    spin(5)
    return 'slow'
  })
})

describe('main-process IPC timing', () => {
  it('keeps a synchronous answer synchronous', () => {
    resetIpcTimings()
    const out = call('test:sync')
    expect(out).toBe(42)
    expect(out instanceof Promise).toBe(false)
    const r = getIpcTimings()
    expect(r).toHaveLength(1)
    expect(r[0]!.channel).toBe('test:sync')
    expect(r[0]!.settled).toBe('sync')
    expect(r[0]!.totalMs).toBe(r[0]!.syncMs)
  })

  it('separates the non-yielding part from the time spent waiting', async () => {
    resetIpcTimings()
    const out = await call('test:async')
    expect(out).toBe('done')
    await flush()
    const r = getIpcTimings().find((x) => x.channel === 'test:async')
    expect(r).toBeDefined()
    expect(r!.settled).toBe('resolved')
    expect(r!.syncMs).toBeGreaterThanOrEqual(2)
    expect(r!.totalMs).toBeGreaterThan(r!.syncMs)
  })

  it('records a rejection without swallowing it', async () => {
    resetIpcTimings()
    await expect(call('test:reject')).rejects.toThrow('boom')
    await flush()
    const r = getIpcTimings().find((x) => x.channel === 'test:reject')
    expect(r?.settled).toBe('rejected')
  })

  it('sums occupied time per channel and clears on reset', () => {
    resetIpcTimings()
    call('test:slow')
    call('test:slow')
    call('test:sync')
    const s = summariseIpcTimings()
    expect(s.calls).toBe(3)
    expect(s.byChannel['test:slow']?.calls).toBe(2)
    expect(s.byChannel['test:slow']!.worstBlockMs).toBeGreaterThan(0)
    expect(s.byChannel['test:sync']?.calls).toBe(1)
    expect(s.slowest[0]!.channel).toBe('test:slow')
    resetIpcTimings()
    expect(getIpcTimings()).toHaveLength(0)
    expect(summariseIpcTimings().calls).toBe(0)
  })

  it('aggregates an explicit list by value', () => {
    const list: IpcTimingRecord[] = [
      { channel: 'a', syncMs: 12, totalMs: 12, settled: 'sync' },
      { channel: 'a', syncMs: 8, totalMs: 30, settled: 'resolved' },
      { channel: 'b', syncMs: 3.5, totalMs: 3.5, settled: 'sync' }
    ]
    const s = summariseIpcTimings(list)
    expect(s.blockedMs).toBe(23.5)
    expect(s.worstBlockMs).toBe(12)
    expect(s.byChannel['a']).toEqual({ calls: 2, blockedMs: 20, worstBlockMs: 12 })
    expect(s.byChannel['b']).toEqual({ calls: 1, blockedMs: 3.5, worstBlockMs: 3.5 })
    expect(s.slowest[0]).toEqual({ channel: 'a', syncMs: 12, settled: 'sync' })
  })
})
