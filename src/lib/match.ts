import type { Doc } from '../../shared/types'

/**
 * Turning a search hit into something the reader can judge.
 *
 * A list of papers that match is only half an answer: the same list comes
 * back for "the word is in the title" and "the word is buried in the
 * abstract", and telling those apart is the whole reason to look.  So every
 * field is searched on its own and the ones that matched are shown as a
 * snippet around the match, with the matched run marked.
 */

/** One stretch of text: either prose or the run that matched. */
export interface Part {
  t: string
  hit: boolean
}

/** A field the query is in, ready to be drawn with the match marked. */
export interface FieldHit {
  label: string
  parts: Part[]
}

/**
 * Split `text` around every occurrence of `q`.
 *
 * Every occurrence, not just the first: a snippet can contain the word two
 * or three times, and marking one of them is how a reader comes to believe
 * the search is approximate.
 */
export function markAll(text: string, q: string): Part[] {
  if (!q) return [{ t: text, hit: false }]
  const needle = q.toLowerCase()
  const hay = text.toLowerCase()
  const out: Part[] = []
  let at = 0
  for (;;) {
    const i = hay.indexOf(needle, at)
    if (i < 0) break
    if (i > at) out.push({ t: text.slice(at, i), hit: false })
    out.push({ t: text.slice(i, i + needle.length), hit: true })
    at = i + needle.length
  }
  if (at < text.length) out.push({ t: text.slice(at), hit: false })
  return out.length ? out : [{ t: text, hit: false }]
}

/**
 * The stretch of `text` around its first match, cut with ellipses, or null
 * when the query is not in this field at all.
 *
 * null is the interesting answer: it is how the caller decides whether a
 * field is worth a line.  Showing every field of every paper, matched or
 * not, buries the one line that explains why this paper is here.
 */
export function snippet(text: string, q: string, lead = 44, trail = 96): Part[] | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat || !q) return null
  const i = flat.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return null
  const from = Math.max(0, i - lead)
  const to = Math.min(flat.length, i + q.length + trail)
  const parts = markAll(flat.slice(from, to), q)
  if (from > 0) parts.unshift({ t: '…', hit: false })
  if (to < flat.length) parts.push({ t: '…', hit: false })
  return parts
}

/**
 * One author, in the two shapes that matter.
 *
 * `short` is what fits on a line — "Zhuang M".  `full` is what the search
 * actually looks at, because the haystack holds given names in full.  A
 * search for "Chun" finds the author whose given name is Chun and then draws
 * them as "… C", where the word they searched for is nowhere to be seen: the
 * card matched and declined to say where.  So the full name is drawn for any
 * author whose match the short form would hide.
 */
interface AuthorName {
  short: string
  full: string
}

function authorNames(d: Doc): AuthorName[] {
  return (d.authors ?? [])
    .map((a) => {
      const last = (a.last_name ?? '').trim()
      const first = (a.first_name ?? '').trim()
      const initials = first
        .split(/[\s.-]+/)
        .filter(Boolean)
        .map((w) => w[0]?.toUpperCase() ?? '')
        .join('')
      return {
        short: last ? `${last} ${initials}`.trim() : initials || first,
        full: `${first} ${last}`.trim() || first
      }
    })
    .filter((a) => a.short || a.full)
}

/**
 * The authors to draw, with the match marked.
 *
 * A paper with twelve authors cannot show twelve names on one line, and
 * showing the first three is the usual answer — but it is the wrong answer
 * when the name somebody searched for is the fourth one.  The card then
 * explains nothing about why the paper is on the list, which is the only
 * thing the card is for.  So when one of the authors matched, the window is
 * drawn around that one instead of around the front of the list.
 */
export function authorParts(d: Doc, q: string): Part[] {
  const all = authorNames(d)
  if (!all.length) return []
  const needle = q.toLowerCase()
  const matched = (a: AuthorName) =>
    !!needle && (a.full.toLowerCase().includes(needle) || a.short.toLowerCase().includes(needle))
  // the short form unless it would swallow the match, in which case the name
  // is worth the extra room
  const draw = (a: AuthorName) =>
    matched(a) && !a.short.toLowerCase().includes(needle) ? a.full : a.short
  const i = all.findIndex(matched)
  if (i < 0) {
    const head = all.slice(0, 3)
    const text = head.map((a) => a.short).join(', ') + (all.length > 3 ? ` 等 ${all.length} 人` : '')
    return markAll(text, q)
  }
  const from = Math.max(0, i - 1)
  const to = Math.min(all.length, i + 3)
  const parts = markAll(all.slice(from, to).map(draw).join(', '), q)
  if (from > 0) parts.unshift({ t: '… ', hit: false })
  if (to < all.length) parts.push({ t: ` 等 ${all.length} 人`, hit: false })
  return parts
}

export interface DocMatch {
  /** The title, with every match marked.  Always drawn. */
  title: Part[]
  /** Always drawn when there is one: a result you cannot tell from the next
   *  one is no use, whatever it matched on. */
  authors: Part[]
  year: string
  source: string
  /** Only the fields the query is actually in. */
  fields: FieldHit[]
}

/**
 * What matched, and where.
 *
 * The title and the authors are drawn whatever happens, because a hit has to
 * be identifiable before it can be useful.  Everything else appears only if
 * the query is in it — which is the difference between "here is why this
 * paper came back" and "here is the paper again".
 */
export function matchDoc(d: Doc, q: string, note?: string): DocMatch {
  const titleText = (d.title ?? '').trim() || '(无标题)'
  const fields: FieldHit[] = []
  const add = (label: string, text?: string | null) => {
    if (!text) return
    const parts = snippet(text, q)
    if (parts) fields.push({ label, parts })
  }
  // in the order a reader reads them: who published it, what it is called in
  // their own library, then the text itself, then what they wrote about it
  add('出处', d.source)
  add('引用键', d.citation_key)
  add('摘要', d.abstract)
  add('关键词', (d.keywords ?? []).join(' · '))
  add('标签', (d.tags ?? []).join(' · '))
  add('笔记', note)
  add('DOI', d.doi ?? d.identifiers?.doi)
  add('arXiv', d.arxiv ?? d.identifiers?.arxiv)
  // in last, and only because it is searched: "类型" is rarely what somebody
  // meant, but a card that matched and shows no mark at all looks broken
  add('类型', d.type)
  return {
    title: markAll(titleText, q),
    authors: authorParts(d, q),
    year: d.year ? String(d.year) : '',
    source: d.source ?? '',
    fields
  }
}
