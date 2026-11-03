import type { Doc } from '../../shared/types'

/**
 * Reading a paper's reference list out of the paper.
 *
 * A reader who meets "[3]" in the body has to go to the end of the document,
 * find the third entry, keep it in their head, and come back — and forgets
 * where they were on the way.  It is the most frequent interruption in
 * reading a paper, and it is the one every other tool on this desk already
 * answers by putting the entry under the pointer.
 *
 * The whole thing is deliberately narrow, because a popover that names the
 * wrong paper is worse than no popover: the reader is sent to a paper they
 * did not ask about and has no reason to doubt.  So
 *
 *   - only `[n]` counts as an entry.  It is what the overwhelming majority of
 *     papers in a scientific library actually print, and `1.` at the start of
 *     a line is far too easy to find in an ordinary numbered list;
 *   - the numbers have to run consecutively, and there have to be at least
 *     three of them, before any of it is believed;
 *   - and a marker whose numbers are not in the list is left alone.
 *
 * Anything that cannot be pinned down gets nothing at all.
 */

/** A line that is nothing but the heading over the list. */
const HEAD = /^\s*(references|bibliography|reference|literature cited|works cited|参考文献)\s*:?\s*$/i

/**
 * How an entry opens.
 *
 * Brackets are the IEEE / Nature house style and `12.` is the Springer one,
 * which is what every CVPR, ICCV and ECCV paper in a vision library is set
 * in; refusing the second loses about half the papers.  The dot is only
 * taken when what follows it is not another digit, so `1.5` in a numbered
 * appendix does not become an entry.
 */
const ENTRY = /^\s*(?:[\[(]\s*(\d{1,3})\s*[\])]|(\d{1,3})\.(?!\d))\s+/

/** A marker in the body: `[3]`, `[2, 5]`, `[1-3]`, `(4)`. */
const MARKER = /^[\[(]\s*(\d{1,3})(?:\s*[-,–]\s*(\d{1,3}))?(?:\s*,\s*(\d{1,3}))*\s*[\])]$/

export function isRefHead(line: string): boolean {
  return HEAD.test(line.trim())
}

/** The number a line opens with, or null when it opens with something else. */
export function entryNo(line: string): number | null {
  const m = ENTRY.exec(line)
  if (!m) return null
  return Number(m[1] ?? m[2])
}

/**
 * Whether a line reads like a reference rather than like an item in some
 * other numbered list.
 *
 * A year is what gives it away: an appendix that numbers its steps also
 * starts lines with `1.`, and the only thing separating the two is that one
 * of them cites a paper that was published in some year.
 */
const YEAR = /\b(?:1[89]|20)\d{2}\b/
export function looksLikeRef(s: string): boolean {
  return YEAR.test(s) || /\bet al\.|\bpp\.\b|\bIn\s+(?:Proc|CVPR|ICCV|ECCV|NIPS|NeurIPS|ICML|ICLR|ACL)/.test(s)
}

/**
 * The numbers one marker cites.
 *
 * `[1-3]` counts as the three papers it stands for, because that is what the
 * reader is looking at it for.  Anything larger than a handful is left alone:
 * a range that long is a review's way of saying "many", and listing forty
 * entries under the pointer helps nobody.
 */
export function citeNums(s: string): number[] | null {
  const t = s.trim()
  const m = MARKER.exec(t)
  if (!m) return null
  const out: number[] = []
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : 0
  if (b && b > a) {
    if (b - a > 12) return null
    for (let i = a; i <= b; i++) out.push(i)
  } else out.push(a)
  // the tail of `[1, 4, 7]` beyond the first two
  const rest = t.slice(m[0].indexOf(m[3] ?? '') >= 0 ? m[0].indexOf(m[3] ?? '') : m[0].length)
  for (const part of rest.split(/[\s,\[\]()]+/)) {
    const v = Number(part)
    if (part && Number.isFinite(v) && v > 0 && !out.includes(v)) out.push(v)
  }
  return out.length ? out : null
}

