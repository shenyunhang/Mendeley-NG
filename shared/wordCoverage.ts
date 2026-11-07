/**
 * Which documents contain every word of a full-text query.
 *
 * The fallback for a multi-word query that has no phrase match used to keep a
 * 32-bit bitmask per document: `1 << w` wraps past 31, and `(1 << 32) - 1`
 * is exactly zero, so a query with 32 or more words could never match
 * anything. A set of word indices has no width limit and says the same thing.
 *
 * Kept out of the index module so the boundary can be checked with 32 and 33
 * fixed words and no PDF, no disk and no timing.
 */
export interface WordOccurrence {
  docId: string
  word: number
  at: number
}

export function docsWithAllWords(
  occurrences: readonly WordOccurrence[],
  wordCount: number
): Map<string, number> {
  const seen = new Map<string, { words: Set<number>; at: number }>()
  for (const o of occurrences) {
    const rec = seen.get(o.docId)
    if (rec) {
      rec.words.add(o.word)
      if (o.at < rec.at) rec.at = o.at
    } else {
      seen.set(o.docId, { words: new Set([o.word]), at: o.at })
    }
  }
  const out = new Map<string, number>()
  for (const [id, rec] of seen) {
    if (rec.words.size === wordCount) out.set(id, rec.at)
  }
  return out
}
