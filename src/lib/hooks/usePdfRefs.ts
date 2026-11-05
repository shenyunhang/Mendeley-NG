import { useCallback, useEffect, useRef, useState } from 'react'
import type * as pdfjs from 'pdfjs-dist'
import type { CiteMark, RefList } from '../pdfrefs'
import { findRefList, marksOnPage } from '../pdfrefs'
import { createLazyPages, type LazyPages } from '../lazyPages'

/**
 * The references of the open paper, and the citations in its body.
 *
 * These are two jobs and they are done at two different times.  The list is
 * read once, in the background, as soon as the paper is open: nothing can be
 * offered for a marker until the entry it names is known.  A page's markers
 * are read only when that page is being looked at, like the links — a paper
 * is fifty pages long and nobody hovers a marker on a page they never opened.
 *
 * The list is what decides whether anything happens at all.  A paper with no
 * list that can be read gets no markers, and the reader sees the paper they
 * always saw.
 */
export function usePdfRefs(o: {
  pdf: pdfjs.PDFDocumentProxy | null
  numPages: number
  continuous: boolean
  /** The page being read; its neighbours are warmed with it. */
  page: number
  /** Identifies the open document; a new one throws all of this away. */
  docKey: string | undefined | null
}) {
  const { pdf, numPages, continuous, page } = o
  const [list, setList] = useState<RefList | null>(null)
  const [marks, setMarks] = useState<Record<number, CiteMark[]>>({})
  const known = useRef(marks)
  known.current = marks
  /** The background walk in continuous mode owns its own page claims. */
  const busy = useRef(new Set<number>())

  /** The lazy single-page reads. Clearing `marks` on a document change cannot
   *  stop a `marksOnPage` for the old PDF from landing later; only a
   *  generation guard can (see 155). */
  const lazy = useRef<LazyPages<string, CiteMark[]> | null>(null)
  if (lazy.current === null) {
    lazy.current = createLazyPages<string, CiteMark[]>(
      (a) => setMarks((prev) => ({ ...prev, [a.page]: a.value })),
      []
    )
  }

  // another paper makes the list wrong and every marker with it. Clear
  // `known` here too: the effects below run in the same commit, and would
  // otherwise still see the previous paper's page numbers and skip them.
  useEffect(() => {
    lazy.current?.invalidate()
    known.current = {}
    setList(null)
    setMarks({})
    busy.current.clear()
  }, [o.docKey])

  useEffect(() => {
    if (!pdf || !numPages) return
    let dead = false
    void (async () => {
      const got = await findRefList(pdf, numPages, () => !dead).catch(() => null)
      if (!dead) setList(got)
    })()
    return () => {
      dead = true
    }
  }, [pdf, numPages, o.docKey])

  /** The page the list opens on, or 0 while it is still being looked for. */
  const refPage = list?.page ?? 0

  const ensure = useCallback(
    (n: number) => {
      if (!pdf || !refPage || n < 1 || n >= refPage) return
      if (known.current[n] !== undefined || busy.current.has(n)) return
      lazy.current?.read(o.docKey ?? '', n, (p) => marksOnPage(pdf, p))
    },
    [pdf, refPage, o.docKey]
  )

  useEffect(() => {
    if (!pdf || continuous) return
    void ensure(page)
    void ensure(page + 1)
    void ensure(page - 1)
  }, [pdf, continuous, page, ensure])

  useEffect(() => {
    if (!pdf || !continuous || !refPage) return
    let dead = false
    void (async () => {
      // one write per screenful, for the same reason the links do it: every
      // write rebuilds the column, and the column is holding every marker it
      // has been given
      let batch: Record<number, CiteMark[]> = {}
      for (let n = 1; n < refPage; n++) {
        if (dead) return
        if (
          known.current[n] !== undefined ||
          busy.current.has(n) ||
          lazy.current?.isBusy(n)
        )
          continue
        busy.current.add(n)
        let got: CiteMark[]
        try {
          got = await marksOnPage(pdf, n)
        } catch {
          got = []
        }
        busy.current.delete(n)
        if (dead) return
        batch[n] = got
        if (Object.keys(batch).length >= 8 || n === refPage - 1) {
          const flush = batch
          batch = {}
          setMarks((prev) => ({ ...prev, ...flush }))
        }
      }
    })()
    return () => {
      dead = true
    }
  }, [pdf, continuous, refPage])

  return { list, marks }
}
