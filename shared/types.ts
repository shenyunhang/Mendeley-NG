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
}

export interface SyncStatus {
  phase: 'idle' | 'folders' | 'documents' | 'files' | 'pdf' | 'done' | 'error'
  done: number
  total: number
  message?: string
}

/** Local preferences.  Shared so the renderer never has to guess the shape. */
export interface AppConfig {
  pdfDir: string
  lastSync?: string
  /** Base UI font size in CSS px; the OS scale factor is applied on top. */
  fontSize?: number
}

/** Progress of an auto-update, pushed from main to the renderer. */
export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  version?: string
  percent?: number
  message?: string
}
