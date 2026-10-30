import type {
  Annotation,
  AppConfig,
  CloudAnnotation,
  Doc,
  Folder,
  Library,
  SyncStatus,
  UpdateState
} from '../shared/types'

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
  trashDoc: (id: string) => Promise<{ ok: boolean }>
  listTrash: () => Promise<Doc[]>
  restoreDoc: (id: string) => Promise<Doc>
  addToFolder: (folderId: string, docId: string) => Promise<{ ok: boolean }>
  removeFromFolder: (folderId: string, docId: string) => Promise<{ ok: boolean }>
  createFolder: (name: string) => Promise<Folder>
  patchFolder: (
    id: string,
    body: { name?: string; parent_id?: string | null }
  ) => Promise<Folder>
  deleteFolder: (id: string) => Promise<{ ok: boolean }>
  loadAnnotations: () => Promise<Annotation[]>
  pullAnnotations: (docId: string) => Promise<CloudAnnotation[]>
  pushAnnotations: (
    docId: string,
    filehash: string,
    items: { page: number; x: number; y: number; w: number; h: number }[]
  ) => Promise<CloudAnnotation[]>
  deleteRemoteAnnotation: (id: string) => Promise<{ ok: boolean }>
  fileHash: (docId: string) => Promise<string | null>
  saveAnnotations: (list: Annotation[]) => Promise<{ ok: boolean }>
  checkUpdate: () => Promise<{
    version?: string | null
    available?: boolean
    unsupported?: boolean
    error?: string
  }>
  downloadUpdate: () => Promise<{ ok?: boolean; noUpdate?: boolean; error?: string }>
  installUpdate: () => Promise<{ ok: boolean }>
  onUpdateState: (cb: (s: UpdateState) => void) => () => void
  pdfUrl: (absPath: string) => string
  openExternal: (url: string) => void
}

declare global {
  interface Window {
    api: Api
  }
}
