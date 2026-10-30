import type {
  Annotation,
  AppConfig,
  CloudAnnotation,
  Doc,
  Folder,
  FtHit,
  FtStatus,
  Library,
  MetaCandidate,
  SyncStatus,
  UpdateState
} from '../shared/types'

export interface Api {
  loadLibrary: () => Promise<Library | { error: string } | null>
  sync: (full?: boolean) => Promise<{ docs: Doc[]; folders: Folder[] } | { error: string }>
  hasToken: () => Promise<boolean>
  onSyncStatus: (cb: (s: SyncStatus) => void) => () => void
  appVersion: () => Promise<string>
  getConfig: () => Promise<AppConfig>
  setConfig: (c: Partial<AppConfig>) => Promise<AppConfig>
  copyText: (t: string) => Promise<boolean>
  readClipboard: () => Promise<string>
  pickPdfDir: () => Promise<string | null>
  importToken: () => Promise<{ ok: boolean; error?: string } | null>
  patchDoc: (id: string, body: Record<string, unknown>) => Promise<Doc>
  trashDoc: (id: string) => Promise<{ ok: boolean }>
  listTrash: () => Promise<Doc[]>
  restoreDoc: (id: string) => Promise<Doc>
  purgeDoc: (id: string) => Promise<{ ok: boolean }>
  addToFolder: (folderId: string, docId: string) => Promise<{ ok: boolean }>
  removeFromFolder: (folderId: string, docId: string) => Promise<{ ok: boolean }>
  createFolder: (name: string) => Promise<Folder>
  patchFolder: (
    id: string,
    body: { name?: string; parent_id?: string | null }
  ) => Promise<Folder>
  deleteFolder: (id: string) => Promise<{ ok: boolean }>
  renamePdfs: (template: string, apply: boolean) => Promise<{
    total: number
    renamed: number
    skipped: number
    sample: string[]
  }>
  ftStatus: () => Promise<FtStatus>
  ftBuild: (rebuild?: boolean) => Promise<FtStatus>
  ftCancel: () => Promise<FtStatus>
  ftClear: () => Promise<FtStatus>
  ftSearch: (q: string) => Promise<FtHit[]>
  onFtProgress: (cb: (s: FtStatus) => void) => () => void
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
  loadNotes: () => Promise<Record<string, string>>
  saveNotes: (notes: Record<string, string>) => Promise<{ ok: boolean }>
  createDoc: (body: Record<string, unknown>) => Promise<Doc>
  openRefFiles: () => Promise<{ name: string; text: string }[]>
  lookupMeta: (docId: string) => Promise<MetaCandidate[]>
  resolveIdentifier: (value: string) => Promise<MetaCandidate[]>
  importPdf: (
    name: string,
    bytes: ArrayBuffer,
    ids: { doi?: string; arxiv?: string }
  ) => Promise<Doc>
  downloadPdf: (docId: string) => Promise<{
    ok: boolean
    path?: string
    size?: number
    error?: string
  }>
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
  revealPdf: (p: string) => Promise<{ ok: boolean; error?: string }>
  openPdfExternally: (p: string) => Promise<{ ok: boolean; error?: string }>
}

declare global {
  interface Window {
    api: Api
  }
}
