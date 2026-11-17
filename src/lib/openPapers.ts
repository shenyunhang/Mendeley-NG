import type { Doc } from '../../shared/types'

/**
 * One paper the reader has opened, kept as a tab in the right pane.
 *
 * The pane still renders a single PdfViewer, so a tab is not a second reader:
 * it is the remembered fact that this paper was opened, at which page, and
 * whether it had a file to show. That is enough to bring it back without
 * closing the paper that was on screen before.
 *
 * `doc` is a snapshot rather than an id lookup. A hit can point at a paper
 * that has since been trashed, or at one that the current folder filter no
 * longer lists, and a tab that cannot resolve its own paper is not a tab.
 */
export interface OpenPaper {
  id: string
  doc: Doc
  /** The page a hit pointed at, or null when nothing was specified: the
   *  reader then restores where this paper was last left, which is what an
   *  open from a list or a link has always done. */
  page: number | null
  tab: 'pdf' | 'details'
}

export function paperEntry(d: Doc, page: number | null): OpenPaper {
  return { id: d.id, doc: d, page, tab: d.localPdf ? 'pdf' : 'details' }
}

/**
 * Opening a paper that already has a tab refreshes its page in place instead
 * of appending a second tab. The order is the order the papers were opened,
 * which is what makes the tab bar stable while the reader moves between them.
 */
export function upsertPaper(list: OpenPaper[], entry: OpenPaper): OpenPaper[] {
  const at = list.findIndex((p) => p.id === entry.id)
  if (at < 0) return [...list, entry]
  const next = [...list]
  next[at] = entry
  return next
}

export function removePaper(list: OpenPaper[], id: string): OpenPaper[] {
  return list.filter((p) => p.id !== id)
}

/**
 * The tab to show after one is closed. Only the caller knows whether the
 * closed tab was the active one, so it asks only in that case. A neighbour
 * is preferred over the first tab: closing the middle paper of three should
 * leave the reader on the one next to it, not jump back to the start.
 */
export function nextActivePaper(list: OpenPaper[], closedId: string): OpenPaper | null {
  const at = list.findIndex((p) => p.id === closedId)
  if (at < 0) return null
  const remaining = removePaper(list, closedId)
  if (!remaining.length) return null
  return remaining[Math.min(at, remaining.length - 1)] ?? null
}
