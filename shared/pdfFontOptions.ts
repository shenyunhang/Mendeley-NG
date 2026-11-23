/**
 * One copy of the pdf.js font-resource options.
 *
 * A CID font with a predefined ordering (Adobe-GB1, Adobe-Japan1, ...) and no
 * /ToUnicode needs the matching -UCS2 CMap before pdf.js will translate it.
 * Without `cMapUrl` the font is replaced by an ErrorFont and the canvas draws
 * its boxes and arrows but silently drops every glyph, which reads as a
 * figure whose labels are missing.  Fonts that are not embedded at all need
 * `standardFontDataUrl` for the same reason.
 *
 * The files are pdfjs-dist's `cmaps/` and `standard_fonts/`, copied beside the
 * renderer's index.html by scripts/copy-pdf-assets.mjs.  The renderer reaches
 * them over the page's own scheme, while pdf.js in the main process reads them
 * as filesystem paths with fs, so the two derivations are separate but share
 * the directory names and the option shape.
 */

export interface PdfFontOptions {
  cMapUrl: string
  cMapPacked: true
  standardFontDataUrl: string
}

/** The two directories, relative to the renderer's index.html. */
export const PDF_CMAP_DIR = 'cmaps'
export const PDF_STANDARD_FONT_DIR = 'standard_fonts'

/** Renderer: resolve the asset directories against the page that loads them. */
export function pdfFontOptionsFromUrl(baseUrl: string): PdfFontOptions {
  return {
    cMapUrl: new URL(PDF_CMAP_DIR + '/', baseUrl).href,
    cMapPacked: true,
    standardFontDataUrl: new URL(PDF_STANDARD_FONT_DIR + '/', baseUrl).href
  }
}

/**
 * Main process: pdf.js's Node factories call fs.readFile on the concatenated
 * path, so this must stay a plain path rather than a file:// URL.  Forward
 * slashes are accepted by fs on every platform the app is built for, and a
 * single trailing separator keeps `baseUrl + name + '.bcmap'` valid.
 */
export function pdfFontOptionsFromPath(baseDir: string): PdfFontOptions {
  const base = baseDir.replace(/[\\/]+$/, '') + '/'
  return {
    cMapUrl: base + PDF_CMAP_DIR + '/',
    cMapPacked: true,
    standardFontDataUrl: base + PDF_STANDARD_FONT_DIR + '/'
  }
}
