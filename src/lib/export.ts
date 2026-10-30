import type { Doc } from '../../shared/types'

/** EndNote ref-type name and its numeric code, which the desktop importer
 *  still relies on.  The names are the ones import.ts maps back from, so a
 *  file exported here round-trips through the importer unchanged. */
const EN_TYPE: Record<string, [string, number]> = {
  journal: ['Journal Article', 17],
  conference_proceedings: ['Conference Proceedings', 47],
  book: ['Book', 6],
  book_section: ['Book Section', 5],
  thesis: ['Thesis', 32],
  report: ['Report', 30],
  working_paper: ['Working Paper', 34],
  web_page: ['Web Page', 12],
  patent: ['Patent', 25],
  magazine_article: ['Magazine Article', 28],
  newspaper_article: ['Newspaper Article', 21],
  computer_program: ['Computer Program', 3],
  generic: ['Generic', 0]
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const el = (name: string, v?: string | number | null): string =>
  v === undefined || v === null || String(v) === ''
    ? ''
    : `<${name}>${esc(String(v))}</${name}>`

function surnameKey(d: Doc, i: number): string {
  const a = d.authors?.[0]
  const last = (a?.last_name ?? '').replace(/[^A-Za-z]/g, '') || 'anon'
  return last.toLowerCase() + (d.year ?? '') + String.fromCharCode(97 + (i % 26))
}

function authorsFlat(d: Doc): string {
  return (d.authors ?? [])
    .map((a) => [a.first_name, a.last_name].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' and ')
}

/** BibTeX.  A citation_key the user already set is honoured; otherwise we
 *  synthesise one rather than emitting an entry with no key. */
export function toBibtex(docs: Doc[]): string {
  return docs
    .map((d, i) => {
      const key = (d.citation_key || '').trim() || surnameKey(d, i)
      const type = (d.type ?? 'article').toLowerCase()
      const lines = [
        `  title     = {${d.title ?? ''}}`,
        `  author    = {${authorsFlat(d)}}`,
        `  year      = {${d.year ?? ''}}`
      ]
      if (d.source) {
        const f = type === 'article' ? 'journal' : 'booktitle'
        lines.push(`  ${f}      = {${d.source}}`)
      }
      if (d.doi) lines.push(`  doi       = {${d.doi}}`)
      if (d.arxiv) lines.push(`  eprint    = {${d.arxiv}}`)
      if (d.pages) lines.push(`  pages     = {${d.pages}}`)
      if (d.volume) lines.push(`  volume    = {${d.volume}}`)
      if (d.publisher) lines.push(`  publisher = {${d.publisher}}`)
      if (d.url) lines.push(`  url       = {${d.url}}`)
      const t = ['article', 'book', 'inproceedings', 'incollection', 'phdthesis'].includes(type)
        ? type
        : 'misc'
      return `@${t}{${key},\n${lines.join(',\n')}\n}`
    })
    .join('\n\n')
}

export function toRis(docs: Doc[]): string {
  const ty = (d: Doc): string => {
    const t = (d.type ?? '').toLowerCase()
    if (t === 'article') return 'JOUR'
    if (t === 'inproceedings' || t === 'incollection') return 'CONF'
    if (t === 'book') return 'BOOK'
    if (t === 'phdthesis') return 'THES'
    return 'GEN'
  }
  return docs
    .map((d) => {
      const out: string[] = ['TY  - ' + ty(d)]
      if (d.title) out.push('TI  - ' + d.title)
      if (d.abstract) out.push('AB  - ' + d.abstract)
      for (const a of d.authors ?? []) {
        const n = [a.last_name, a.first_name].filter(Boolean).join(', ')
        if (n) out.push('AU  - ' + n)
      }
      if (d.year) out.push('PY  - ' + String(d.year))
      if (d.source) {
        out.push((ty(d) === 'JOUR' ? 'JO  - ' : 'T2  - ') + d.source)
      }
      if (d.doi) out.push('DO  - ' + d.doi)
      if (d.pages) out.push('SP  - ' + d.pages)
      if (d.volume) out.push('VL  - ' + d.volume)
      if (d.issue) out.push('IS  - ' + d.issue)
      if (d.publisher) out.push('PB  - ' + d.publisher)
      if (d.url) out.push('UR  - ' + d.url)
      if (d.citation_key) out.push('ID  - ' + d.citation_key)
      out.push('ER  - ')
      return out.join('\n')
    })
    .join('\n\n')
}

/**
 * EndNote XML.  EndNote's own exporter is the reference here, including the
 * habit of putting one identifier in `electronic-resource-num`, which is the
 * DOI when there is one and the ISBN otherwise — the importer tells them
 * apart by the `10.` prefix.
 */
export function toEndnoteXml(docs: Doc[]): string {
  const records = docs
    .map((d, i) => {
      const [name, code] = EN_TYPE[d.type ?? ''] ?? EN_TYPE.generic
      // only a DOI or an ISBN: the importer reads this one field and tells
      // them apart by the "10." prefix, so an arXiv id here would be imported
      // back as a bogus ISBN
      const ern = d.identifiers?.doi ?? d.doi ?? d.identifiers?.isbn
      const lines = [
        `<ref-type name="${name}">${code}</ref-type>`,
        '<contributors>',
        '<authors>',
        ...(d.authors ?? []).map((a) =>
          el('author', [a.last_name, a.first_name].filter(Boolean).join(', '))
        ),
        '</authors>',
        '</contributors>',
        '<titles>',
        el('title', d.title),
        el('secondary-title', d.source),
        '</titles>',
        el('pages', d.pages),
        el('volume', d.volume),
        el('number', d.issue),
        d.year ? `<dates><year>${d.year}</year></dates>` : '',
        el('publisher', d.publisher),
        el('abstract', d.abstract),
        el('electronic-resource-num', ern),
        d.url ? `<urls><related-urls><url>${esc(d.url)}</url></related-urls></urls>` : '',
        d.keywords?.length
          ? `<keywords>${d.keywords.map((k) => el('keyword', k)).join('')}</keywords>`
          : '',
        // EndNote matches records on this, so an entry without a citation key
        // still needs one or the import silently drops it
        el('ref-id', (d.citation_key || '').trim() || surnameKey(d, i))
      ].filter(Boolean)
      return `  <record>\n${lines.map((l) => '    ' + l).join('\n')}\n  </record>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xml>\n<records>\n${records}\n</records>\n</xml>\n`
}
