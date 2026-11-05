import { useCallback, useEffect, useRef, useState } from 'react'
import type * as pdfjs from 'pdfjs-dist'
import type { LinkBox } from '../pdflinks'
import { linksOf } from '../pdflinks'
import { createLazyPages, type LazyPages } from '../lazyPages'

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

  useEffect(() => {
    if (!pdf || !continuous || !numPages) return
    let dead = false
    ;(async () => {
      // One write per screenful rather than one per page.  Every write
      // re-renders the column, and the column is holding the links of every
      // page it has been given, so a write a page turns a fifty-page paper
      // into fifty rebuilds of a few thousand anchors.  Walking in order
      // means the batch that lands first is the one being read.
      let batch: Record<number, LinkBox[]> = {}
      for (let n = 1; n <= numPages; n++) {
        if (dead) return
        if (
          known.current[n] !== undefined ||
          busy.current.has(n) ||
          lazy.current?.isBusy(n)
        )
          continue
        busy.current.add(n)
        let got: LinkBox[]
        try {
          got = await linksOf(pdf, n)
        } catch {
          // a page that will not give up its annotations simply has none
          got = []
        }
        busy.current.delete(n)
        if (dead) return
        batch[n] = got
        if (Object.keys(batch).length >= 8 || n === numPages) {
          const flush = batch
          batch = {}
          setLinks((prev) => ({ ...prev, ...flush }))
        }
      }
    })()
    return () => {
      dead = true
    }
  }, [pdf, continuous, numPages])

  return { links, ensure }
}
