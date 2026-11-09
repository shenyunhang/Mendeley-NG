import { useCallback, useEffect, useRef, useState } from 'react'
import type * as pdfjs from 'pdfjs-dist'
import { createLazyPages, type LazyPages } from '../lazyPages'
import { createPageWalk } from '../pageWalk'

/**
 * One open PDF's per-page values, read lazily and only once per page.
 *
 * Links and citation markers both used to carry a line-by-line copy of this
 * hook: a `known` ref mirroring the values so an effect in the same commit can
 * see them, a `busy` set owned by the background walk, `createLazyPages` for
 * the guarded single-page reads, neighbours warmed in single-page mode and
 * `createPageWalk` in continuous mode.  What differed was only what a page
 * read returns, how far the paper goes, and (for the references) extra state
 * that has to be thrown away with the document.  Those are the arguments
 * below; the machinery lives here once.
 *
 * `lastPage` is the highest page that may be read.  0 disables both the
 * single-page reads and the walk -- a reference list found on page one, or no
 * list at all, has no body pages to offer.
 */
export function useLazyPdfPages<T>(o: {
  pdf: pdfjs.PDFDocumentProxy | null
  continuous: boolean
  page: number
  docKey: string | undefined | null
  lastPage: number
  load: (pdf: pdfjs.PDFDocumentProxy, page: number) => Promise<T[]>
  /** Extra cleanup on a document change; held in a ref so it is not a dep. */
  onReset?: () => void
}): { values: Record<number, T[]>; ensure: (n: number) => void } {
  const { pdf, continuous, page, lastPage } = o
  const [values, setValues] = useState<Record<number, T[]>>({})
  const known = useRef<Record<number, T[]>>({})
  known.current = values
  /** The background walk in continuous mode owns its own page claims. */
  const busy = useRef(new Set<number>())

  /** The loader and the extra reset live behind refs: neither is a React
   *  dependency of the effects below, just as the two module-level loaders
   *  and the inline setList never were. */
  const loadRef = useRef(o.load)
  loadRef.current = o.load
  const onResetRef = useRef(o.onReset)
  onResetRef.current = o.onReset

  /** The lazy single-page reads. A read is a promise: clearing `values` on a
   *  document change cannot stop a read for the old PDF from landing a moment
   *  later, so it needs a generation of its own (see lazyPages.ts). */
  const lazy = useRef<LazyPages<string, T[]> | null>(null)
  if (lazy.current === null) {
    lazy.current = createLazyPages<string, T[]>(
      (a) => setValues((prev) => ({ ...prev, [a.page]: a.value })),
      []
    )
  }

  // A different document makes every value wrong. Clear `known` here, not only
  // through setValues: the effects below run in the same commit and would
  // otherwise still see the previous paper's page numbers and skip fetching.
  useEffect(() => {
    lazy.current?.invalidate()
    known.current = {}
    setValues({})
    busy.current.clear()
    onResetRef.current?.()
  }, [o.docKey])

  const ensure = useCallback(
    (n: number) => {
      if (!pdf || !lastPage || n < 1 || n > lastPage) return
      if (known.current[n] !== undefined || busy.current.has(n)) return
      lazy.current?.read(o.docKey ?? '', n, (p) => loadRef.current(pdf, p))
    },
    [pdf, lastPage, o.docKey]
  )

  useEffect(() => {
    if (!pdf || continuous) return
    void ensure(page)
    void ensure(page + 1)
    void ensure(page - 1)
  }, [pdf, continuous, page, ensure])

  // The batching rule lives in pageWalk.ts: one write per screenful, because
  // every write rebuilds a column holding the values of every page so far.
  // This hook supplies only what belongs to it -- which pages are already
  // claimed, when the effect has been cleaned up, and where the result goes.
  useEffect(() => {
    if (!pdf || !continuous || !lastPage) return
    let dead = false
    const walk = createPageWalk<T>({
      isDead: () => dead,
      isClaimed: (n) =>
        known.current[n] !== undefined ||
        busy.current.has(n) ||
        !!lazy.current?.isBusy(n),
      claim: (n) => busy.current.add(n),
      release: (n) => busy.current.delete(n),
      publish: (batch) => setValues((prev) => ({ ...prev, ...batch }))
    })
    void walk.walk(lastPage, (n) => loadRef.current(pdf, n))
    return () => {
      dead = true
    }
  }, [pdf, continuous, lastPage])

  return { values, ensure }
}
