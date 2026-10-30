import type { Doc } from '../../shared/types'

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
