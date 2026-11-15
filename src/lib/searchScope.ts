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

/** One rule for the four places that used to spell it out. */
export function normaliseQuery(q: string): string {
  return q.trim().toLowerCase()
}

/** These three use the in-memory haystack; the other two have their own view. */
export function isMetadataScope(scope: SearchScope): boolean {
  return scope === 'all' || scope === 'title' || scope === 'abstract'
}

/**
 * The haystack for one paper in one scope.
 *
 * `all` is deliberately byte-for-byte the old hay() — the saved-search counts,
 * the filter counts and the smoke run all depend on it. A scope that reads a
 * single field must still join and lower-case the same way, or a phrase could
 * start matching across fields it was never meant to touch.
 */
export function scopeHay(d: Doc, scope: SearchScope, note?: string): string {
  if (scope === 'title') return [d.title].join(' ').toLowerCase()
  if (scope === 'abstract') return [d.abstract].join(' ').toLowerCase()
  return [
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
    .join(' ')
    .toLowerCase()
}
