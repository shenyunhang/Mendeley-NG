/**
 * One cloud pull at a time.
 *
 * Two pulls used to read the same watermark, merge into their own private
 * snapshot and then each write the whole cache. Whichever finished last won,
 * so a paper the other request had just brought down disappeared again while
 * `syncedAt` moved past it — the next incremental pull could not bring it
 * back. A queue is enough: every caller still gets its own answer, but the
 * later pull starts from the earlier one's result.
 *
 * The runner is injected so the interleaving can be fixed by resolving
 * promises by hand instead of by racing real network calls.
 */
export function createSyncQueue<T>(
  run: (full: boolean) => Promise<T>
): (full: boolean) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return (full: boolean) => {
    const next = tail.then(() => run(full))
    // A failed pull must not poison the queue: without this catch every later
    // pull would reject before even starting.
    tail = next.catch(() => undefined)
    return next
  }
}