/** A marker anywhere in a line of body text: `[3]`, `[2, 5]`, `(1-3)`. */
const MARK_SRC = String.raw`[\[(]\s*\d{1,3}(?:\s*[-,–]\s*\d{1,3})?(?:\s*,\s*\d{1,3})*\s*[\])]`

/** One marker found in a line: where it is, and what it cites. */
export interface CiteSpot {
  at: number
  end: number
  nums: number[]
}

/**
 * Every marker in a line of body text.
 *
 * A marker is found anywhere in the line rather than at the start of it,
 * because that is where a citation is written: "as shown in [3]".
 */
export function markersIn(text: string): CiteSpot[] {
  const re = new RegExp(MARK_SRC, 'g')
  const out: CiteSpot[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const nums = citeNums(m[0])
    if (nums) out.push({ at: m.index, end: m.index + m[0].length, nums })
  }
  return out
}

/**
 * The entries, keyed by number.
 *
 * `lines` is one paper's reference section in reading order, already joined
 * into lines.  The map comes back empty whenever the section cannot be read
 * with confidence, which is the caller's signal to offer nothing.
 *
 * Lines are joined back into one string the way the eye reads them: a break
 * after a hyphen is a word split across the column, and every other break is
 * a space.
 */
export function parseRefEntries(lines: string[]): Map<number, string> {
  // where each candidate entry starts
  const at: { n: number; i: number }[] = []
  lines.forEach((l, i) => {
    const n = entryNo(l)
    if (n != null) at.push({ n, i })
  })
  if (at.length < 3) return new Map()
  // only a consecutive run is believed, and it is the run the list starts
  // with: a stray `[7]` in the middle of an appendix is not an entry
  let best: { n: number; i: number }[] = []
  let cur: { n: number; i: number }[] = [at[0]]
  for (let k = 1; k < at.length; k++) {
    // consecutive, and measured to matter: allowing gaps instead — for a
    // list that might have skipped a number — changed nothing at all over
    // thirty-five papers, so the looser rule bought no coverage and only
    // gave a numbered appendix more ways in
    if (at[k].n === cur[cur.length - 1].n + 1) cur.push(at[k])
    else {
      if (cur.length > best.length) best = cur
      cur = [at[k]]
    }
  }
  if (cur.length > best.length) best = cur
  if (best.length < 3) return new Map()

  // and it has to actually be a reference list: a run of numbered lines with
  // no year and no author among them is an appendix numbering its steps
  const span = (a: number, b: number) => lines.slice(a, b).join(' ')
  const refs = best.filter((e, k) =>
    looksLikeRef(span(e.i, k + 1 < best.length ? best[k + 1].i : lines.length))
  )
  if (refs.length * 2 < best.length) return new Map()

  const join = (from: number, to: number) => {
    let s = ''
    for (let i = from; i < to; i++) {
      const l = lines[i].replace(ENTRY, '').trim()
      if (!l) continue
      s += s && !/[-\u2010\u2011]$/.test(s) ? ' ' + l : l
    }
    return s.replace(/\s+/g, ' ').trim()
  }

  const out = new Map<number, string>()
  best.forEach((e, k) => {
    const end = k + 1 < best.length ? best[k + 1].i : lines.length
    const text = join(e.i, end)
    if (text.length > 12) out.set(e.n, text)
  })
  return out
}

/* ---------- one page, as lines ---------- */

/** One line of a page: the words, and where every character came from. */
export interface RefLine {
  text: string
  /** One entry per character of `text`: which run of the page it is in, and
   *  which character of that run.  A character that was put in by this module
   *  rather than read out of the page has `run: -1`, and covers nothing. */
  map: { run: number; at: number }[]
}

/** Runs whose baselines are this close together are one line. */
const LINE_Y = 2

/**
 * Whether two runs that touch are one word.
 *
 * pdf.js hands a line over in as many runs as it has font changes, so
 * "Back" and "propagation" arrive separately and so do "[" and "3]".  The
 * first wants a space between them and the second does not — and the second
 * is the one that matters here, because a marker split across two runs is
 * still one marker.
 *
 * So a space is only put in where it cannot break a marker: between two word
 * characters, or after the punctuation that ends a sentence.  A hyphen is
 * left alone as well, since a word broken across a column ends with one.
 */
