import type { Doc } from '../../shared/types'
import { isSafeExternalUrl } from '../../shared/externalUrl'

/**
 * Where a paper can actually be opened.
 *
 * Mendeley keeps the links it collected when the paper was imported in
 * `websites`. The editable `url` is a different field, and it is empty for
 * most papers imported from arXiv, so a details pane that draws only `url`
 * shows an empty link box on a paper whose source is one click away.
 *
 * Every link here is derived from what the catalogue already knows. Nothing is
 * written back, and the editable field keeps its own meaning: typing into it
 * and pressing save patches `url`, while this list keeps showing the saved
 * record until that save succeeds.
 */
export type DocumentSourceLinkOrigin = 'url' | 'websites' | 'doi' | 'arxiv'

export interface DocumentSourceLink {
  url: string
  /** A short word naming where the link came from. */
  label: string
  origin: DocumentSourceLinkOrigin
}

const ORIGIN_LABEL: Record<DocumentSourceLinkOrigin, string> = {
  url: '链接',
  websites: '来源',
  doi: 'DOI',
  arxiv: 'arXiv'
}

/** DOIs arrive as bare ids, `doi:` strings and full resolver URLs. */
const doiId = (raw: string): string =>
  raw
    .trim()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
    .trim()

/** arXiv ids arrive bare, prefixed with `arXiv:`, or inside abs/pdf URLs. */
const arxivId = (raw: string): string =>
  raw
    .trim()
    .replace(/^(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)/i, '')
    .trim()

/**
 * Sources in the order a reader would try them: a link saved on purpose, the
 * links Mendeley collected, then the resolver URLs implied by the identifiers.
 * Duplicates and anything that is not an http(s) address are left out, so the
 * list never offers a second copy of one address or a scheme the shell refuses.
 */
export function documentSourceLinks(doc: Doc): DocumentSourceLink[] {
  const out: DocumentSourceLink[] = []
  const seen = new Set<string>()
  const add = (raw: unknown, origin: DocumentSourceLinkOrigin) => {
    if (typeof raw !== 'string') return
    const url = raw.trim()
    if (!url || !isSafeExternalUrl(url) || seen.has(url)) return
    seen.add(url)
    out.push({ url, label: ORIGIN_LABEL[origin], origin })
  }

  if (doc.url) add(doc.url, 'url')
  for (const site of doc.websites ?? []) add(site, 'websites')

  const doi = doiId(doc.identifiers?.doi ?? doc.doi ?? '')
  if (doi) add('https://doi.org/' + doi, 'doi')

  const arxiv = arxivId(doc.identifiers?.arxiv ?? doc.arxiv ?? '')
  if (arxiv) add('https://arxiv.org/abs/' + arxiv, 'arxiv')

  return out
}
