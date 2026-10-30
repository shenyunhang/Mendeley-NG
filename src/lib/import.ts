import type { Doc } from '../../shared/types'

/** What a BibTeX / RIS / EndNote record gives us, before it becomes a Doc. */
export interface Entry {
  type: string
  citation_key?: string
  title?: string
  authors: { first_name?: string; last_name?: string }[]
  year?: number
  source?: string
  doi?: string
  isbn?: string
  publisher?: string
  volume?: string
  issue?: string
  pages?: string
  abstract?: string
  keywords?: string[]
  url?: string
}

/** Only these are accepted by POST /documents; anything else is rejected
 *  with "You must provide a valid document type". */
const VALID_TYPES = new Set([
  'journal',
  'conference_proceedings',
  'book',
  'book_section',
  'thesis',
  'report',
  'generic',
  'web_page',
  'working_paper',
  'patent',
  'magazine_article',
  'newspaper_article',
  'computer_program',
  'statute',
  'case',
  'bill',
  'hearing'
])

const BIBTEX_TYPE: Record<string, string> = {
  article: 'journal',
  inproceedings: 'conference_proceedings',
  conference: 'conference_proceedings',
  incollection: 'book_section',
  inbook: 'book_section',
  book: 'book',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  techreport: 'report',
  misc: 'generic',
  online: 'web_page',
  unpublished: 'working_paper'
}

const safeType = (t: string) => (VALID_TYPES.has(t) ? t : 'generic')

/** Strip the LaTeX that actually shows up in exported .bib files.  This is
 *  deliberately shallow: braces and a handful of accents, not a TeX engine. */
function untex(s: string): string {
  return s
    .replace(/\{|\}/g, '')
    .replace(/\\&/g, '&')
    .replace(/\\[cC]\b/g, '')
    .replace(/\\(?:'|`|\^|"|~|=|\.)\{?([a-zA-Z])\}?/g, (_, c: string) => {
      const map: Record<string, string> = {
        a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù',
        A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù'
      }
      return map[c] ?? c
    })
    .replace(/\\o\b/g, 'ø')
    .replace(/\\ss\b/g, 'ß')
    .replace(/--/g, '–')
    .replace(/\\%/g, '%')
    .replace(/\\\$/g, '$')
    .replace(/\\_/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "Doe, Jane and Smith, Alan" -> authors.  BibTeX also allows the
 *  "Jane Doe" order, so a single word means it was written surname-last. */
function bibAuthors(s: string): Entry['authors'] {
  return s
    .split(/\s+and\s+/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (p.includes(',')) {
        const [last, first] = p.split(',').map((x) => x.trim())
        return { last_name: untex(last), first_name: untex(first ?? '') }
      }
      const parts = p.split(/\s+/)
      return {
        last_name: untex(parts[parts.length - 1] ?? ''),
        first_name: untex(parts.slice(0, -1).join(' '))
      }
    })
    .filter((a) => a.last_name)
}

/** Split one @entry{...} body into fields, honouring nested braces so that
 *  titles containing commas survive. */
function bibFields(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  let depth = 0
  let key = ''
  let val = ''
  let inKey = true
  const flush = () => {
    if (key) out[key.trim().toLowerCase()] = untex(val)
    key = ''
    val = ''
    inKey = true
  }
  for (const ch of body) {
    if (inKey) {
      if (ch === '=') inKey = false
      else key += ch
      continue
    }
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (ch === ',' && depth === 0) {
      flush()
      continue
    }
    val += ch
  }
  flush()
  return out
}

export function parseBibtex(text: string): Entry[] {
  const out: Entry[] = []
  const re = /@(\w+)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const kind = m[1].toLowerCase()
    let i = re.lastIndex
    let depth = 1
    const start = i
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
      i++
    }
    const body = text.slice(start, i - 1)
    const comma = body.indexOf(',')
    const key = comma >= 0 ? body.slice(0, comma).trim() : ''
    const f = bibFields(comma >= 0 ? body.slice(comma + 1) : body)
    const year = parseInt((f.year ?? '').match(/\d{4}/)?.[0] ?? '', 10)
    out.push({
      type: safeType(BIBTEX_TYPE[kind] ?? 'generic'),
      citation_key: key || undefined,
      title: f.title,
      authors: bibAuthors(f.author ?? ''),
      year: Number.isFinite(year) ? year : undefined,
      source: f.journal || f.booktitle || f.series,
      doi: f.doi,
      isbn: f.isbn,
      publisher: f.publisher || f.organization || f.institution || f.school,
      volume: f.volume,
      issue: f.number,
      pages: f.pages?.replace(/-+/g, '–'),
      abstract: f.abstract,
      keywords: f.keywords
        ? f.keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean)
        : undefined,
      url: f.url || f.link
    })
  }
  return out
}

