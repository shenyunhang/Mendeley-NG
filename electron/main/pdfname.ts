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
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
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
  const expanded = safe(template).replace(/\{(\w+)\}/g, (_, k: string) => vals[k] ?? '')
  // split on the separator and drop the empty pieces, then put them back
  const parts = expanded.split(/\s*-\s*/).filter((s) => s.trim())
  const base = safe(parts.join(' - ') || safe(fallback || '') || 'download')
  return (base.slice(0, 150) || 'download') + '.pdf'
}
