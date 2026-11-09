import { useEffect, useState } from 'react'
import type * as pdfjs from 'pdfjs-dist'
import type { CiteMark, RefList } from '../pdfrefs'
import { findRefList, marksOnPage } from '../pdfrefs'
import { useLazyPdfPages } from './useLazyPdfPages'

/**
 * The references of the open paper, and the citations in its body.
 *
 * The per-page markers are read lazily by useLazyPdfPages, shared with the
 * links; this wrapper supplies `marksOnPage` and the last body page (one before
 * the reference list).  The list itself is a second, earlier job and stays
 * here: it is read once in the background as soon as the paper opens, because
 * nothing can be offered for a marker until the entry it names is known.  A
 * paper with no list that can be read gets no markers.
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

  /** The page the list opens on, or 0 while it is still being looked for. */
  const refPage = list?.page ?? 0
  // Only the body pages before the list can carry a marker.  0 while the list
  // is unknown (or opens on page one) disables every read and the walk.
  const lastPage = refPage > 0 ? refPage - 1 : 0

  const { values: marks } = useLazyPdfPages<CiteMark>({
    pdf,
    continuous,
    page,
    docKey: o.docKey,
    lastPage,
    load: marksOnPage,
    onReset: () => setList(null)
  })

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

  return { list, marks }
}
