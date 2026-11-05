import { useCallback, useEffect, useRef, useState } from 'react'
import type * as pdfjs from 'pdfjs-dist'
import type { LinkBox } from '../pdflinks'
import { linksOf } from '../pdflinks'
import { createLazyPages, type LazyPages } from '../lazyPages'
import { createPageWalk } from '../pageWalk'

/**
 * The links of the open paper, kept per page.
 *
 * They are fetched lazily and only once per page, because reading a page's
 * annotations means asking pdf.js for that page and a paper can be fifty pages
 * long.  In single-page mode the neighbours are warmed along with the visible
 * page, the same way bitmaps are; in continuous mode every page is walked in
 * the background, since the whole column is on screen at once.
 *
 * Following one is deliberately not this hook's decision: it hands the target
 * back and the component decides, because "turn to page 7" and "open a
 * browser" are two different things that only look alike from in here.
 */
export function usePdfLinks(o: {
  pdf: pdfjs.PDFDocumentProxy | null
  numPages: number
  continuous: boolean
  /** The page being read; its neighbours are warmed with it. */
  page: number
  /** Identifies the open document; a new one throws every link away. */
  docKey: string | undefined | null
}) {
  const { pdf, numPages, continuous, page } = o
  const [links, setLinks] = useState<Record<number, LinkBox[]>>({})
  const known = useRef<Record<number, LinkBox[]>>({})
  known.current = links
  /** The background walk in continuous mode owns its own page claims. */
  const busy = useRef(new Set<number>())

  /** The lazy single-page reads. A read is a promise: clearing `links` on a
   *  document change cannot stop a read for the old PDF from landing a moment
   *  later, so it needs a generation of its own (see 155). */
  const lazy = useRef<LazyPages<string, LinkBox[]> | null>(null)
  if (lazy.current === null) {
    lazy.current = createLazyPages<string, LinkBox[]>(
      (a) => setLinks((prev) => ({ ...prev, [a.page]: a.value })),
      []
    )
  }

  // a different document makes every link wrong, and so does a page count that
  // no longer fits them. Clear `known` here, not only through setLinks: the
  // effects below run in the same commit and would otherwise still see the
  // previous paper's page numbers and skip fetching them.
  useEffect(() => {
    lazy.current?.invalidate()
    known.current = {}
    setLinks({})
    busy.current.clear()
  }, [o.docKey])

  const ensure = useCallback(
    (n: number) => {
      if (!pdf || n < 1 || n > numPages) return
      if (known.current[n] !== undefined || busy.current.has(n)) return
      lazy.current?.read(o.docKey ?? '', n, (p) => linksOf(pdf, p))
    },
    [pdf, numPages, o.docKey]
  )

  useEffect(() => {
    if (!pdf || continuous) return
    void ensure(page)
    void ensure(page + 1)
    void ensure(page - 1)
  }, [pdf, continuous, page, ensure])

  // The batching rule lives in pageWalk.ts: one write per screenful, because
  // every write rebuilds a column holding the links of every page so far.
  // This hook supplies only what belongs to it -- which pages are already
  // claimed, when the effect has been cleaned up, and where the result goes.
  useEffect(() => {
    if (!pdf || !continuous || !numPages) return
    let dead = false
    const walk = createPageWalk<LinkBox>({
      isDead: () => dead,
      isClaimed: (n) =>
        known.current[n] !== undefined ||
        busy.current.has(n) ||
        !!lazy.current?.isBusy(n),
      claim: (n) => busy.current.add(n),
      release: (n) => busy.current.delete(n),
      publish: (batch) => setLinks((prev) => ({ ...prev, ...batch }))
    })
    void walk.walk(numPages, (n) => linksOf(pdf, n))
    return () => {
      dead = true
    }
  }, [pdf, continuous, numPages])

  return { links, ensure }
}
