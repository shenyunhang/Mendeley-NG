/**
 * Decides whether an asynchronous "open this view" answer still belongs to
 * the view on screen.
 *
 * Opening the trash and opening the notes both await disk or network. The
 * reader can leave for another view while that is going on; an answer that
 * does not check where it was started from drags the middle of the window
 * back. Comparing the value is not enough: leaving the library for the
 * reader and coming back lands on the same value, but an answer started
 * before that round trip must still be refused. So every change of value
 * advances a generation, and the in-flight answer is checked against the
 * generation it started from rather than the value.
 *
 * `restoreTrashed` already did this with a functional setState, and these
 * two did not. No React or timers here, so the interleaving can be fixed by
 * calling `set` and `still` by hand. `set` runs on every render and is
 * idempotent: a value that has not changed does not advance the generation.
 */
export function createViewGeneration<T extends string>(initial: T) {
  let current = initial
  let generation = 0
  return {
    set(next: T) {
      if (next === current) return
      current = next
      generation++
    },
    read(): number {
      return generation
    },
    still(from: number): boolean {
      return from === generation
    },
    view(): T {
      return current
    }
  }
}
