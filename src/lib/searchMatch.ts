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
 *    The full-text corpus and the cached references hay own their own
 *    offsets, so they match with `wordSpans` / `nearSpans`: the words carry
 *    their real code-unit positions and nothing is rewritten (HANDOFF 8.11).
 */

/** A near match is a fallback for a short mistyped phrase, not a parser.
 *  Beyond this many words the anchor scan costs more than it can return. */
export const MAX_NEAR_WORDS = 8

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

/** The same text with word separators removed, for space-free scripts.
 *  Exported so a caller holding thousands of haystacks can build this form
 *  once per library change instead of once per document per keystroke. */
export function compactForComparison(s: string): string {
  return s.replace(/ /g, '')
}

export function queryTokens(q: string): string[] {
  return foldSeparators(q).split(' ').filter(Boolean)
}

/**
 * One full-text query, split once for every pass that reads it.
 *
 * Three passes look at the same words: the literal phrase (`indexOf`), the
 * coverage pass (every word in one paper) and the near pass (one edit per
 * word). `coverageWords` keeps punctuation inside a token because `qwen3.5`
 * is one name a reader means; `nearWords` folds it because a dot or a hyphen
 * in the PDF must not stop a mistyped phrase from matching. Both lists are
 * made here, so no pass invents its own splitting.
 */
export interface FullTextQueryWords {
  /** Space-separated tokens; punctuation inside a token is kept. */
  coverageWords: string[]
  /** Word-folded tokens; punctuation separates words. */
  nearWords: string[]
}

export function fullTextQueryWords(needle: string): FullTextQueryWords {
  return {
    coverageWords: needle.split(' ').filter(Boolean),
    nearWords: queryTokens(needle)
  }
}

/** A word shorter than this matches the start of a longer word instead of a
 *  whole word. Below it a whole-word rule would make `te` useless (it is
 *  almost never a word on its own), while a substring rule matches the middle
 *  of `attention` in nearly every paper. */
export const SHORT_WORD_LENGTH = 3

const UNICODE_WORD_CHAR = /[\p{L}\p{N}]/u

/** The same character class as `wordSpans`, with a fast ASCII path: the
 *  coverage pass asks this about hundreds of thousands of candidate offsets. */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false
  const code = ch.charCodeAt(0)
  if (code < 128) {
    return (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122)
    )
  }
  return UNICODE_WORD_CHAR.test(ch)
}

/**
 * Whether `word` at `at` begins a word in `text`. Words of
 * `SHORT_WORD_LENGTH` or more must also end there; shorter ones may be the
 * start of a longer word. `text` is the original corpus, so the caller can
 * use `at` as an offset without translating it back from a folded copy.
 */
export function wordBoundaryMatch(text: string, at: number, word: string): boolean {
  if (isWordChar(text[at - 1])) return false
  if (word.length < SHORT_WORD_LENGTH) return true
  return !isWordChar(text[at + word.length])
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

export interface WordSpan {
  /** Lower-cased word, for comparison only. */
  word: string
  /** Offset of the word in the original, unmodified text. */
  at: number
  /** Length of the word in the original text. */
  len: number
}

/**
 * Cut a text into words without rewriting it. Each `at` is a code-unit offset
 * into the exact string passed in, so an index that owns its own offsets (the
 * full-text corpus, the cached references hay) can use the result directly:
 * no folded copy is involved, and `at + len` still describes real text.
 */
export function wordSpans(text: string): WordSpan[] {
  const out: WordSpan[] = []
  const re = /[\p{L}\p{N}]+/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ word: m[0].toLowerCase(), at: m.index, len: m[0].length })
  }
  return out
}

/**
 * The one set of constraints behind a near match, shared by the string form
 * (`matchQuery`) and the offset form (`nearSpans`). Words are in text order.
 * Returns the matching word indexes in query order, or null.
 */
