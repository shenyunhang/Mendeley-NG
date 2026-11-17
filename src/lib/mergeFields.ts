import type { Doc } from '../../shared/types'

/**
 * What a duplicate merge is allowed to change.
 *
 * Merging is the easiest irreversible action to do by accident, so the rule
 * is deliberately one-way: only fields the kept paper is missing are filled,
 * and the losing papers go to the trash rather than being deleted. That rule
 * used to live inside the `onMerge` callback in App.tsx, between a confirm
 * dialog and an undo registration, where no fixed input could be fed to it.
 *
 * This module is pure: it proposes a patch, it does not call the cloud, move
 * anything to the trash, or touch React state.
 */

/** String and list fields that are filled only when the keeper has no value. */
export const MERGE_FIELDS = [
  'abstract',
  'source',
  'publisher',
  'volume',
  'issue',
  'pages',
  'citation_key',
  'keywords',
  'url'
] as const

/** Config and imported records are untyped at the patch boundary. */
export function fieldOf(d: Doc, f: string): unknown {
  return (d as unknown as Record<string, unknown>)[f]
}

/**
 * The smallest patch that fills the keeper's gaps from the losing papers.
 *
 * `identifiers` is handled separately from the string fields because old
 * records kept `doi` and `arxiv` at the top level. When the keeper already
 * has an identifier, the object is still returned unchanged so the caller's
 * undo snapshot describes the same set of keys as the patch it applies.
 */
export function mergeMissingFields(
  keeper: Doc,
  others: Doc[]
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const f of MERGE_FIELDS) {
    if (fieldOf(keeper, f)) continue
    const hit = others.find((o) => fieldOf(o, f))
    if (hit) patch[f] = fieldOf(hit, f)
  }
  if (!keeper.year) {
    const y = others.find((o) => o.year)?.year
    if (y) patch.year = y
  }
  if (!keeper.authors?.length) {
    const a = others.find((o) => o.authors?.length)?.authors
    if (a) patch.authors = a
  }
  const ident = { ...(keeper.identifiers ?? {}) }
  if (!ident.doi) {
    ident.doi = others.map((o) => o.identifiers?.doi ?? o.doi).find(Boolean)
  }
  if (!ident.arxiv) {
    ident.arxiv = others.map((o) => o.identifiers?.arxiv ?? o.arxiv).find(Boolean)
  }
  if (ident.doi || ident.arxiv) patch.identifiers = ident
  return patch
}
