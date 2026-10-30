import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Identifiers worth harvesting from a PDF before it is imported.  Mendeley's
 * own create-from-file only reads the file name, so anything the PDF text can
 * tell us is a cheap win over an empty record.
 */
export async function extractIds(
  data: ArrayBuffer
): Promise<{ doi?: string; arxiv?: string; title?: string }> {
  try {
    const pdf = await pdfjs.getDocument({ data }).promise
    let text = ''
    for (let i = 1; i <= Math.min(2, pdf.numPages); i++) {
      const page = await pdf.getPage(i)
      const tc = await page.getTextContent()
      text += tc.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n'
    }
    await pdf.destroy()
    // a DOI often runs into a following period or bracket; trim the tail
    const doi = text
      .match(/\b10\.\d{4,9}\/[^\s"'<>]+\.[^\s"'<>]*\b|\b10\.\d{4,9}\/[^\s"'<>]+/)?.[0]
      ?.replace(/[.,;)\]]+$/, '')
    const arxiv = text.match(/arXiv:\s?(\d{4}\.\d{4,5})(v\d+)?/i)?.[1]
    return { doi: doi || undefined, arxiv: arxiv || undefined }
  } catch {
    return {}
  }
}
