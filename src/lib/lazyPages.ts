/**
 * Lazy page reads that belong to one document.
 *
 * Links and citation markers are pulled a page at a time, only when that page
 * is being looked at. A read is a promise, and a promise cannot be cancelled:
 * clearing the state on a document change does not stop a read for the old
 * PDF from landing a moment later and writing the old paper's links into the
 * new one. The reader keeps one component across papers, so this has to be
 * guarded rather than left to unmount.
 *
 * A generation is captured when a read starts and checked when it settles.
 * Invalidating one bumps the generation and lets every stale read keep its
 * busy slot out of the new document's way. Nothing is written on invalidate:
 * the hook clears its own state, and a stale read that can no longer deliver
 * is already invisible.
 */
export interface PageAnswer<Q, V> {
  doc: Q
  page: number
  value: V
}

export interface LazyPages<Q, V> {
  read: (doc: Q, page: number, load: (n: number) => Promise<V>) => void
  isBusy: (page: number) => boolean
  invalidate: () => void
}

export function createLazyPages<Q, V>(
  render: (answer: PageAnswer<Q, V>) => void,
  fallback: V
): LazyPages<Q, V> {
  let generation = 0
  const busy = new Set<number>()
  return {
    read(doc, page, load) {
      if (busy.has(page)) return
      busy.add(page)
      const mine = generation
      load(page).then(
        (value) => {
          if (mine !== generation) return
          busy.delete(page)
          render({ doc, page, value })
        },
        () => {
          if (mine !== generation) return
          busy.delete(page)
          render({ doc, page, value: fallback })
        }
      )
    },
    isBusy: (page) => busy.has(page),
    invalidate() {
      ++generation
      busy.clear()
    }
  }
}
