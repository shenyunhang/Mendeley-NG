/**
 * Stitch the rectangles of one line into a single box.
 *
 * A page's text layer and a find hit both arrive as one fragment per text
 * run, and both want to answer "one rectangle per line" instead. The merge
 * used to be written out in full in `pdffind.ts` and `pdfsel.ts`: four lines
 * of `max / min / width / max height`, down to the same variable names. What
 * actually differs between the two callers is only the answer to "are these
 * two fragments on the same line" -- find works in 0..1 page coordinates
 * with a small tolerance and requires the fragments to be adjacent, while
 * selection works in CSS pixels and only compares y. Sharing that predicate
 * would silently change one of the two answers (166), so it is injected.
 *
 * Sorting stays with the caller. Both old loops walked an already sorted
 * array, and which fragment becomes the line's anchor depends on that order;
 * moving the sort in here would be an extra behavioural decision, not a
 * refactor. The shape is structural, so `Rect` from `pdfgeom.ts` is accepted
 * without this pure module importing renderer-side types (as in `cardSpot`).
 */
export interface LineRect {
  x: number
  y: number
  w: number
  h: number
}

export type SameLine = (line: LineRect, next: LineRect) => boolean

export function mergeRectsIntoLines(
  rects: LineRect[],
  sameLine: SameLine
): LineRect[] {
  const lines: LineRect[] = []
  for (const r of rects) {
    const line = lines.find((l) => sameLine(l, r))
    if (line) {
      const right = Math.max(line.x + line.w, r.x + r.w)
      line.x = Math.min(line.x, r.x)
      line.w = right - line.x
      line.h = Math.max(line.h, r.h)
    } else {
      lines.push({ ...r })
    }
  }
  return lines
}
