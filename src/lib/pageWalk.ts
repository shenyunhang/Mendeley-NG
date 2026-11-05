/**
 * One background walk over the pages of an open PDF, publishing a screenful
 * at a time.
 *
 * Links and citation markers are both read page by page in continuous mode,
 * and both used to carry their own copy of this loop.  The loop is not about
 * links or about citations: it is about not rebuilding the column once per
 * page.  Every publish re-renders a column that holds the anchors of every
 * page it has been given, so a fifty-page paper would otherwise be fifty
 * rebuilds of a few thousand anchors.  Walking in order also means the batch
 * that lands first is the one being read.
 *
 * Nothing here knows about React or pdf.js.  The caller owns the pages it has
 * already claimed, the dead flag from its effect cleanup, and the state write.
 * That is what makes the rule testable with promises resolved by hand, instead
 * of by opening a real PDF and hoping pdf.js is quick enough today.
 */

/** How many pages of results one column rebuild is allowed to carry. */
export const PAGE_BATCH_SIZE = 8

export interface PageWalkHost<T> {
  /** True once the effect that started the walk has been cleaned up. */
  isDead: () => boolean
  /** A page already known, claimed by this walk, or busy in a lazy read. */
  isClaimed: (page: number) => boolean
  claim: (page: number) => void
  release: (page: number) => void
  publish: (batch: Record<number, T[]>) => void
}

export interface PageWalk<T> {
  /**
   * Read pages `1..last` in order.  A `last` of 0 does nothing at all, which
   * is what a reference list found on page one asks for.
   */
  walk: (last: number, read: (page: number) => Promise<T[]>) => Promise<void>
}

export function createPageWalk<T>(host: PageWalkHost<T>): PageWalk<T> {
  return {
    async walk(last, read) {
      let batch: Record<number, T[]> = {}
      for (let n = 1; n <= last; n++) {
        if (host.isDead()) return
        if (host.isClaimed(n)) continue
        host.claim(n)
        let got: T[]
        try {
          got = await read(n)
        } catch {
          // a page that will not give up its annotations simply has none
          got = []
        }
        host.release(n)
        if (host.isDead()) return
        batch[n] = got
        if (Object.keys(batch).length >= PAGE_BATCH_SIZE || n === last) {
          const flush = batch
          batch = {}
          host.publish(flush)
        }
      }
    }
  }
}
