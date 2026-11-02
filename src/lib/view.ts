import type { Annotation, Doc } from '../../shared/types'
import type { DupeGroup } from './dupes'
import type { Entry } from './import'

/**
 * Where the reader is.
 *
 * The middle of the window used to be decided by a chain of eight
 * ternaries — `adding ? … : importing ? … : ftMode ? …` — each one a
 * separate piece of state that happened to be non-null.  That is modes
 * piled on top of each other, not a view: nothing says what is on screen
 * now, only what was turned on last, and every new screen has to be
 * inserted somewhere in the chain and given a precedence against seven
 * things it has nothing to do with.
 *
 * So it is one value with one meaning, and the payload each screen needs
 * travels with it instead of living beside it.  A screen that is not
 * showing is not merely hidden, it does not exist: its entries, its
 * duplicate groups and its list of deleted papers are all gone with it,
 * which is what stops a stale copy of them from being drawn later.
 *
 * `setup` is deliberately not here.  It is derived — an empty library
 * that has not been set up yet — and it is a state of the library view
 * rather than somewhere the reader went.
 */
export type View =
  /** The table of papers: folders, filters, sorting, columns. */
  | { kind: 'library' }
  /**
   * Reading one paper, with the paper given the whole window.
   *
   * The reader used to be a tab in a pane beside the table, which is the
   * arrangement a catalogue wants and not the one a reader does: the table
   * kept the middle of the window while the paper being read had a column
   * at the side.  Reading is why the library was gathered, so it gets its
   * own view rather than a share of somebody else's.
   */
  | { kind: 'reader' }
  /** Searching the text of the PDFs rather than their metadata. */
  | { kind: 'fulltext' }
  /** A bibliography file, read and waiting to be confirmed. */
  | { kind: 'import'; entries: Entry[] }
  /** Adding a paper by DOI, arXiv id or title. */
  | { kind: 'add' }
  | { kind: 'dupes'; groups: DupeGroup[] }
  | { kind: 'trash'; docs: Doc[] }
  /** Every highlight in the library, grouped by paper. */
  | { kind: 'annotations'; anns: Annotation[] }

export const LIBRARY: View = { kind: 'library' }
