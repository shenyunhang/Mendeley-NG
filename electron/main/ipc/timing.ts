import { performance } from 'node:perf_hooks'
import { ipcMain } from 'electron'

/**
 * How long an IPC handler kept the main process to itself.
 *
 * The performance observer in `perf.ts` lives in the renderer. It can only
 * report long tasks in the process it was installed in, so a handler that
 * synchronously scans the full-text corpus in the main process shows up as
 * zero long tasks while every other channel waits behind it. These records
 * are taken on the main side, where that block actually happens.
 *
 * `syncMs` is the time from entry until the handler returned a value or a
 * promise. That is the part which occupies the event loop without yielding.
 * `totalMs` also includes the wait for a promise to settle, so a slow network
 * request can be told apart from a slow computation. A handler that returns
 * a plain value is still returned as a plain value: changing every channel
 * into a promise would change the shape of the answers, not just measure them.
 */
export interface IpcTimingRecord {
  channel: string
  syncMs: number
  totalMs: number
  settled: 'sync' | 'resolved' | 'rejected'
}

const MAX_RECORDS = 4000
let records: IpcTimingRecord[] = []
let installed = false

function round(n: number) {
  return Math.round(n * 10) / 10
}

function push(channel: string, syncMs: number, settled: IpcTimingRecord['settled'], totalMs: number) {
  records.push({ channel, syncMs: round(syncMs), totalMs: round(totalMs), settled })
  if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS)
}

/**
 * Wrap `ipcMain.handle` once, before any domain registers its channels.
 * Only `--perf` installs it; an ordinary launch does not pay even the cost of
 * a ring buffer. Idempotent, because `registerIpc` and the measurement run
 * share one process and one `ipcMain`.
 */
export function installIpcTiming() {
  if (installed) return
  installed = true
  const original = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, handler: (...args: any[]) => any) =>
    original(channel, (...args: any[]) => {
      const t0 = performance.now()
      let answer: unknown
      try {
        answer = handler(...args)
      } catch (e) {
        const ms = performance.now() - t0
        push(channel, ms, 'rejected', ms)
        throw e
      }
      const syncMs = performance.now() - t0
      if (answer && typeof (answer as PromiseLike<unknown>).then === 'function') {
        const p = answer as Promise<unknown>
        p.then(
          () => push(channel, syncMs, 'resolved', performance.now() - t0),
          () => push(channel, syncMs, 'rejected', performance.now() - t0)
        )
        return answer
      }
      push(channel, syncMs, 'sync', syncMs)
      return answer
    })) as typeof ipcMain.handle
}

export function getIpcTimings(): IpcTimingRecord[] {
  return records.slice()
}

export function resetIpcTimings() {
  records = []
}

export interface IpcTimingSummary {
  calls: number
  /** Sum of the non-yielding parts. Two calls that overlap cannot, in fact,
   *  overlap on one event loop, so this is a lower bound on occupied time. */
  blockedMs: number
  worstBlockMs: number
  slowest: { channel: string; syncMs: number; settled: IpcTimingRecord['settled'] }[]
  byChannel: Record<string, { calls: number; blockedMs: number; worstBlockMs: number }>
}

export function summariseIpcTimings(list: readonly IpcTimingRecord[] = records): IpcTimingSummary {
  const byChannel: IpcTimingSummary['byChannel'] = {}
  let blockedMs = 0
  let worstBlockMs = 0
  for (const r of list) {
    blockedMs += r.syncMs
    if (r.syncMs > worstBlockMs) worstBlockMs = r.syncMs
    const b = (byChannel[r.channel] ??= { calls: 0, blockedMs: 0, worstBlockMs: 0 })
    b.calls++
    b.blockedMs += r.syncMs
    if (r.syncMs > b.worstBlockMs) b.worstBlockMs = r.syncMs
  }
  for (const b of Object.values(byChannel)) {
    b.blockedMs = round(b.blockedMs)
    b.worstBlockMs = round(b.worstBlockMs)
  }
  const slowest = [...list]
    .sort((a, b) => b.syncMs - a.syncMs)
    .slice(0, 8)
    .map((r) => ({ channel: r.channel, syncMs: r.syncMs, settled: r.settled }))
  return {
    calls: list.length,
    blockedMs: round(blockedMs),
    worstBlockMs: round(worstBlockMs),
    slowest,
    byChannel
  }
}
