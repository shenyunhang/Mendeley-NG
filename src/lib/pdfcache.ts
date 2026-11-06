/**
 * Bitmaps of neighbouring pages, kept so a page turn paints immediately
 * instead of waiting for pdf.js.
 *
 * Keyed by page, scale and pixel ratio: a bitmap only helps if it is already
 * the right size, so a zoom change simply misses and re-renders.  Capped and
 * evicted least-recently-used, because a full-page bitmap at devicePixelRatio
 * is not small — six of them is already a noticeable amount of memory.
 *
 * In-flight renders are kept as promises rather than dropped, so that a page
 * turn can join one instead of starting a second render of the same page.  A
 * warm is queued behind the visible page in the pdf.js worker, so it routinely
 * outlives the click that will ask for it; without this the turn just renders
 * it again, and the worker is busy for twice as long.
 *
 * The cache itself knows nothing about the DOM, the paper, or what a canvas
 * is.  Its one link to the window is the injected `onStamp` callback, and its
 * bitmaps are generic, so the ordering rules below can be checked by resolving
 * promises by hand in the main process, where there is no document and no
 * pdf.js.  That separation is the point: a rule about which paper a bitmap
 * belongs to must not depend on a browser being open to be tested.
 */

/** Shape of the state the window shows for diagnostics. */
export interface PrefetchSnapshot {
  size: number
  keys: string[]
  warm: string[]
}

/**
 * A render that outlived the paper it was started for.  Thrown on the promise
 * the caller is holding so that every waiter — the warm ring, a page turn
 * joining the flight, and the in-flight bookkeeping — takes its existing
 * failure path instead of painting a bitmap of the previous paper.
 */
export class StaleFlight extends Error {
  constructor(key: string) {
    super('a render for the previous document finished after the paper changed: ' + key)
    this.name = 'StaleFlight'
  }
}

export class PrefetchCache<T> {
  private done = new Map<string, T>()
  private busy = new Map<string, Promise<T>>()
  /**
   * One generation per document.  `clear` invalidates it, which is the only
   * thing that can tell an in-flight render that the paper on screen has
   * moved on: clearing the two maps does not stop a promise that is already
   * running, and the key has no document id in it.
   */
  private generation = 0

  constructor(
    private readonly max = 6,
    private readonly onStamp: (s: PrefetchSnapshot) => void = () => {}
  ) {}

  /** The finished bitmap for `key`, if there is one. */
  peek(key: string): T | undefined {
    return this.done.get(key)
  }

  /** The render already under way for `key`, if there is one. */
  flight(key: string): Promise<T> | undefined {
    return this.busy.get(key)
  }

  /** Re-insert, so the LRU knows this one was just used. */
  touch(key: string) {
    const b = this.done.get(key)
    if (!b) return
    this.done.delete(key)
    this.done.set(key, b)
  }

  drop(key: string) {
    this.done.delete(key)
  }

  /**
   * Render `key` offscreen, unless it is already done or already in flight.
   *
   * The rejection is deliberately left on the returned promise: whoever awaits
   * it decides whether a failed warm matters, and an unhandled one would be
   * indistinguishable from a real bug.  A stale render is a failed warm — it
   * has no bitmap that belongs to the paper now on screen.
   */
  warm(key: string, draw: () => Promise<T>): Promise<void> {
    if (this.done.has(key)) return Promise.resolve()
    const running = this.busy.get(key)
    if (running) return running.then(() => undefined).catch(() => undefined)
    const gen = this.generation
    const p = draw().then((c) => {
      if (gen !== this.generation) throw new StaleFlight(key)
      this.busy.delete(key)
      this.done.set(key, c)
      this.evict()
      this.stamp()
      return c
    })
    this.busy.set(key, p)
    this.stamp()
    p.catch(() => {
      // A stale failure must not delete the flight of a warm that started
      // *after* the paper changed and happens to use the same key.
      if (gen !== this.generation) return
      this.busy.delete(key)
      this.stamp()
    })
    return p.then(() => undefined)
  }

  /**
   * A different document makes every bitmap wrong, and so does a render that
   * is still in flight: a bitmap of the paper being left must not land on a
   * canvas that now belongs to another one.  Clearing the maps is not enough;
   * invalidating the generation is what actually stops the in-flight one.
   */
  clear() {
    this.generation += 1
    this.done.clear()
    this.busy.clear()
  }

  /** Drop the least recently used entries until the cache fits again. */
  private evict() {
    while (this.done.size > this.max) {
      const oldest = this.done.keys().next().value
      if (oldest === undefined) return
      this.done.delete(oldest)
    }
  }

  /** Exposed on `<html>` so the smoke run can tell a hit from a miss. */
  stamp() {
    this.onStamp({
      size: this.done.size,
      keys: [...this.done.keys()],
      warm: [...this.busy.keys()]
    })
  }
}
