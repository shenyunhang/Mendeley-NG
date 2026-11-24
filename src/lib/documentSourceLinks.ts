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
 * Every field is drawn as its own link. Two fields that happen to resolve to
 * the same address are still two entries, because the label says which field
 * each one came from. Nothing is written back: typing into the editable field
 * and pressing save patches `url`, while this list keeps showing the saved
 * record until that save succeeds.
 */
export type DocumentSourceLinkOrigin = 'url' | 'websites' | 'doi' | 'arxiv'

export interface DocumentSourceLink {
  url: string
  /** A short word naming the field the link came from. */
  label: string
  origin: DocumentSourceLinkOrigin
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
 * One entry per field, in catalogue order: `url`, every `websites` entry, the
 * DOI in `identifiers`, a legacy top-level DOI, the arXiv id in `identifiers`,
 * and a legacy top-level arXiv id. Same-address entries are kept rather than
 * collapsed into one. Only the scheme is checked: `file:`, `javascript:` and
 * every other non-http(s) address must never reach the OS shell.
 */
export function documentSourceLinks(doc: Doc): DocumentSourceLink[] {
  const out: DocumentSourceLink[] = []
  const add = (raw: unknown, origin: DocumentSourceLinkOrigin, label: string) => {
    if (typeof raw !== 'string') return
    const url = raw.trim()
    if (!url || !isSafeExternalUrl(url)) return
    out.push({ url, label, origin })
  }

  add(doc.url, 'url', '链接')
  const websites = doc.websites ?? []
  for (let i = 0; i < websites.length; i++) {
    add(websites[i], 'websites', `来源 ${i + 1}`)
  }

  const identifierDoi = doc.identifiers?.doi
  if (identifierDoi) {
    const id = doiId(identifierDoi)
    if (id) add('https://doi.org/' + id, 'doi', 'DOI')
  }
  if (doc.doi) {
    const id = doiId(doc.doi)
    if (id) add('https://doi.org/' + id, 'doi', 'DOI（顶层）')
  }

  const identifierArxiv = doc.identifiers?.arxiv
  if (identifierArxiv) {
    const id = arxivId(identifierArxiv)
    if (id) add('https://arxiv.org/abs/' + id, 'arxiv', 'arXiv')
  }
  if (doc.arxiv) {
    const id = arxivId(doc.arxiv)
    if (id) add('https://arxiv.org/abs/' + id, 'arxiv', 'arXiv（顶层）')
  }

  return out
}
