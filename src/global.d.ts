import type { Annotation, AppConfig, Doc, Folder, Library, SyncStatus } from '../shared/types'

export interface Api {
  loadLibrary: () => Promise<Library | { error: string } | null>
  sync: (full?: boolean) => Promise<{ docs: Doc[]; folders: Folder[] } | { error: string }>
  hasToken: () => Promise<boolean>
  onSyncStatus: (cb: (s: SyncStatus) => void) => () => void
  getConfig: () => Promise<AppConfig>
  setConfig: (c: Partial<AppConfig>) => Promise<AppConfig>
  pickPdfDir: () => Promise<string | null>
  importToken: () => Promise<{ ok: boolean; error?: string } | null>
  patchDoc: (id: string, body: Record<string, unknown>) => Promise<Doc>
  addToFolder: (folderId: string, docId: string) => Promise<{ ok: boolean }>
  removeFromFolder: (folderId: string, docId: string) => Promise<{ ok: boolean }>
  createFolder: (name: string) => Promise<Folder>
  loadAnnotations: () => Promise<Annotation[]>
  saveAnnotations: (list: Annotation[]) => Promise<{ ok: boolean }>
  pdfUrl: (absPath: string) => string
  openExternal: (url: string) => void
}

declare global {
  interface Window {
    api: Api
  }
}
