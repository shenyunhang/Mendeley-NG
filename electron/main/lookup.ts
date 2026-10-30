import type { Doc, MetaCandidate } from '../../shared/types'

/**
 * Metadata lookup, the replacement for Mendeley Desktop's "Update Details".
 * GET /metadata would have been the obvious route but is documented as not
 * implemented, so this goes to Crossref and arXiv directly.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Anything below this is not a match.  The old project used 0.72 and it was
 *  unusable: "Object detection" against "Lifelong Object Detection" scores
 *  0.78 and is a different paper.  0.90 is the point where false positives
 *  stop showing up in practice, and a miss is far cheaper than a wrong
 *  citation. */
const THRESHOLD = 0.9

/** Substring containment is only trusted on long titles; two short titles
 *  that contain each other are usually different papers. */
const CONTAINS_MIN_LEN = 40

export const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Similarity in 0..1.  Longest-common-subsequence based, like difflib's
 *  ratio, which behaves better than plain Levenshtein on titles where one
 *  version has a subtitle appended. */
export function ratio(a: string, b: string): number {
  const A = norm(a)
  const B = norm(b)
  if (!A || !B) return 0
  if (A === B) return 1
  const n = A.length
  const m = B.length
  // rolling row of the LCS table; titles are short so the O(n*m) is fine
  let prev = new Array(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0)
    for (let j = 1; j <= m; j++) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return (2 * prev[m]) / (n + m)
}

/** Is `cand` the same paper as `title`? */
export function acceptable(title: string, cand: string): boolean {
  const r = ratio(title, cand)
  if (r >= THRESHOLD) return true
  const A = norm(title)
  const B = norm(cand)
  if (A.length < CONTAINS_MIN_LEN || B.length < CONTAINS_MIN_LEN) return false
  return (A.includes(B) || B.includes(A)) && r >= 0.75
}

type Candidate = MetaCandidate

const CROSSREF_TYPE: Record<string, string> = {
  'journal-article': 'journal',
  'proceedings-article': 'conference_proceedings',
  'book': 'book',
  'book-chapter': 'book_section',
  'monograph': 'book',
  'report': 'report',
  'dissertation': 'thesis',
  'posted-content': 'working_paper'
}

interface CrItem {
  DOI?: string
  title?: string[]
  author?: { given?: string; family?: string; name?: string }[]
  issued?: { 'date-parts'?: number[][] }
  'container-title'?: string[]
  publisher?: string
  volume?: string
  issue?: string
  page?: string
  URL?: string
  type?: string
  abstract?: string
}

function fromCrossref(it: CrItem): Partial<Doc> {
  const year = it.issued?.['date-parts']?.[0]?.[0]
  const authors = (it.author ?? [])
    .map((a) => {
      if (a.family || a.given) return { first_name: a.given ?? '', last_name: a.family ?? '' }
      // organisations come through as a single "name"
      const parts = (a.name ?? '').split(/\s+/)
      return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] ?? '' }
    })
    .filter((a) => a.last_name)
  const type = it.type ? CROSSREF_TYPE[it.type] : undefined
  return {
    ...(it.title?.[0] ? { title: it.title[0] } : {}),
    ...(authors.length ? { authors } : {}),
    ...(year ? { year } : {}),
    ...(it['container-title']?.[0] ? { source: it['container-title'][0] } : {}),
    ...(it.publisher ? { publisher: it.publisher } : {}),
    ...(it.volume ? { volume: it.volume } : {}),
    ...(it.issue ? { issue: it.issue } : {}),
    ...(it.page ? { pages: it.page } : {}),
    ...(it.URL ? { url: it.URL } : {}),
    ...(it.DOI ? { identifiers: { doi: it.DOI } } : {}),
    ...(type ? { type } : {})
  }
}

/** Crossref asks callers to identify themselves; without it we share the
 *  anonymous pool and get 429s during any burst of lookups. */
const CR_UA = 'Mendeley-NG/0.1 (https://github.com/shenyunhang/Mendeley-NG)'

async function getJson(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': CR_UA, Accept: 'application/json' }
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

async function crossrefByDoi(doi: string): Promise<Candidate | null> {
  const j = (await getJson(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`
  )) as { message?: CrItem } | null
  if (!j?.message?.title?.[0]) return null
  const patch = fromCrossref(j.message)
  return { from: 'crossref-doi', score: 1, title: patch.title ?? '', patch }
}

async function crossrefByTitle(title: string, year?: number | null): Promise<Candidate[]> {
  const u =
    'https://api.crossref.org/works?rows=5&select=DOI,title,author,issued,container-title,publisher,volume,issue,page,URL,type&query.bibliographic=' +
    encodeURIComponent(title) +
    (year ? '&filter=from-pub-date:' + year + '-01-01,until-pub-date:' + year + '-12-31' : '')
  const j = (await getJson(u)) as { message?: { items?: CrItem[] } } | null
  const out: Candidate[] = []
  for (const it of j?.message?.items ?? []) {
    const t = it.title?.[0] ?? ''
    if (!acceptable(title, t)) continue
    // a near-identical title from the wrong decade is a different paper: a
    // survey or a follow-up sharing the name.  Only trust the year when we
    // already have one and the candidate has one too.
    const y = it.issued?.['date-parts']?.[0]?.[0]
    if (year && y && Math.abs(y - year) > 1) continue
    out.push({ from: 'crossref', score: ratio(title, t), title: t, patch: fromCrossref(it) })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** arXiv has no JSON API, so this parses the Atom feed with regexes.  It only
 *  ever needs title, authors, year and the id, which keeps that safe. */
async function arxivByTitle(title: string): Promise<Candidate[]> {
  const u =
    'http://export.arxiv.org/api/query?max_results=5&search_query=ti:' +
    encodeURIComponent('"' + title + '"')
  let xml: string
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA } })
    if (!r.ok) return []
    xml = await r.text()
  } catch {
    return []
  }
  const entries = xml.split('<entry>').slice(1)
  const out: Candidate[] = []
  for (const e of entries) {
    const t = decodeXml((e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim())
    if (!acceptable(title, t)) continue
    const id = e.match(/<id>http:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/)?.[1]
    const published = e.match(/<published>([^<]+)<\/published>/)?.[1]
    const authors = [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => {
      const parts = m[1].trim().split(/\s+/)
      return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] }
    })
    out.push({
      from: 'arxiv',
      score: ratio(title, t),
      title: t,
      patch: {
        title: t,
        authors,
        year: published ? Number(published.slice(0, 4)) : undefined,
        ...(id ? { identifiers: { arxiv: id.replace(/v\d+$/, '') } } : {})
      }
    })
  }
  return out.sort((a, b) => b.score - a.score)
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Everything worth trying for one document, best first. */
export async function lookup(doc: Doc): Promise<Candidate[]> {
  const out: Candidate[] = []
  const doi = doc.identifiers?.doi ?? doc.doi
  if (doi) {
    const c = await crossrefByDoi(doi)
    if (c) out.push(c)
  }
  if (doc.title) {
    out.push(...(await crossrefByTitle(doc.title, doc.year)))
    out.push(...(await arxivByTitle(doc.title)))
  }
  // dedupe on the title we would end up writing
  const seen = new Set<string>()
  return out
    .filter((c) => {
      const k = norm(c.title)
      if (!k || seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
}
