import type { Author, Doc } from '../../shared/types'
import { toBibtex } from './export'

/**
 * Formatted citations for pasting into a manuscript.
 *
 * The point of this module is the one action a reference manager is used for
 * most often: pick a paper, get a citation, paste.  Exporting a whole BibTeX
 * file and hunting for the entry by hand is what the app used to force.
 */

export type CiteStyle = 'author-year' | 'authors' | 'numeric' | 'full' | 'key' | 'bibtex'

export interface CiteStyleDef {
  key: CiteStyle
  label: string
  /** What a user is supposed to recognise the style by. */
  sample: string
  /** Whether several documents come out as separate lines or as one list. */
  join: 'lines' | 'list'
}

export const CITE_STYLES: CiteStyleDef[] = [
  { key: 'author-year', label: '作者（年份）', sample: 'Smith et al. (2023)', join: 'lines' },
  { key: 'authors', label: '全部作者', sample: 'Smith J, Jones A', join: 'lines' },
  { key: 'numeric', label: '编号', sample: '[1]', join: 'list' },
  { key: 'full', label: '完整条目', sample: 'Smith J, Jones A. Title. Nature, 2023.', join: 'lines' },
  { key: 'key', label: 'BibTeX key', sample: '\\cite{smith2023}', join: 'lines' },
  { key: 'bibtex', label: 'BibTeX 条目', sample: '@article{smith2023, …}', join: 'lines' }
]

export const DEFAULT_CITE_STYLE: CiteStyle = 'author-year'

export const isCiteStyle = (s: unknown): s is CiteStyle =>
  CITE_STYLES.some((c) => c.key === s)

const trim = (s?: string | null) => (s ?? '').trim()

const CJK = /[\u3400-\u9fff]/

const isCjk = (s: string) => CJK.test(s)

/**
 * The name a citation hangs on.  Mendeley splits a name into two fields, and
 * in a Chinese library one of them is routinely empty or a duplicate of the
 * other, so the pair is compared before being joined.
 */
const surname = (a: Author): string => {
  const l = trim(a.last_name)
  const f = trim(a.first_name)
  if (l && f && l !== f) return l
  return l || f
}

/** `Smith J`: the surname and the initials, for a full entry.  Initialising a
 *  Chinese given name would turn 小明 into 小., so those are kept whole. */
const fullName = (a: Author): string => {
  const l = trim(a.last_name)
  const f = trim(a.first_name)
  if (l && f && l !== f) {
    const given = isCjk(f)
      ? f
      : f
          .split(/[\s.\-]+/)
          .filter(Boolean)
          .map((p) => p[0]!.toUpperCase() + '.')
          .join('')
    return `${l} ${given}`
  }
  return l || f
}

/** `Smith` / `Smith and Jones` / `Smith et al.` */
const authorPhrase = (d: Doc): string => {
  const list = (d.authors ?? []).map(surname).filter(Boolean)
  if (!list.length) return 'Anon'
  if (list.length === 1) return list[0]!
  if (list.length === 2) {
    const joint = isCjk(list[0]!) ? '和' : 'and'
    return `${list[0]} ${joint} ${list[1]}`
  }
  return `${list[0]} ${isCjk(list[0]!) ? '等' : 'et al.'}`
}

const allAuthors = (d: Doc): string =>
  (d.authors ?? []).map(fullName).filter(Boolean).join(', ') || 'Anon'

/** A key to fall back on when the document has no citation_key of its own.
 *  Mirrors what the BibTeX export synthesises, so the two agree. */
const syntheticKey = (d: Doc): string => {
  const a = (d.authors ?? [])[0]
  const last = (surname(a ?? {}) || 'anon').replace(/[^A-Za-z\u3400-\u9fff]/g, '') || 'anon'
  return (last.toLowerCase() + (d.year ?? '')) || 'anon'
}

const one = (d: Doc, style: CiteStyle): string => {
  switch (style) {
    case 'author-year':
      return `${authorPhrase(d)} (${d.year ?? 'n.d.'})`
    case 'authors':
      return allAuthors(d)
    case 'full': {
      const bits = [allAuthors(d) + '.']
      if (trim(d.title)) bits.push(trim(d.title) + '.')
      if (trim(d.source)) bits.push(trim(d.source) + ',')
      bits.push(`${d.year ?? 'n.d.'}.`)
      return bits.join(' ')
    }
    case 'key':
      return `\\cite{${trim(d.citation_key) || syntheticKey(d)}}`
    case 'bibtex':
      return toBibtex([d]).trim()
    default:
      return `${authorPhrase(d)} (${d.year ?? 'n.d.'})`
  }
}

/**
 * `docs` in the order the caller wants them: a [n] citation is numbered by
 * position, so the order is part of the output rather than a detail.
 */
export function formatCitation(docs: Doc[], style: CiteStyle = DEFAULT_CITE_STYLE): string {
  if (!docs.length) return ''
  if (style === 'numeric') return docs.map((_, i) => `[${i + 1}]`).join(', ')
  // a BibTeX block is one paragraph per entry, not one line
  if (style === 'bibtex') return docs.map((d) => one(d, style)).join('\n\n')
  return docs.map((d) => one(d, style)).join('\n')
}
