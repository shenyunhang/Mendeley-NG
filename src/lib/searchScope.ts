import type { Doc } from '../../shared/types'

/**
 * What a search is allowed to look at.
 *
 * The catalogue used to have one haystack: every field of a paper joined into
 * one string. Asking "only the title" or "only the abstract" is a different
 * question from "anywhere", but it is still the same in-memory table, so the
 * rule belongs here rather than in App where the old hay() lived inline.
 *
 * `body` and `references` are answered by their own views and their own
 * indexes, not by this haystack. They are kept in the same enum so the
 * selector has one value to hold, but they never narrow the document table.
 */
export type SearchScope = 'all' | 'title' | 'abstract' | 'body' | 'references'

export const SEARCH_SCOPES: SearchScope[] = [
  'all',
  'title',
  'abstract',
  'body',
  'references'
]

export const SCOPE_LABEL: Record<SearchScope, string> = {
  all: '全部字段',
  title: '仅标题',
  abstract: '仅摘要',
  body: 'PDF 正文',
  references: '参考文献'
}

/** Config and saved data are untyped at the process boundary. */
export function isSearchScope(v: unknown): v is SearchScope {
  return typeof v === 'string' && (SEARCH_SCOPES as string[]).includes(v)
}

/** One rule for every place a search term is compared with text.
 *
 *  Folding whitespace is not cosmetic: the bibliography haystack joins fields
 *  with single spaces, the references index stores folded text, and the
 *  full-text index folds the query too. Without it a term typed with two
 *  spaces matches in one scope and returns nothing in another.
 */
export function normaliseQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The shortest word worth walking a whole PDF for. Finding inside a paper
 * asks pdf.js for every page's text, so a one-character term would scan an
 * entire document for thousands of hits. The references index answers from a
 * small in-memory table instead and deliberately allows one character for
 * Chinese queries; the two thresholds are different on purpose.
 */
export const MIN_FIND_QUERY_LENGTH = 2

/** These three use the in-memory haystack; the other two have their own view. */
export function isMetadataScope(scope: SearchScope): boolean {
  return scope === 'all' || scope === 'title' || scope === 'abstract'
}

/**
 * The haystack for one paper in one scope.
 *
 * Every scope returns text normalised the same way as the query. `all` used
 * to be byte-for-byte the old hay(); it is now that string with whitespace
 * folded, which is strictly more permissive: a term with two spaces used to
 * miss a field that contained two spaces, while the references scope found
 * it. A scope that reads one field must use the identical normalisation, or a
 * phrase could start matching across fields it was never meant to touch.
 */
export function scopeHay(d: Doc, scope: SearchScope, note?: string): string {
  const parts =
    scope === 'title'
      ? [d.title]
      : scope === 'abstract'
        ? [d.abstract]
        : [
            d.title,
            d.source,
            d.citation_key,
            d.doi,
            d.abstract,
            d.type,
            (d.authors ?? []).map((a) => `${a.first_name ?? ''} ${a.last_name ?? ''}`).join(' '),
            (d.keywords ?? []).join(' '),
            (d.tags ?? []).join(' '),
            note ?? ''
          ]
  return normaliseQuery(parts.join(' '))
}
