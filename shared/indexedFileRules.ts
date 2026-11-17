/**
 * Rules the two PDF indexes share.
 *
 * `fulltext.ts` indexes the first pages of every paper into an append-only
 * corpus; `refsindex.ts` indexes the last pages into a per-paper cache. They
 * store different things and recover from interruption differently, but they
 * agree on three questions: has this file changed, how much of a sentence
 * belongs around a hit, and is it time to tell the window about progress.
 * Those three used to be answered twice, with slightly different literals.
 *
 * Everything here is pure. Neither index should have to be launched, mocked
 * or given a real PDF to prove that its idea of "the same file" agrees with
 * the other one's.
 */

export interface IndexedFileStamp {
  mtime: number
  size: number
  /** Only the append path tracks the path; see `sameIndexedFile`. */
  file?: string
}

/**
 * Whether a cached entry still describes the file now on disk.
 *
 * `mtime` is floored by both callers, because file systems report it with
 * different precision. Passing `file` opts into the stricter rule: an append
 * into the shared corpus must re-read a paper that was renamed or re-attached,
 * while a rebuild and the references cache only need the moment and the size.
 * An entry written before the field existed has no path, so it can never
 * satisfy the stricter rule.
 */
export function sameIndexedFile(
  prev: IndexedFileStamp | null | undefined,
  mtime: number,
  size: number,
  file?: string
): boolean {
  if (!prev) return false
  if (prev.mtime !== mtime || prev.size !== size) return false
  return file === undefined || prev.file === file
}

/**
 * A readable slice around a hit, with ellipses only where text was cut.
 *
 * Whitespace is folded after slicing, never before: offsets from the corpus
 * are UTF-16 positions into the original text, and a folded copy has
 * different ones. `before` and `after` stay parameters because the two
 * indexes chose different amounts of context on purpose.
 */
export function snippetAround(
  text: string,
  at: number,
  len: number,
  before: number,
  after: number
): string {
  const from = Math.max(0, at - before)
  const to = Math.min(text.length, at + len + after)
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim()
  return (from > 0 ? '…' : '') + body + (to < text.length ? '…' : '')
}

/**
 * Whether a progress message is due. Progress is a UI hint, not an event per
 * paper: a re-run over cached documents otherwise sends hundreds of messages
 * a second and freezes both processes. `force` is the final message of a run.
 */
export function progressAllowed(
  lastPing: number,
  now: number,
  minMs: number,
  force = false
): boolean {
  return force || now - lastPing >= minMs
}