const RIS_TYPE: Record<string, string> = {
  JOUR: 'journal',
  ELEC: 'web_page',
  CONF: 'conference_proceedings',
  CPAPER: 'conference_proceedings',
  BOOK: 'book',
  CHAP: 'book_section',
  THES: 'thesis',
  RPRT: 'report',
  GEN: 'generic',
  MISC: 'generic',
  COMP: 'computer_program',
  PAT: 'patent',
  MGZN: 'magazine_article',
  NEWS: 'newspaper_article',
  WP: 'working_paper'
}

export function parseRis(text: string): Entry[] {
  const out: Entry[] = []
  let cur: Entry | null = null
  const push = () => {
    if (cur && (cur.title || cur.authors.length || cur.doi)) out.push(cur)
    cur = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^([A-Z][A-Z0-9])\s{0,2}-\s?(.*)$/)
    if (!m) continue
    const tag = m[1]
    const v = m[2].trim()
    if (tag === 'TY') {
      push()
      cur = {
        type: safeType(RIS_TYPE[v.replace(/^\[|\]$/g, '').toUpperCase()] ?? 'generic'),
        authors: []
      }
      continue
    }
    if (tag === 'ER') {
      push()
      continue
    }
    if (!cur) continue
    switch (tag) {
      case 'TI':
      case 'T1':
        cur.title = cur.title ? cur.title + ' ' + v : v
        break
      case 'AU':
      case 'A1': {
        const parts = v.split(',')
        cur.authors.push(
          parts.length > 1
            ? { last_name: parts[0].trim(), first_name: parts.slice(1).join(',').trim() }
            : (() => {
                const p = v.split(/\s+/)
                return { last_name: p[p.length - 1], first_name: p.slice(0, -1).join(' ') }
              })()
        )
        break
      }
      case 'PY':
      case 'Y1': {
        const y = parseInt(v.match(/\d{4}/)?.[0] ?? '', 10)
        if (Number.isFinite(y)) cur.year = y
        break
      }
      case 'JO':
      case 'JF':
      case 'T2':
        cur.source = v
        break
      case 'DO':
        cur.doi = v
        break
      case 'SN':
        cur.isbn = v
        break
      case 'PB':
        cur.publisher = v
        break
      case 'VL':
        cur.volume = v
        break
      case 'IS':
        cur.issue = v
        break
      case 'SP':
        cur.pages = cur.pages ? cur.pages + '–' + v : v
        break
      case 'EP':
        cur.pages = cur.pages ? cur.pages + '–' + v : v
        break
      case 'AB':
      case 'N2':
        cur.abstract = cur.abstract ? cur.abstract + ' ' + v : v
        break
      case 'KW':
        cur.keywords = [...(cur.keywords ?? []), v]
        break
      case 'UR':
        cur.url = v
        break
      case 'ID':
        cur.citation_key = v
        break
    }
  }
  push()
  return out
}

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
  'Computer Program': 'computer_program'
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
