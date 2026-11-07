/**
 * Where page `n` starts in the continuous column.
 *
 * The column is a stack of pages with a fixed gap, so the offset of a page is
 * the sum of the heights of everything above it.  Those heights arrive one
 * at a time from pdf.js; until all of them are known the offset is not merely
 * unknown, it is *wrong* to guess — a jump made against a half-filled table
 * lands short and the next scroll event then reports the page the reader was
 * actually shown, overwriting the page box with the wrong number.
 *
 * Returning null says "not yet" to the caller, which is the whole difference
 * from the old behaviour: `scrollToPage` used to return silently on a missing
 * size and never be called again, leaving the page box on 20 with the column
 * still at the top.  The hook keeps the target and retries when the next
 * height arrives.
 */
export function continuousPageTop(
  n: number,
  sizes: Record<number, { h: number } | undefined>,
  scale: number,
  gap: number
): number | null {
  if (!Number.isFinite(n) || n < 1) return 0
  let top = 0
  for (let i = 1; i < n; i++) {
    const s = sizes[i]
    if (!s || !Number.isFinite(s.h)) return null
    top += s.h * scale + gap
  }
  return top
}
