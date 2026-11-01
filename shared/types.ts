export interface Author {
  first_name?: string
  last_name?: string
}

/** A document as Mendeley returns it with `view=all`.  Without that view the
 *  API silently omits citation_key / file_attached / folder_uuids, which is
 *  exactly the trap the old Python scripts fell into. */
export interface Doc {
  id: string
  title?: string
  abstract?: string
  authors?: Author[]
  year?: number | null
  source?: string
  doi?: string
  arxiv?: string
  /** Where Mendeley actually keeps doi / arxiv / pmid; PATCHing them at the
   *  top level is accepted with a 200 and then silently dropped. */
  identifiers?: {
    doi?: string
    arxiv?: string
    pmid?: string
    isbn?: string
    issn?: string
  }
  citation_key?: string
  file_attached?: boolean
  folder_uuids?: string[]
  created?: string
  last_modified?: string
  type?: string
  pages?: string
  volume?: string
  issue?: string
  publisher?: string
  url?: string
  keywords?: string[]
  /** The three per-user flags.  All three are writable and come back with
   *  `view=all`, unlike `keywords`, which is publisher metadata. */
  tags?: string[]
  starred?: boolean
  read?: boolean
  /** filled in by us, not by Mendeley */
  localPdf?: string
}

export interface Folder {
  id: string
  name: string
  parent_id?: string | null
  document_count?: number
}

export interface Library {
  docs: Doc[]
  folders: Folder[]
  syncedAt: string
}

export interface Annotation {
  id: string
  docId: string
  page: number
  type: 'highlight' | 'note'
  color: string
  /** normalised rects in PDF coordinate space, 0..1 */
  rects: { x: number; y: number; w: number; h: number }[]
  text?: string
  note?: string
  created: string
  /** Mendeley's id, once this has been pushed to the cloud */
  remoteId?: string
  /** Positions in absolute PDF points, the unit Mendeley stores them in.
   *  Present for anything that came from (or went to) the cloud; used in
   *  preference to `rects` because it does not depend on the page being
   *  rendered at a particular size. */
  pos?: PdfPos[]
}

/** One rectangle on one page, in PDF points (72 per inch). */
export interface PdfPos {
  page: number
  x: number
  y: number
  w: number
  h: number
}

/** An annotation as Mendeley returns it. */
export interface CloudAnnotation {
  id: string
  document_id: string
  type: 'highlight' | 'sticky_note' | 'note'
  text?: string
  filehash?: string
  profile_id?: string
  privacy_level?: string
  created?: string
  last_modified?: string
  positions?: {
    top_left: { x: number; y: number }
    bottom_right: { x: number; y: number }
    page: number
  }[]
}

/** One result offered by a metadata lookup, ready to be patched onto a doc. */
export interface MetaCandidate {
  from: 'crossref-doi' | 'crossref' | 'arxiv' | 'catalog'
  /** 0..1 similarity against the document's current title */
  score: number
  title: string
  patch: Partial<Doc>
}

export interface SyncStatus {
  phase: 'idle' | 'folders' | 'documents' | 'files' | 'pdf' | 'done' | 'error'
  done: number
  total: number
  message?: string
}

/** A named filter, Zotero's "saved search".  Mendeley has no equivalent on
 *  the server, so these live in the local config. */
export interface SavedSearch {
  id: string
  name: string
  query: string
  folderId: string | null
  starred: boolean
}

