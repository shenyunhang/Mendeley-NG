/**
 * Which paper a double click names, and whether that double click also asks
 * to read it.
 *
 * The gesture is answered once, in capture phase, because every list opens a
 * paper with its own single-click handler and none of them should have to
 * know whether that click was the first half of a double one. Pinning the
 * preview tab stays the answer for anything carrying a document id; the two
 * catalogues of papers — the library table and the references results — also
 * ask for the whole window, which is what double clicking a paper means to a
 * reader. An explicit attribute marks those rows: the full-text results use
 * the same visual class as the references results without being that list.
 *
 * Only the shape of a DOM element needed to answer this is taken here, so
 * the rule can be tested without a browser.
 */

export interface ClosestElement {
  closest(selector: string): ClosestElement | null
  getAttribute(name: string): string | null
}

/** Put on a row whose double click should open the reading view. */
export const READ_ON_DOUBLE_CLICK_ATTRIBUTE = 'data-read-on-double-click'

/** Spread onto those rows, so the marker and the rule cannot drift apart. */
export const READ_ON_DOUBLE_CLICK_PROPS = {
  [READ_ON_DOUBLE_CLICK_ATTRIBUTE]: 'true'
} as const

export interface DoubleClickPaper {
  id: string
  read: boolean
}

export function paperForDoubleClick(target: ClosestElement | null): DoubleClickPaper | null {
  if (!target) return null
  // The tab bar pins its own tabs; the right pane's details panel is not a
  // list of papers and must not pin anything.
  if (target.closest('.pane-right')) return null
  const holder = target.closest('[data-id]')
  const id = holder?.getAttribute('data-id')
  if (!id) return null
  return {
    id,
    read: !!target.closest(`[${READ_ON_DOUBLE_CLICK_ATTRIBUTE}]`)
  }
}
