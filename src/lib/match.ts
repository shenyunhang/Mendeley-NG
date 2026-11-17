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
/** Map an index in the lower-cased haystack back to the source string. Most
 *  characters lower-case one-to-one, but a few (e.g. 'İ') become two code
 *  units, so a hit's length in the haystack is not its length in the source. */
function lowerMap(text: string, hay: string): number[] | null {
  if (hay.length === text.length) return null
  const map: number[] = []
  for (let i = 0; i < text.length && map.length < hay.length; i++) {
    const n = text[i].toLowerCase().length
    for (let k = 0; k < n && map.length < hay.length; k++) map.push(i)
  }
  while (map.length < hay.length) map.push(text.length - 1)
  return map
}

/**
 * Split `text` around every occurrence of any word in `terms`.
 *
 * A near match can hit several different words in the same field (`qwen` and
 * `cua` in "Qwen-CUA"), so marking only the first word would leave a result
 * that says nothing about why it came back. Spans are merged before slicing,
 * which keeps two nearby words from producing overlapping <mark> runs.
 */
export function markAllTerms(text: string, terms: string[]): Part[] {
  const needles = terms.filter(Boolean).map((t) => t.toLowerCase())
  if (!needles.length) return [{ t: text, hit: false }]
  const hay = text.toLowerCase()
  const map = lowerMap(text, hay)
  const startOf = (j: number) => (map ? map[j] : j)
  const endOf = (j: number) => (map ? map[j] + 1 : j + 1)
  const spans: [number, number][] = []
  for (const needle of needles) {
    let at = 0
    for (;;) {
      const i = hay.indexOf(needle, at)
      if (i < 0) break
      spans.push([startOf(i), endOf(i + needle.length - 1)])
      at = i + needle.length
    }
  }
  if (!spans.length) return [{ t: text, hit: false }]
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: [number, number][] = []
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  const out: Part[] = []
  let cursor = 0
  for (const [s, e] of merged) {
    if (s > cursor) out.push({ t: text.slice(cursor, s), hit: false })
    out.push({ t: text.slice(s, e), hit: true })
    cursor = e
  }
  if (cursor < text.length) out.push({ t: text.slice(cursor), hit: false })
  return out.length ? out : [{ t: text, hit: false }]
}

export function markAll(text: string, q: string): Part[] {
  return markAllTerms(text, [q])
}

/**
 * The stretch of `text` around its first match, cut with ellipses, or null
 * when the query is not in this field at all.
 *
 * null is the interesting answer: it is how the caller decides whether a
 * field is worth a line.  Showing every field of every paper, matched or
 * not, buries the one line that explains why this paper is here.
 */
export function snippetTerms(
  text: string,
  terms: string[],
  lead = 44,
  trail = 96
): Part[] | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  const needles = terms.filter(Boolean).map((t) => t.toLowerCase())
  if (!flat || !needles.length) return null
  const hay = flat.toLowerCase()
  let first = -1
  let firstLen = 0
  for (const needle of needles) {
    const i = hay.indexOf(needle)
    if (i >= 0 && (first < 0 || i < first)) {
      first = i
      firstLen = needle.length
    }
  }
  if (first < 0) return null
  const map = lowerMap(flat, hay)
  const hitStart = map ? map[first] : first
  const hitEnd = map ? map[first + firstLen - 1] + 1 : first + firstLen
  const from = Math.max(0, hitStart - lead)
  const to = Math.min(flat.length, hitEnd + trail)
  const parts = markAllTerms(flat.slice(from, to), needles)
  if (from > 0) parts.unshift({ t: '…', hit: false })
  if (to < flat.length) parts.push({ t: '…', hit: false })
  return parts
}

export function snippet(text: string, q: string, lead = 44, trail = 96): Part[] | null {
  return snippetTerms(text, [q], lead, trail)
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
export function authorPartsFor(d: Doc, terms: string[]): Part[] {
  const all = authorNames(d)
  if (!all.length) return []
  const needles = terms.filter(Boolean).map((t) => t.toLowerCase())
  const has = (s: string) => needles.some((n) => s.includes(n))
  const matched = (a: AuthorName) =>
    !!needles.length && (has(a.full.toLowerCase()) || has(a.short.toLowerCase()))
  // the short form unless it would swallow the match, in which case the name
  // is worth the extra room
  const draw = (a: AuthorName) =>
    matched(a) && !has(a.short.toLowerCase()) ? a.full : a.short
  const i = all.findIndex(matched)
  if (i < 0) {
    const head = all.slice(0, 3)
    const text = head.map((a) => a.short).join(', ') + (all.length > 3 ? ` 等 ${all.length} 人` : '')
    return markAllTerms(text, needles)
  }
  const from = Math.max(0, i - 1)
  const to = Math.min(all.length, i + 3)
  const parts = markAllTerms(all.slice(from, to).map(draw).join(', '), needles)
  if (from > 0) parts.unshift({ t: '… ', hit: false })
  if (to < all.length) parts.push({ t: ` 等 ${all.length} 人`, hit: false })
  return parts
}

export function authorParts(d: Doc, q: string): Part[] {
  return authorPartsFor(d, [q])
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
export function matchDoc(d: Doc, q: string, note?: string, terms?: string[]): DocMatch {
  const titleText = (d.title ?? '').trim() || '(无标题)'
  // A near match supplies the words that actually occur in the paper; without
  // them the card would match and then decline to say where.
  const needles = terms && terms.length ? terms : [q]
  const fields: FieldHit[] = []
  const add = (label: string, text?: string | null) => {
    if (!text) return
    const parts = snippetTerms(text, needles)
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
    title: markAllTerms(titleText, needles),
    authors: authorPartsFor(d, needles),
    year: d.year ? String(d.year) : '',
    source: d.source ?? '',
    fields
  }
}