/** Local preferences.  Shared so the renderer never has to guess the shape. */
export interface AppConfig {
  pdfDir: string
  lastSync?: string
  /** Base UI font size in CSS px; the OS scale factor is applied on top. */
  fontSize?: number
  savedSearches?: SavedSearch[]
  /** 'dark' unless the user has switched; drives a data attribute on <html>
   *  and the whole palette with it. */
  theme?: 'dark' | 'light'
  /** Scroll all pages in one column instead of one page at a time. */
  pdfContinuous?: boolean
  /** Which columns the document table shows, in order. */
  cols?: string[]
  /** Widths the reader has dragged the columns to, in CSS px, keyed by column.
   *  Only the columns that were dragged appear; the rest keep the width their
   *  definition gives them, which is what lets one column take the slack. */
  colWidths?: Record<string, number>
  /** How to name downloaded PDFs.  Placeholders: title, year, authors,
   *  journal, key, type, doi. */
  pdfNameTemplate?: string
  /** Named column layouts.  Unlike a saved search, a view does not filter:
   *  it only decides what the rows look like. */
  views?: SavedView[]
  /** Shape of the citation the copy button puts on the clipboard. */
  citeStyle?: string
  /** Width of the folder tree in CSS px, dragged by the left splitter. */
  paneLeft?: number
  /** Width of the reader as a percentage of the window, dragged by the right
   *  one.  A share rather than a fixed width, so it follows the window. */
  paneRight?: number
  /** How many leading pages of each PDF the full-text index reads.  Raising it
   *  costs index size; lowering it costs recall.  Changing it drops the index,
   *  because one built for a different budget describes a different corpus. */
  ftPages?: number
  /** Where the last export was written.  The save dialog starts here next
   *  time, so exporting is not a hunt through the tree every time. */
  exportDir?: string
  /** Sort the reader last asked for.  A key that is no longer a sort key is
   *  dropped on the way back in, so the arrow always lands on a real column. */
  sort?: { key: string; dir: 1 | -1 }
  /** Duplicate groups the reader has said are not duplicates, as the ids of
   *  the papers in each.  Groups are remembered by their papers rather than
   *  by the key the grouping used, because the key is derived: a DOI added
   *  later changes it, and "these two are different papers" stays true. */
  dupeIgnores?: string[][]
  /** Where the window was left.  Kept as a rectangle plus a flag rather than
   *  as the rectangle a maximised window reports, which is the whole screen
   *  and leaves nothing to come back to. */
  window?: {
    x: number
    y: number
    width: number
    height: number
    maximized?: boolean
  }
}

export const DEFAULT_FT_PAGES = 3

/** How local PDFs are named unless the user says otherwise.  Shared so the
 *  dialog can offer it as the starting point and main can fall back to it. */
export const DEFAULT_PDF_TEMPLATE = '{authors} - {year} - {title}'

/** Progress and size of the full-text index. */
export interface FtStatus {
  indexed: number
  total: number
  building: boolean
  done: number
  /** how many leading pages of each PDF are indexed */
  pages: number
  bytes: number
  /** Name of the file being read, so a long run shows it is doing something
   *  rather than just that it is not finished. */
  current?: string
  /**
   * Papers the last run could not index, with the reason.  They are the
   * difference between "the word is not in the library" and "the word is in
   * this one paper, which has no text layer", and only the second one is
   * something the reader can act on.
   *
   * Not optional, because a status is never produced without it: a run that
   * read everything has an empty list, and a library that was never indexed
   * has an empty list too.  Leaving it optional let a branch treat "no
   * reasons recorded" and "no reasons shown" as the same question, which is
   * how a finished run came to be described as one that never happened.
   */
  skipped: { name: string; why: string }[]
  /**
   * What pdf.js said when it could not start at all, or null.
   *
   * Set only when a run finished having read nothing: one message about the
   * install, rather than five thousand rows in `skipped` that all say the
   * same thing.  A reader that will not start fails on every document
   * identically, so without this the panel lists thirty identical lines and
   * the reader concludes their PDFs are broken.
   */
  reader?: string | null
  /**
   * True when an index exists on disk but was written by a different version
   * of the app and cannot be read.  Without it an update looks like it threw
   * away a build the reader already paid for.
   */
  legacy?: boolean
}

/** One place where the query appears in one document. */
export interface FtHit {
  docId: string
  page: number
  snippet: string
}

/** A named column layout for the document table. */
export interface SavedView {
  id: string
  name: string
  cols: string[]
}

/** Progress of an auto-update, pushed from main to the renderer. */
export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  /** version being offered, when known */
  version?: string
  /**
   * The version that is running right now.
   *
   * Every phase carries it, including the ones with nothing to report.  A
   * check that comes back "已是最新版本" and does not say which version is
   * being called latest answers a question nobody asked: what the reader
   * wanted to know is whether the thing they are running is the thing that
   * was fixed, and that needs both numbers side by side.
   */
  current?: string
  percent?: number
  message?: string
}
