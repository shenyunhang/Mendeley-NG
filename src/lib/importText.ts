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

export const safeType = (t: string) => (VALID_TYPES.has(t) ? t : 'generic')

/** Strip the LaTeX that actually shows up in exported .bib files.  This is
 *  deliberately shallow: braces and a handful of accents, not a TeX engine. */
function untex(s: string): string {
  return s
    // An escaped brace in a value is a literal character, not a grouping
    // delimiter. Hide it behind sentinels before the grouping braces are
    // stripped, then put the character back. An escaped backslash gets its
    // own sentinel and is restored last, so none of the LaTeX rules below
    // can mistake it for the start of an accent command.
    .replace(/\\([{}\\])/g, (_, c: string) =>
      c === '{' ? '\u0001' : c === '}' ? '\u0002' : '\u0003'
    )
    .replace(/\{|\}/g, '')
    .replace(/\u0001/g, '{')
    .replace(/\u0002/g, '}')
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
    .replace(/\u0003/g, '\\')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A brace is escaped only when an odd number of backslashes precede it.
 *  Checking just the previous character is wrong for a value ending in a
 *  literal backslash: `\\}` looks escaped, the closing brace is never
 *  counted, and the whole record swallows everything after it. */
function isEscaped(s: string, at: number): boolean {
  let n = 0
  for (let i = at - 1; i >= 0 && s[i] === '\\'; i--) n++
  return n % 2 === 1
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
  let slashes = 0
  for (const ch of body) {
    const escaped = slashes % 2 === 1
    if (inKey) {
      if (ch === '=') inKey = false
      else key += ch
    } else {
      if (ch === '{' && !escaped) depth++
      if (ch === '}' && !escaped) depth--
      if (ch === ',' && depth === 0) flush()
      else val += ch
    }
    slashes = ch === '\\' ? slashes + 1 : 0
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
      const ch = text[i]!
      const escaped = isEscaped(text, i)
      if (ch === '{' && !escaped) depth++
      else if (ch === '}' && !escaped) depth--
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

