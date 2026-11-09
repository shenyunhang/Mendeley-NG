import { createFlashMessage, type FlashClock } from '../../src/lib/flash'

import type { SmokeCtx } from './smoke-ctx'

export function hoverCard(ctx: SmokeCtx) {
    type Card = { rows: string[] }
    const makeClock = () => {
      let now = 0
      const jobs: { at: number; live: boolean; fn: () => void }[] = []
      const clock: FlashClock = {
        set(fn, ms) {
          const j = { at: now + ms, live: true, fn }
          jobs.push(j)
          return j
        },
        clear(h) {
          const j = h as (typeof jobs)[number] | undefined
          if (j) j.live = false
        }
      }
      const advanceTo = (t: number) => {
        now = t
        for (const j of jobs) {
          if (j.live && j.at <= now) {
            j.live = false
            j.fn()
          }
        }
      }
      return { clock, jobs, advanceTo }
    }

    // Control: the old card had its own timer. Dismissing it did not clear
    // that timer, so it really does call setCite(null) once more afterwards.
    {
      const { clock, advanceTo } = makeClock()
      const writes: (Card | null)[] = []
      const oldSetCite = (v: Card | null) => writes.push(v)
      oldSetCite({ rows: ['[1]'] })
      clock.set(() => oldSetCite(null), 260)
      oldSetCite(null)
      const before = writes.length
      advanceTo(300)
      ctx.expect(
        'the old hide timer really does write after the card is already gone',
        writes.length === before + 1 && writes[writes.length - 1] === null,
        { before, after: writes.length }
      )
    }

    const { clock, jobs, advanceTo } = makeClock()
    const box: { card: Card | null; writes: number } = { card: null, writes: 0 }
    const card = createFlashMessage<Card>(
      (v) => {
        box.card = v
        box.writes += 1
      },
      clock
    )

    card.show({ rows: ['[1] He et al. (2022)'] })
    ctx.expect(
      'one controller now carries a card, not only a status string',
      box.card !== null &&
        box.card.rows[0] === '[1] He et al. (2022)' &&
        !card.hasPending(),
      { card: box.card, pending: card.hasPending() }
    )

    card.hold(260)
    const beforeHold = box.writes
    card.hold(260)
    ctx.expect(
      'hold keeps the card and never leaves two pending clears',
      box.writes === beforeHold &&
        box.card !== null &&
        card.hasPending() &&
        jobs.filter((j) => j.live).length === 1,
      { writes: box.writes, beforeHold, live: jobs.filter((j) => j.live).length }
    )

    card.keep()
    advanceTo(1000)
    ctx.expect(
      'the pointer coming back cancels the pending exit',
      box.writes === beforeHold && box.card !== null && !card.hasPending(),
      { writes: box.writes, beforeHold, card: box.card }
    )

    card.hold(260)
    advanceTo(1400)
    ctx.expect(
      'the card still exits on its own when the pointer stays away',
      box.card === null && box.writes === beforeHold + 1,
      { card: box.card, writes: box.writes, beforeHold }
    )

    card.show({ rows: ['[2]'] })
    card.hold(260)
    card.clear()
    const beforeClear = box.writes
    advanceTo(2000)
    ctx.expect(
      'dismissing the card cancels its pending clear, no second write',
      box.card === null &&
        box.writes === beforeClear &&
        !card.hasPending() &&
        jobs.filter((j) => j.live).length === 0,
      { writes: box.writes, beforeClear, live: jobs.filter((j) => j.live).length }
    )

    card.show({ rows: ['[3]'] })
    card.hold(260)
    card.dispose()
    const beforeUnmount = box.writes
    advanceTo(3000)
    ctx.expect(
      'unmount cancels the pending exit without rendering',
      box.writes === beforeUnmount && box.card !== null && !card.hasPending(),
      { writes: box.writes, beforeUnmount, card: box.card }
    )

    card.flash({ rows: ['[4]'] }, 100)
    advanceTo(3200)
    ctx.expect(
      'flash still works with an object payload',
      box.card === null && !card.hasPending(),
      { card: box.card, pending: card.hasPending() }
    )
}
