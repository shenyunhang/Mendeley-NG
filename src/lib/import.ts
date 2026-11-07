import type { Doc } from '../../shared/types'
import { parseBibtex, parseRis, safeType } from './importText'
import type { Entry } from './importText'
export type { Entry } from './importText'
export { parseBibtex, parseRis } from './importText'

/** The text formats are parsed in importText.ts, which has no DOM in it,
 *  so the main-process smoke run can check a BibTeX round trip without
 *  pulling DOMParser into its compilation. This file keeps the EndNote
 *  XML reader, which does need a document object, and the glue that picks
 *  a format. */
const ENDNOTE_TYPE: Record<string, string> = {
  'Journal Article': 'journal',
  'Conference Paper': 'conference_proceedings',
  'Conference Proceedings': 'conference_proceedings',
  Book: 'book',
  'Book Section': 'book_section',
  Thesis: 'thesis',
  Report: 'report',
  'Electronic Source': 'web_page',
  'Web Page': 'web_page',
  Patent: 'patent',
  'Magazine Article': 'magazine_article',
  'Newspaper Article': 'newspaper_article',
  'Computer Program': 'computer_program',
  // the two export.ts writes that had no reverse mapping, which made a
  // round trip through EndNote XML lose the type
  'Working Paper': 'working_paper',
  Generic: 'generic'
}

/** EndNote XML.  The schema is loose, so every field is optional and looked
 *  up by tag name rather than by path. */
export function parseEndnoteXml(text: string): Entry[] {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml')
  } catch {
    return []
  }
  if (doc.getElementsByTagName('parsererror').length) return []
  const out: Entry[] = []
  for (const rec of Array.from(doc.getElementsByTagName('record'))) {
    const text = (tag: string) =>
      rec.getElementsByTagName(tag)[0]?.textContent?.trim() || undefined
    const refType =
      rec.getElementsByTagName('ref-type')[0]?.getAttribute('name') ??
      text('ref-type') ??
      ''
    const authors = Array.from(rec.getElementsByTagName('author')).map((a) => {
      const full = (a.textContent ?? '').trim()
      const parts = full.split(',')
      return parts.length > 1
        ? { last_name: parts[0].trim(), first_name: parts.slice(1).join(',').trim() }
        : (() => {
            const p = full.split(/\s+/)
            return { last_name: p[p.length - 1], first_name: p.slice(0, -1).join(' ') }
          })()
    })
    const year = parseInt(
      rec.getElementsByTagName('year')[0]?.textContent?.match(/\d{4}/)?.[0] ?? '',
      10
    )
    const keywords = Array.from(rec.getElementsByTagName('keyword'))
      .map((k) => (k.textContent ?? '').trim())
      .filter(Boolean)
    const ern = text('electronic-resource-num')
    out.push({
      type: safeType(ENDNOTE_TYPE[refType] ?? 'generic'),
      citation_key: text('ref-id') ?? rec.getElementsByTagName('ref-number')[0]?.textContent?.trim(),
      title: text('title'),
      authors,
      year: Number.isFinite(year) ? year : undefined,
      source: text('secondary-title') ?? text('title-secondary'),
      doi: ern && /^10\./.test(ern) ? ern : undefined,
      isbn: ern && !/^10\./.test(ern) ? ern : undefined,
      publisher: text('publisher'),
      volume: text('volume'),
      issue: text('number'),
      pages: text('pages'),
      abstract: text('abstract'),
      keywords: keywords.length ? keywords : undefined,
      url: text('web-url') ?? text('url')
    })
  }
  return out
}

/** Sniff the format from the contents; file extensions are unreliable
 *  because EndNote exports .enw, .xml and .txt depending on the version. */
export function parseAny(name: string, text: string): Entry[] {
  if (/^\s*@\w+\s*\{/m.test(text)) return parseBibtex(text)
  if (/^\s*[A-Z][A-Z0-9]\s{0,2}-\s/m.test(text)) return parseRis(text)
  if (text.trimStart().startsWith('<')) return parseEndnoteXml(text)
  if (/\.xml$/i.test(name)) return parseEndnoteXml(text)
  return []
}

/** Turn a parsed entry into the body POST /documents expects. */
export function entryToBody(e: Entry): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: e.type,
    title: e.title ?? '(未命名)'
  }
  if (e.authors.length) body.authors = e.authors
  if (e.year) body.year = e.year
  if (e.source) body.source = e.source
  if (e.publisher) body.publisher = e.publisher
  if (e.volume) body.volume = e.volume
  if (e.issue) body.issue = e.issue
  if (e.pages) body.pages = e.pages
  if (e.abstract) body.abstract = e.abstract
  if (e.keywords?.length) body.keywords = e.keywords
  if (e.url) body.url = e.url
  if (e.citation_key) body.citation_key = e.citation_key
  const identifiers: Record<string, string> = {}
  if (e.doi) identifiers.doi = e.doi
  if (e.isbn) identifiers.isbn = e.isbn
  if (Object.keys(identifiers).length) body.identifiers = identifiers
  return body
}

/** Is this entry already in the library?  Same rule as duplicate detection. */
export function isDuplicate(e: Entry, docs: Doc[]): boolean {
  const doi = e.doi?.trim().toLowerCase()
  if (doi) return docs.some((d) => (d.identifiers?.doi ?? d.doi ?? '').toLowerCase() === doi)
  const title = (e.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (!title) return false
  return docs.some(
    (d) => (d.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '') === title
  )
}
