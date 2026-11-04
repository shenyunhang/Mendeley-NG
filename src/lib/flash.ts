/**
 * One short-lived message at a time, and only one pending request to clear
 * it.
 *
 * The bug this exists for: a message used to be shown with
 * `setMsg(text); setTimeout(() => setMsg(null), ms)` repeated at a dozen
 * call sites. Each timeout was fire-and-forget — it cleared whatever was on
 * screen when it fired, not the message it was created with. So a later
 * message was wiped by an earlier one's timeout (copy a citation at t=0,
 * export at t=1s, and the export result vanishes at t=2.4s), and a progress
 * line was wiped by a stale completion timeout. Worse, the timeouts outlived
 * the component and called setState after unmount.
 *
 * Keeping the timer in one place fixes all three: showing anything cancels
 * the pending clear first, so a clear can only ever remove the message that
 * asked for it.
 *
 * The clock is injectable so this can be checked without sleeping. A test
 * hands in a clock whose timers it advances by hand; the renderer uses the
 * real one. Nothing here knows about React or the DOM.
 */
export interface FlashClock {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export const realClock: FlashClock = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export interface FlashMessage {
  /** Show a message that clears itself after `ms`. */
  flash: (text: string, ms: number) => void
  /** Show a message and leave it there — a progress line, or a step in a
   *  sequence whose end will call `flash`. Cancels any pending clear, so a
   *  stale timeout cannot cut a long-running progress message short. */
  show: (text: string) => void
  /** Take the message down now. */
  clear: () => void
  /** Cancel the pending clear without rendering: for unmount. */
  dispose: () => void
  /** Whether a clear is waiting to fire. Exposed for the smoke run. */
  hasPending: () => boolean
}

export function createFlashMessage(
  render: (text: string | null) => void,
  clock: FlashClock = realClock
): FlashMessage {
  let pending: unknown = null
  const cancel = () => {
    if (pending !== null) {
      clock.clear(pending)
      pending = null
    }
  }
  return {
    flash(text, ms) {
      cancel()
      render(text)
      pending = clock.set(() => {
        pending = null
        render(null)
      }, ms)
    },
    show(text) {
      cancel()
      render(text)
    },
    clear() {
      cancel()
      render(null)
    },
    dispose: cancel,
    hasPending: () => pending !== null
  }
}
