import type { Doc } from '../../shared/types'

/**
 * The stem a synthesised citation key is built from.
 *
 * Two callers need the same answer: the `\cite{...}` a reader pastes into a
 * manuscript, and the key of a BibTeX / EndNote entry exported from the same
 * paper. They used to be written out twice, and the second copy kept only
 * ASCII letters, so a Chinese surname produced `\cite{张三2023}` in one place
 * and `anon2023a` in the other — two different keys for one paper.
 *
 * What is shared is the *stem*: normalise the surname and append the year.
 * How the surname is obtained stays with the caller (the reader's citation
 * falls back to the given name when Mendeley leaves the pair empty) and so
 * does the disambiguation letter (a whole-file export must tell two
 * `Smith 2023` papers apart, a single pasted citation must not grow one).
 * This is the same shape as `mergeRectsIntoLines`: share the action, inject
 * the decision that differs.
 *
 * Nothing here knows about React, the DOM or the clipboard.
 */

const NOT_KEY_CHAR = /[^A-Za-z\u3400-\u9fff]/g

export function citationKeyStem(last: string, year: Doc['year']): string {
  const cleaned = (last || 'anon').replace(NOT_KEY_CHAR, '') || 'anon'
  return cleaned.toLowerCase() + (Number.isFinite(year) ? year : '')
}
