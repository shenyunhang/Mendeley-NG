import type * as pdfjs from 'pdfjs-dist'
import type { LinkBox } from '../pdflinks'
import { linksOf } from '../pdflinks'
import { useLazyPdfPages } from './useLazyPdfPages'

/**
 * The links of the open paper, kept per page.
 *
 * All the lazy-read machinery is shared with the references in
 * useLazyPdfPages; this wrapper supplies only what is particular to links:
 * what a page read returns (`linksOf`) and how far the paper goes (`numPages`).
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
  const { values: links, ensure } = useLazyPdfPages<LinkBox>({
    pdf: o.pdf,
    continuous: o.continuous,
    page: o.page,
    docKey: o.docKey,
    lastPage: o.numPages,
    load: linksOf
  })
  return { links, ensure }
}
