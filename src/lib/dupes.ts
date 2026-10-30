import type { Doc } from '../../shared/types'
import { norm, ratio } from '../../shared/text'

export interface DupeGroup {
  key: string
  reason: 'doi' | 'arxiv' | 'title'
  docs: Doc[]
}

const completeness = (d: Doc) =>
  [
    d.title,
    d.abstract,
    d.source,
    d.year,
    d.doi ?? d.identifiers?.doi,
    d.publisher,
    d.volume,
    d.issue,
    d.pages,
    d.citation_key,
    d.authors?.length ? 1 : 0,
    d.keywords?.length ? 1 : 0
  ].filter((x) => x !== undefined && x !== null && x !== '').length

/** Which one to keep: most complete record wins, and having the PDF on disk
 *  breaks ties, because that is the copy worth reading. */
export function pickKeeper(docs: Doc[]): Doc {
  return [...docs].sort((a, b) => {
    const c = completeness(b) - completeness(a)
    if (c) return c
    return (b.localPdf ? 1 : 0) - (a.localPdf ? 1 : 0)
  })[0]
}

/**
 * Group duplicates.  DOI and arXiv ids are exact and therefore conclusive;
 * titles are grouped by the same rule the metadata lookup uses, so a pair the
 * lookup would refuse to match never shows up here either.
 */
export function findDuplicates(docs: Doc[]): DupeGroup[] {
  const groups = new Map<string, DupeGroup>()
  const add = (key: string, reason: DupeGroup['reason'], d: Doc) => {
    const g = groups.get(key)
    if (g) g.docs.push(d)
    else groups.set(key, { key, reason, docs: [d] })
  }
  for (const d of docs) {
    const doi = (d.identifiers?.doi ?? d.doi ?? '').trim().toLowerCase()
    const arxiv = (d.identifiers?.arxiv ?? d.arxiv ?? '').trim().toLowerCase()
    if (doi) add('doi:' + doi, 'doi', d)
    else if (arxiv) add('arxiv:' + arxiv, 'arxiv', d)
    else if (d.title) add('title:' + norm(d.title), 'title', d)
  }
  // exact keys first, then fuzzy titles within the same year, which catches
  // the "same paper, punctuation differs" case
  const exact = [...groups.values()].filter((g) => g.docs.length > 1)
  const titled = [...groups.values()].filter((g) => g.reason === 'title' && g.docs.length === 1)
  const byYear = new Map<number, Doc[]>()
  for (const g of titled) {
    const d = g.docs[0]
    const y = d.year ?? 0
    const arr = byYear.get(y) ?? []
    arr.push(d)
    byYear.set(y, arr)
  }
  const fuzzy: DupeGroup[] = []
  for (const [year, list] of byYear) {
    const used = new Set<string>()
    for (let i = 0; i < list.length; i++) {
      if (used.has(list[i].id)) continue
      const cluster = [list[i]]
      used.add(list[i].id)
      for (let j = i + 1; j < list.length; j++) {
        if (used.has(list[j].id)) continue
        if (ratio(list[i].title ?? '', list[j].title ?? '') >= 0.9) {
          cluster.push(list[j])
          used.add(list[j].id)
        }
      }
      if (cluster.length > 1) {
        fuzzy.push({ key: `fuzzy:${norm(cluster[0].title ?? '')}:${year}`, reason: 'title', docs: cluster })
      }
    }
  }
  return [...exact, ...fuzzy].sort((a, b) => b.docs.length - a.docs.length)
}
