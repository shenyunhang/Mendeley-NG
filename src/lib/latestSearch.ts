/**
 * A debounced lookup that may only put the answer to the question now being
 * asked on screen.
 *
 * The bug this exists for: the full-text box used to run
 * `setTimeout(() => ftSearch(q).then(setHits), 250)` and clean up with
 * `clearTimeout(t)`. That cancels a timer that has not fired yet, but not the
 * request it already started. Type a word, wait for the lookup to go out,
 * then empty the box: the box says "输入要找的词" while the old hits land in
 * state a moment later. Type another word and those old hits sit on screen
 * under the new one for as long as the debounce takes. An index build that
 * finishes mid-lookup has the same problem from the other side — the older
 * answer can put "not found" back over a library that has since been read.
 * The view made it worse by building its rows out of `hits` without ever
 * asking which word produced them, so there was no second line of defence.
 *
 * Two rules fix it. Every answer carries the question it answers, and a
 * question that is no longer on screen cannot be shown. Every lookup carries
 * a generation, and a superseded lookup cannot deliver at all — including
 * one still in flight after the view has gone away. Because the tag already
 * hides an old answer, cancelling a question needs no state write at all:
 * the caller's render is left alone, which is what keeps an inactive panel
 * from re-rendering the whole window just because it mounted.
 *
 * The clock and the lookup are injected so both rules can be checked by
 * advancing time and resolving promises by hand. Nothing here knows about
 * React, Electron, PDFs or the DOM.
 */
export interface SearchClock {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export const realSearchClock: SearchClock = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/** An answer, kept with the question it was produced for. */
export interface SearchAnswer<Q, R> {
  question: Q
  result: R
}

/**
 * The only answer worth rendering. `null` means "no answer for this question
 * yet" — which is different from an empty result, and the difference is what
 * lets the view say 正在查找 instead of lying with 正文里没找到 while a
 * lookup is still out.
 */
export function answerFor<Q, R>(
  answer: SearchAnswer<Q, R> | null,
  question: Q
): R | null {
  return answer && answer.question === question ? answer.result : null
}

export interface LatestSearch<Q, R> {
  /** Ask `question` after `ms` of quiet. Supersedes the previous ask,
   *  whether that one is still waiting or already in flight. */
  ask: (question: Q, ms: number) => void
  /**
   * The question went away. Nothing waiting or in flight may deliver, and
   * **nothing is rendered**: the answer left in state is tagged with the
   * old question, so `answerFor` already keeps it off the screen, and a
   * state write here would be a render the caller did not ask for. That
   * matters on mount, when the full-text panel is not even open — an extra
   * top-level render there perturbs the virtualised table's scroll window
   * (152). It also means the same method is safe on unmount: no setState
   * after unmount, and no permanent "disposed" flag, so StrictMode's second
   * mount in dev can ask again. The caller that genuinely wants the answer
   * gone, "delete the index", clears its own state.
   */
  cancel: () => void
  /** Whether a debounce timer is waiting. Exposed for the smoke run. */
  hasPendingTimer: () => boolean
}

export function createLatestSearch<Q, R>(
  run: (question: Q) => Promise<R>,
  render: (answer: SearchAnswer<Q, R> | null) => void,
  /** What a failed lookup answers with. A rejection must still end the
   *  "searching" state, or the view waits forever for an answer that will
   *  never come. */
  empty: R,
  clock: SearchClock = realSearchClock
): LatestSearch<Q, R> {
  let generation = 0
  let timer: unknown = null

  const dropTimer = () => {
    if (timer !== null) {
      clock.clear(timer)
      timer = null
    }
  }
  /** Bumping the generation is the whole cancellation: a lookup remembers
   *  the generation it started under and is ignored once it no longer
   *  matches. There is no way to reach into an IPC call and stop it. */
  const supersede = () => {
    generation += 1
    dropTimer()
  }

  return {
    ask(question, ms) {
      supersede()
      const mine = generation
      timer = clock.set(() => {
        timer = null
        run(question).then(
          (result) => {
            if (mine === generation) render({ question, result })
          },
          () => {
            if (mine === generation) render({ question, result: empty })
          }
        )
      }, ms)
    },
    cancel: supersede,
    hasPendingTimer: () => timer !== null
  }
}
