import { createFlashMessage, type FlashClock } from '../../src/lib/flash'

import type { SmokeCtx } from './smoke-ctx'

export function flashMessages(ctx: SmokeCtx) {
    type Job = { at: number; fn: () => void; live: boolean }
    const jobs: Job[] = []
    let clockNow = 0
    const clock: FlashClock = {
      set: (fn, ms) => {
        const job: Job = { at: clockNow + ms, fn, live: true }
        jobs.push(job)
        return job
      },
      clear: (h) => {
        ;(h as Job).live = false
      }
    }
    const advanceTo = (t: number) => {
      clockNow = t
      for (const j of jobs) {
        if (j.live && j.at <= clockNow) {
          j.live = false
          j.fn()
        }
      }
    }
    // Control: the same two messages through the fire-and-forget version
    // that was in the app before. It never cancels a pending clear, so the
    // later message has to be wiped at 2400ms. If it were not, the checks
    // below would be asserting nothing — an assertion that cannot fail looks
    // exactly like one that passes (142 / 145 / 146).
    {
      const oldJobs: Job[] = []
      let oldNow = 0
      const oldClock: FlashClock = {
        set: (fn, ms) => {
          const j: Job = { at: oldNow + ms, fn, live: true }
          oldJobs.push(j)
          return j
        },
        clear: (h) => {
          ;(h as Job).live = false
        }
      }
      let oldShown: string | null = null
      const naiveFlash = (text: string, ms: number) => {
        oldShown = text
        oldClock.set(() => {
          oldShown = null
        }, ms)
      }
      naiveFlash('已复制引文', 2400)
      oldNow = 1000
      naiveFlash('已导出 12 条', 6000)
      oldNow = 2500
      for (const j of oldJobs) {
        if (j.live && j.at <= oldNow) {
          j.live = false
          j.fn()
        }
      }
      ctx.expect(
        'the old fire-and-forget version really does wipe the later message',
        oldShown === null,
        { oldShown, oldNow }
      )
    }

    let shown: string | null = null
    const msg = createFlashMessage((t) => {
      shown = t
    }, clock)

    msg.flash('已复制引文', 2400)
    clockNow = 1000
    msg.flash('已导出 12 条', 6000)
    advanceTo(2500)
    ctx.expect(
      'a later message is not wiped by an earlier timeout',
      shown === '已导出 12 条',
      { shown, clockNow, live: jobs.filter((j) => j.live).length }
    )
    advanceTo(7100)
    ctx.expect(
      'and the later message still clears on its own',
      shown === null,
      { shown, clockNow }
    )

    msg.flash('已修改 5 条', 2200)
    msg.show('正在移入回收站 3/10…')
    advanceTo(9500)
    ctx.expect(
      'a progress line survives a stale timeout',
      shown === '正在移入回收站 3/10…',
      { shown, clockNow }
    )

    msg.flash('即将卸载', 1000)
    msg.dispose()
    advanceTo(20000)
    ctx.expect(
      'unmount cancels the pending clear without rendering',
      !msg.hasPending() && shown === '即将卸载',
      { shown, clockNow, pending: msg.hasPending() }
    )
}
