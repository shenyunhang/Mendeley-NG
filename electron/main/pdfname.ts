import { DEFAULT_PDF_TEMPLATE } from '../../shared/types'
import type { Doc } from '../../shared/types'

/** Placeholders a naming template can use.  Kept next to the function that
 *  expands them so the two cannot drift apart. */
export const PDF_NAME_FIELDS = ['title', 'year', 'authors', 'journal', 'key', 'type', 'doi']

/** Name a downloaded PDF from a template.  Segments left empty by a missing
 *  field are dropped rather than leaving a run of dangling separators, so
 *  `{authors} - {year} - {title}` on a paper with no year does not produce
 *  "Knuth -  - On writing". */
export function pdfNameFor(
  doc: Doc | undefined,
  fallback?: string,
  template: string = DEFAULT_PDF_TEMPLATE
): string {
  const safe = (s: string) =>
    (s || '')
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

  /** Windows device names are not legal file basenames, with or without an
   *  extension. Control characters make fs.writeFileSync fail on the same
   *  platform, after the cloud document has already been created. */
  const reserved = (s: string) => /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s)
  const author = (() => {
    const a = doc?.authors?.[0]
    if (!a) return ''
    const first = a.last_name || a.first_name || ''
    if (!first) return ''
    return doc!.authors!.length > 1 ? `${first} et al.` : first
  })()
  const vals: Record<string, string> = {
    title: safe(doc?.title ?? ''),
    year: doc?.year ? String(doc.year) : '',
    authors: author,
    journal: safe(doc?.source ?? ''),
    key: safe(doc?.citation_key ?? ''),
    type: safe(doc?.type ?? ''),
    doi: safe(doc?.identifiers?.doi ?? doc?.doi ?? '')
  }
  // Split the template, not the expanded value: splitting afterwards also
  // cut a title like "State-of-the-art survey" into five segments and
  // rejoined it with spaces, silently rewriting the title. Empty segments
  // from missing fields are dropped before the pieces are put back.
  const parts = template
    .split(/\s*-\s*/)
    .map((seg) => safe(seg.replace(/\{(\w+)\}/g, (_, k: string) => vals[k] ?? '')))
    .filter(Boolean)
  const fallbackBase = safe((fallback || '').replace(/\.pdf$/i, ''))
  let base = safe(parts.join(' - ') || fallbackBase || 'download')
  if (reserved(base)) base = '_' + base
  return (base.slice(0, 150) || 'download') + '.pdf'
}
