/**
 * How a bibliography field answers a query.
 *
 * `normaliseQuery` stays a pure trim + lower-case + whitespace fold: it is
 * also used to compare DOIs and arXiv ids for exact equality in AddByIdView,
 * so loosening it would merge two different papers. Approximate matching is
 * a separate rule, applied only by callers that search prose.
 *
 * Two things are deliberately kept apart here:
 *  - matching, which may fold punctuation and tolerate one edit;
 *  - offsets into stored text, which must never be taken from a folded copy.
 *    The full-text index and the references index own their own offsets, so
 *    they do not use the near path (see HANDOFF 8.11).
 */

export type MatchKind = 'exact' | 'near'

export interface QueryMatch {
  kind: MatchKind
  /** Words that actually occur in the haystack, for marking the result. */
  terms: string[]
}

/**
 * Letters, digits and CJK characters are content; everything else separates
 * words. Used for comparison only -- the result has no offset relationship
 * with the input, so it must never be used to slice source text.
 */
export function foldSeparators(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** The same text with word separators removed, for space-free scripts. */
function compact(s: string): string {
  return s.replace(/ /g, '')
}

export function queryTokens(q: string): string[] {
  return foldSeparators(q).split(' ').filter(Boolean)
}

/**
 * One word is close enough to another: identical, or a single edit.
 *
 * Words shorter than three characters are never approximated: with `cud`
 * versus `cua` the edit is meaningful, but with `a` versus `b` it would make
 * every short token match everything. A length difference of more than one
 * is not a typo, it is a different word.
 */
export function tokensNear(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length < 3 || b.length < 3) return false
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    let diff = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
    if (diff === 1) return true
    // adjacent transposition, e.g. "cua" typed as "cau"
    for (let i = 0; i + 1 < a.length; i++) {
      if (a[i] === b[i + 1] && a[i + 1] === b[i]) {
        if (a.slice(0, i) + a[i + 1] + a[i] + a.slice(i + 2) === b) return true
      }
    }
    return false
  }
  // one insertion or deletion
  const long = a.length > b.length ? a : b
  const short = a.length > b.length ? b : a
  let i = 0
  let j = 0
  let skipped = false
  while (i < long.length && j < short.length) {
    if (long[i] === short[j]) {
      i++
      j++
    } else {
      if (skipped) return false
      skipped = true
      i++
    }
  }
  return true
}

/**
 * Decide how `hay` answers `q`, which is already normalised by the caller.
 *
 * `foldedHay` may be supplied by callers that precompute it (App builds the
 * folded haystack once per library change); when absent it is computed here.
 * Only the comparison uses the folded copy -- `terms` are always real words
 * taken from the haystack, so marking can find them in the original text.
 */
export function matchQuery(hay: string, q: string, foldedHay?: string): QueryMatch | null {
  if (!q) return null
  if (hay.includes(q)) return { kind: 'exact', terms: [q] }

  const folded = foldedHay ?? foldSeparators(hay)
  const want = foldSeparators(q)
  if (!want) return null
  if (folded.includes(want)) return { kind: 'near', terms: queryTokens(q) }
  if (compact(folded).includes(compact(want))) {
    return { kind: 'near', terms: queryTokens(q) }
  }

  const wanted = queryTokens(q)
  if (!wanted.length) return null
  const words = folded.split(' ').filter(Boolean)
  const positions: number[] = []
  let exactWords = 0
  for (const w of wanted) {
    let at = -1
    for (let i = 0; i < words.length; i++) {
      const h = words[i]!
      if (h === w) {
        at = i
        exactWords++
        break
      }
      // Keep the first near word in case no exact one exists, but keep
      // looking: an exact hit later in the field is the better anchor.
      if (at < 0 && tokensNear(w, h)) at = i
    }
    if (at < 0) return null
    positions.push(at)
  }
  // Every word must be accounted for, and at least one must be exact.
  // Without the second condition a query made entirely of typos would return
  // a list of unrelated papers.
  if (exactWords === 0) return null
  // The words must also be close together. A three-letter word like "cud"
  // is one edit away from dozens of words in a long abstract, so without
  // this check a typo in a two-word title would match every abstract that
  // happens to contain "can" or "cut" somewhere.
  const span = Math.max(...positions) - Math.min(...positions)
  if (span >= wanted.length + 2) return null
  return { kind: 'near', terms: [...new Set(positions.map((i) => words[i]!))] }
}

/**
 * Whether near matching is allowed for this query. It is only used when the
 * library has no exact hit at all, so an ordinary search keeps returning the
 * same papers in the same order, and a typo gets a second chance instead of
 * an empty list.
 */
export function allowNearFor(hays: Iterable<string>, q: string): boolean {
  if (!q) return false
  for (const h of hays) if (h.includes(q)) return false
  return true
}

/** The one predicate behind the list, its counts and saved searches. */
export function queryMatches(hay: string, q: string, allowNear: boolean, foldedHay?: string): boolean {
  if (!q) return true
  if (hay.includes(q)) return true
  return allowNear && matchQuery(hay, q, foldedHay)?.kind === 'near'
}