export function matchWords(words: string[], wanted: string[]): number[] | null {
  if (!wanted.length) return null
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
  if (exactWords === 0) return null
  const span = Math.max(...positions) - Math.min(...positions)
  if (span >= wanted.length + 2) return null
  return positions
}

/**
 * Same rule as `matchQuery`, but on a text whose offsets matter. The returned
 * spans point at words that really occur, so `snippetAt(at, len)` and the
 * document/page lookup stay correct even when the query was misspelled.
 */
export function nearSpans(spans: WordSpan[], q: string): WordSpan[] | null {
  const wanted = queryTokens(q)
  if (wanted.length > MAX_NEAR_WORDS) return null
  const positions = matchWords(spans.map((s) => s.word), wanted)
  if (!positions) return null
  return positions.map((i) => spans[i]!)
}

/**
 * The tightest range in the source text covering every matched word.
 *
 * `nearSpans` returns one span per query word, in query order. Cutting a
 * snippet from the first one would drop a word that happened to come earlier
 * in the text (or leave out a later one), and asking `pageOf` about the wrong
 * offset would name the wrong page. Both indexes use this range instead.
 */
export function spanBounds(spans: WordSpan[]): { at: number; len: number } {
  let start = Infinity
  let end = 0
  for (const s of spans) {
    if (s.at < start) start = s.at
    if (s.at + s.len > end) end = s.at + s.len
  }
  if (start === Infinity) return { at: 0, len: 1 }
  return { at: start, len: Math.max(1, end - start) }
}

/**
 * Decide how `hay` answers `q`, which is already normalised by the caller.
 *
 * `foldedHay` may be supplied by callers that precompute it (App builds the
 * folded haystack once per library change); when absent it is computed here.
 * Only the comparison uses the folded copy -- `terms` are always real words
 * taken from the haystack, so marking can find them in the original text.
 *
 * `corpusWords` is the union of the words in every haystack being searched.
 * The word-level fallback insists on `exactWords > 0`, so it cannot succeed
 * for any document when not one query word occurs anywhere in the corpus.
 * Without that check a nonsense word makes every keystroke split all 5700
 * folded haystacks into word arrays and walk every word, for a result that
 * was determined before the first document was opened. Callers searching a
 * single string simply omit it and keep the original behaviour.
 *
 * `compactFoldedHay` is the space-free form of `foldedHay`, which a caller
 * with a prebuilt haystack can cache too. Both optional arguments are pure
 * accelerators: leaving them out computes the same values in place.
 */
export function matchQuery(
  hay: string,
  q: string,
  foldedHay?: string,
  corpusWords?: ReadonlySet<string>,
  compactFoldedHay?: string
): QueryMatch | null {
  if (!q) return null
  if (hay.includes(q)) return { kind: 'exact', terms: [q] }

  const folded = foldedHay ?? foldSeparators(hay)
  const want = foldSeparators(q)
  if (!want) return null
  const wanted = queryTokens(q)
  if (folded.includes(want)) return { kind: 'near', terms: wanted }
  const compactFolded = compactFoldedHay ?? compactForComparison(folded)
  if (compactFolded.includes(compactForComparison(want))) {
    return { kind: 'near', terms: wanted }
  }

  if (corpusWords && !wanted.some((word) => corpusWords.has(word))) return null
  const words = folded.split(' ').filter(Boolean)
  const positions = matchWords(words, wanted)
  if (!positions) return null
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

/** The one predicate behind the list, its counts and saved searches.
 *  `corpusWords` is the optional corpus-wide shortcut described above; a
 *  caller without one (a saved search, a single string) keeps the same
 *  answer, just without the shortcut. */
export function queryMatches(
  hay: string,
  q: string,
  allowNear: boolean,
  foldedHay?: string,
  corpusWords?: ReadonlySet<string>,
  compactFoldedHay?: string
): boolean {
  if (!q) return true
  if (hay.includes(q)) return true
  return allowNear && matchQuery(hay, q, foldedHay, corpusWords, compactFoldedHay)?.kind === 'near'
}

