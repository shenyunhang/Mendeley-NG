/**
 * One short-lived thing at a time, and only one pending request to clear it.
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
 * the pending clear first, so a clear can only ever remove the thing that
 * asked for it.
 *
 * The payload is generic because the same shape is not only a status line.
 * A hover card is one too: it has to stay long enough for the pointer to
 * reach the button on it, and be cancelled on unmount. `keep` and `hold`
 * are for that case, where showing and scheduling a clear happen at
 * different moments. `string` is the default so the status-line callers do
 * not have to name a type.
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

export interface FlashMessage<T = string> {
  /** Show a value that clears itself after `ms`. */
  flash: (value: T, ms: number) => void
  /** Show a value and leave it there — a progress line, a step in a sequence,
   *  or a hover card whose exit is scheduled separately. Cancels any pending
   *  clear, so a stale timeout cannot cut it short. */
  show: (value: T) => void
  /** Cancel a pending clear without rendering. For "the pointer is back" and
   *  for unmount; the value on screen is already the right one. */
  keep: () => void
  /** Keep what is on screen but arrange for it to clear after `ms`. Showing
   *  and scheduling are separate for a hover card: the card is already up
   *  when the pointer leaves it. */
  hold: (ms: number) => void
  /** Take the value down now, and cancel its pending clear. */
  clear: () => void
  /** Cancel the pending clear without rendering: for unmount. */
  dispose: () => void
  /** Whether a clear is waiting to fire. Exposed for the smoke run. */
  hasPending: () => boolean
}

export function createFlashMessage<T = string>(
  render: (value: T | null) => void,
  clock: FlashClock = realClock
): FlashMessage<T> {
  let pending: unknown = null
  const cancel = () => {
    if (pending !== null) {
      clock.clear(pending)
      pending = null
    }
  }
  const schedule = (ms: number) => {
    pending = clock.set(() => {
      pending = null
      render(null)
    }, ms)
  }
  return {
    flash(value, ms) {
      cancel()
      render(value)
      schedule(ms)
    },
    show(value) {
      cancel()
      render(value)
    },
    keep: cancel,
    hold(ms) {
      cancel()
      schedule(ms)
    },
    clear() {
      cancel()
      render(null)
    },
    dispose: cancel,
    hasPending: () => pending !== null
  }
}