function wantsSpace(a: string, b: string): boolean {
  if (!a || !b) return false
  if (/\s$/.test(a) || /^\s/.test(b)) return false
  if (/[-‐‑]$/.test(a)) return false
  if (/[.,;:]$/.test(a) && /^[A-Za-zÀ-ÿ]/.test(b)) return true
  return /\w$/.test(a) && /^\w/.test(b)
}

/**
 * A page's runs, grouped into lines the way the eye reads them.
 *
 * Runs are grouped by baseline and then read left to right: pdf.js emits them
 * in the order the glyphs are drawn, which on a two-column page is not always
 * the order they are read in.
 */
export function linesOf(items: { str?: string; transform?: number[] }[]): RefLine[] {
  const rows: { y: number; i: number }[] = []
  items.forEach((it, i) => {
    if (it.str && it.transform) rows.push({ y: it.transform[5], i })
  })
  const groups: number[][] = []
  let y = NaN
  for (const r of rows) {
    if (!groups.length || Math.abs(r.y - y) > LINE_Y) {
      groups.push([])
      y = r.y
    }
    groups[groups.length - 1].push(r.i)
  }
  const out: RefLine[] = []
  for (const g of groups) {
    g.sort((a, b) => (items[a].transform?.[4] ?? 0) - (items[b].transform?.[4] ?? 0))
    let text = ''
    const map: { run: number; at: number }[] = []
    g.forEach((idx, k) => {
      const s = items[idx].str ?? ''
      if (k && wantsSpace(text, s)) {
        text += ' '
        map.push({ run: -1, at: 0 })
      }
      for (let c = 0; c < s.length; c++) {
        text += s[c]
        map.push({ run: idx, at: c })
      }
    })
    if (text.trim()) out.push({ text, map })
  }
  return out
}

/* ---------- which of these is already in the library ---------- */

const DOI = /\b10\.\d{4,9}\/[^\s"'<>,]+/
/**
 * An arXiv id, only when it says it is one.
 *
 * A bare `2103.14030` is not enough: a DOI, a page range and a version number
 * all look like four digits, a dot and five digits, and matching one of those
 * by accident is exactly the kind of wrong answer this file exists to avoid.
 */
const ARXIV = /(?:arxiv\s*:?\s*|abs\/)(\d{4}\.\d{4,5})/i

/** The identifiers a reference entry carries. */
export function refIds(s: string): { doi?: string; arxiv?: string } {
  // a DOI runs into the comma or bracket after it often enough to be worth
  // trimming; the tail of a DOI is never punctuation
  const doi = DOI.exec(s)?.[0]?.replace(/[.,;)\]]+$/, '')
  return { doi: doi || undefined, arxiv: ARXIV.exec(s)?.[1] }
}

const flatDoi = (s?: string | null) => (s ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
const flatAx = (s?: string | null) => (s ?? '').match(/(\d{4}\.\d{4,5})/)?.[1] ?? ''

/**
 * The library's own copy of a reference, or null.
 *
 * Matched on the DOI and the arXiv id and on nothing else.  A title is not
 * usable for this: an entry is authors, title, venue and year in one string,
 * and the part that is the title cannot be cut out of it with the certainty
 * a wrong match would need.  An entry that carries no identifier simply gets
 * no button, which costs a little convenience and no trust.
 */
export function docForRef(docs: Doc[], entry: string): Doc | null {
  const ids = refIds(entry)
  if (!ids.doi && !ids.arxiv) return null
  for (const d of docs) {
    if (ids.doi && flatDoi(d.doi ?? d.identifiers?.doi) === ids.doi.toLowerCase()) return d
    if (ids.arxiv && flatAx(d.arxiv ?? d.identifiers?.arxiv) === ids.arxiv) return d
  }
  return null
}
