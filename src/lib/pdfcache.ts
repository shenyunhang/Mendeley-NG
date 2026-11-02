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
 */
export class PrefetchCache {
  private done = new Map<string, HTMLCanvasElement>()
  private busy = new Map<string, Promise<HTMLCanvasElement>>()

  constructor(private readonly max = 6) {}

  /** The finished bitmap for `key`, if there is one. */
  peek(key: string): HTMLCanvasElement | undefined {
    return this.done.get(key)
  }

  /** The render already under way for `key`, if there is one. */
  flight(key: string): Promise<HTMLCanvasElement> | undefined {
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
   * indistinguishable from a real bug.
   */
  warm(key: string, draw: () => Promise<HTMLCanvasElement>): Promise<void> {
    if (this.done.has(key)) return Promise.resolve()
    const running = this.busy.get(key)
    if (running) return running.then(() => undefined).catch(() => undefined)
    const p = draw().then((c) => {
      this.busy.delete(key)
      this.done.set(key, c)
      this.evict()
      this.stamp()
      return c
    })
    this.busy.set(key, p)
    this.stamp()
    p.catch(() => {
      this.busy.delete(key)
      this.stamp()
    })
    return p.then(() => undefined)
  }

  /**
   * A different document makes every bitmap wrong, and so does a render that
   * is still in flight: a bitmap of the paper being left must not land on a
   * canvas that now belongs to another one.
   */
  clear() {
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
    const d = document.documentElement.dataset
    d.pfSize = String(this.done.size)
    d.pfKeys = [...this.done.keys()].join(',')
    d.pfWarm = [...this.busy.keys()].join(',')
  }
}
