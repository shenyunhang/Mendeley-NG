import type { Doc, MetaCandidate } from '../../shared/types'
import { acceptable, norm, ratio } from '../../shared/text'

/**
 * Metadata lookup, the replacement for Mendeley Desktop's "Update Details".
 * GET /metadata would have been the obvious route but is documented as not
 * implemented, so this goes to Crossref and arXiv directly.
 *
 * The matching threshold lives in shared/text.ts next to `ratio`, because
 * duplicate detection has to agree with it.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

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

async function getJson(
  url: string,
  bearer?: string
): Promise<unknown | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': CR_UA,
      Accept: 'application/json'
    }
    if (bearer) headers.Authorization = 'Bearer ' + bearer
    const r = await fetch(url, { headers })
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

const CATALOG_TYPE = new Set([
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
  'newspaper_article'
])

interface CatalogItem {
  title?: string
  type?: string
  authors?: { first_name?: string; last_name?: string }[]
  year?: number
  source?: string
  identifiers?: Record<string, string>
  link?: string
}

/** Mendeley's own catalogue, which has identifiers Crossref does not
 *  (scopus, pui) and a type already in Mendeley's vocabulary.  Only `doi` is
 *  trustworthy here: `?isbn=` and `?pmid=` happily return unrelated records.
 *  The endpoint refuses anonymous callers, so it needs a bearer token. */
async function catalogByDoi(
  doi: string,
  bearer?: string
): Promise<MetaCandidate[]> {
  if (!bearer) return []
  const j = (await getJson(
    `https://api.mendeley.com/catalog?doi=${encodeURIComponent(doi)}&limit=3`,
    bearer
  )) as CatalogItem[] | null
  const out: MetaCandidate[] = []
  for (const it of j ?? []) {
    if (!it.title) continue
    out.push({
      from: 'catalog',
      score: 1,
      title: it.title,
      patch: {
        title: it.title,
        ...(it.authors?.length
          ? {
              authors: it.authors.map((a) => ({
                first_name: a.first_name ?? '',
                last_name: a.last_name ?? ''
              }))
            }
          : {}),
        ...(it.year ? { year: it.year } : {}),
        ...(it.source ? { source: it.source } : {}),
        ...(it.type && CATALOG_TYPE.has(it.type) ? { type: it.type } : {}),
        ...(it.identifiers ? { identifiers: it.identifiers } : {}),
        ...(it.link ? { url: it.link } : {})
      }
    })
  }
  return out
}

/** Fetch one arXiv record by id.  The Atom feed is per-entry, so the title
 *  match that `arxivByTitle` needs is not applied here. */
async function arxivById(id: string): Promise<MetaCandidate[]> {
  const clean = id.replace(/^arXiv:/i, '').replace(/v\d+$/, '')
  let xml: string
  try {
    const r = await fetch(
      `http://export.arxiv.org/api/query?id_list=${encodeURIComponent(clean)}`,
      { headers: { 'User-Agent': UA } }
    )
    if (!r.ok) return []
    xml = await r.text()
  } catch {
    return []
  }
  const entry = xml.split('<entry>')[1]
  if (!entry) return []
  const title = decodeXml((entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim())
  if (!title || /Error/i.test(title)) return []
  const published = entry.match(/<published>([^<]+)<\/published>/)?.[1]
  const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => {
    const parts = m[1].trim().split(/\s+/)
    return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] }
  })
  return [
    {
      from: 'arxiv',
      score: 1,
      title,
      patch: {
        title,
        authors,
        year: published ? Number(published.slice(0, 4)) : undefined,
        type: 'working_paper',
        identifiers: { arxiv: clean }
      }
    }
  ]
}

/** Identifiers Mendeley accepts in `identifiers`.  The catalogue also hands
 *  back pui / sgr / scopus, which are real Mendeley fields, but POST rejects
 *  a body it does not recognise, so anything unknown is dropped here rather
 *  than costing the whole create. */
const IDENT_KEYS = ['doi', 'arxiv', 'pmid', 'isbn', 'issn']

function cleanIdentifiers(raw?: Record<string, string>): Record<string, string> | undefined {
  if (!raw) return undefined
  const out: Record<string, string> = {}
  for (const k of IDENT_KEYS) if (raw[k]) out[k] = raw[k]
  return Object.keys(out).length ? out : undefined
}

/**
 * Both sources for one DOI, merged.  Crossref wins wherever they disagree
 * because the catalogue sentence-cases titles — it turns "Deep Residual
 * Learning" into "Deep residual learning" — while Crossref keeps what the
 * publisher deposited.  The catalogue still contributes the type, already in
 * Mendeley's vocabulary, and the extra identifiers.
 */
async function resolveDoi(
  doi: string,
  bearer?: string
): Promise<MetaCandidate[]> {
  const [cat, cr] = await Promise.all([catalogByDoi(doi, bearer), crossrefByDoi(doi)])
  if (!cat.length) return cr ? [cr] : []
  const merged: Partial<Doc> = { ...cat[0].patch, ...(cr?.patch ?? {}) }
  const ident = cleanIdentifiers({
    ...(cat[0].patch.identifiers ?? {}),
    ...(cr?.patch.identifiers ?? {})
  })
  if (ident) merged.identifiers = ident
  else delete merged.identifiers
  return [
    {
      from: cr ? 'crossref-doi' : 'catalog',
      score: 1,
      title: (merged.title ?? cat[0].title) as string,
      patch: merged
    }
  ]
}

/**
 * Resolve something the user pasted: a DOI, an arXiv id, or a title.
 * arXiv ids never go through /catalog, whose arxiv parameter returns
 * unrelated records; anything else is treated as a title.
 */
export async function resolveIdentifier(
  value: string,
  bearer?: string
): Promise<MetaCandidate[]> {
  const v = value.trim()
  if (!v) return []
  if (/^10\.\d{4,9}\//.test(v) || /^https?:\/\/(dx\.)?doi\.org\//i.test(v)) {
    const doi = v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    return resolveDoi(doi, bearer)
  }
  if (/^(arXiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(v)) return arxivById(v)
  return [...(await crossrefByTitle(v)), ...(await arxivByTitle(v))]
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
