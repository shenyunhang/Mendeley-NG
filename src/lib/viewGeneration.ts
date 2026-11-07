/**
 * Decides whether an asynchronous "open this view" answer still belongs to
 * the view on screen.
 *
 * Opening the trash and opening the notes both await disk or network. The
 * reader can leave for another view while that is going on; an answer that
 * does not check where it was started from drags the middle of the window
 * back. `restoreTrashed` already did this with a functional setState, and
 * these two did not. No React or timers here, so the interleaving can be
 * fixed by calling `set` and `still` by hand.
 */
export function createViewGeneration<T extends string>(initial: T) {
  let current = initial
  return {
    set(next: T) {
      current = next
    },
    read(): T {
      return current
    },
    still(from: T): boolean {
      return current === from
    }
  }
}
