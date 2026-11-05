/**
 * One walk of one paper, for one word.
 *
 * A find scan is not a single promise: it publishes the hits it has found so
 * far while the rest of the pages are still being read, and at the end it
 * opens the find bar.  Both of those are writes, and both belong to the word
 * that started the walk.  Keeping the word on every answer means the reader
 * never has to be told "ignore the orange boxes for a moment" — a word that
 * is no longer in the box simply has no answer on screen.
 *
 * Cancelling is only an invalidation.  It does not publish an empty answer or
 * a busy flag, because the answer already carries its word: closing the box
 * clears the word, and `answerHits` then has nothing to return.  Writing here
 * would add a render to every mount and every keystroke for no visible change,
 * which is exactly the mistake 152 had to undo.
 */
export interface ScanAnswer<Q, H> {
  question: Q
  hits: H[]
  done: boolean
}

/** A handle on one walk. `alive` is checked between pages; `publish` is the
 *  incremental answer, `finish` is the last one and opens the bar. */
export interface Scan<H> {
  alive: () => boolean
  publish: (hits: H[]) => void
  finish: (hits: H[]) => void
}

export interface FindScan<Q, H> {
  start: (question: Q) => Scan<H>
  cancel: () => void
}

/** The hits for the word now in the box, or `null` when it has not been
 *  answered yet. An empty array is a real answer: "this word is not here". */
export function answerHits<Q, H>(
  answer: ScanAnswer<Q, H> | null,
  question: Q
): H[] | null {
  return answer && answer.question === question ? answer.hits : null
}

/** Only the word being scanned can keep the spinner turning. A superseded
 *  scan that returned early can therefore never leave the bar busy forever. */
export function answerBusy<Q, H>(
  answer: ScanAnswer<Q, H> | null,
  question: Q
): boolean {
  return !!answer && answer.question === question && !answer.done
}

export function createFindScan<Q, H>(
  render: (answer: ScanAnswer<Q, H>) => void,
  onFinish: (question: Q, hits: H[]) => void
): FindScan<Q, H> {
  let generation = 0
  return {
    start(question) {
      const mine = ++generation
      render({ question, hits: [], done: false })
      return {
        alive: () => mine === generation,
        publish(hits) {
          if (mine === generation) render({ question, hits, done: false })
        },
        finish(hits) {
          if (mine === generation) {
            render({ question, hits, done: true })
            onFinish(question, hits)
          }
        }
      }
    },
    cancel() {
      ++generation
    }
  }
}
