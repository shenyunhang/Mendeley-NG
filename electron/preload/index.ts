import { contextBridge, ipcRenderer } from 'electron'
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
} from '../../shared/types'

const api = {
  loadLibrary: () => ipcRenderer.invoke('library:load') as Promise<Library | { error: string } | null>,
  sync: (full = true) =>
    ipcRenderer.invoke('library:sync', full) as Promise<
      { docs: Doc[]; folders: Folder[] } | { error: string }
    >,
  hasToken: () => ipcRenderer.invoke('library:hasToken') as Promise<boolean>,
  onSyncStatus: (cb: (s: SyncStatus) => void) => {
    const h = (_e: unknown, s: SyncStatus) => cb(s)
    ipcRenderer.on('sync:status', h)
    return () => ipcRenderer.removeListener('sync:status', h)
  },

  appVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
  getConfig: () => ipcRenderer.invoke('config:get') as Promise<AppConfig>,
  setConfig: (c: Partial<AppConfig>) => ipcRenderer.invoke('config:set', c) as Promise<AppConfig>,
  copyText: (t: string) => ipcRenderer.invoke('clipboard:write', t) as Promise<boolean>,
  readClipboard: () => ipcRenderer.invoke('clipboard:read') as Promise<string>,
  pickPdfDir: () => ipcRenderer.invoke('dialog:pickPdfDir') as Promise<string | null>,
  importToken: () => ipcRenderer.invoke('dialog:importToken') as Promise<{ ok: boolean; error?: string } | null>,

  patchDoc: (id: string, body: Record<string, unknown>) =>
    ipcRenderer.invoke('doc:patch', id, body) as Promise<Doc>,
  trashDoc: (id: string) => ipcRenderer.invoke('doc:trash', id) as Promise<{ ok: boolean }>,
  listTrash: () => ipcRenderer.invoke('trash:list') as Promise<Doc[]>,
  restoreDoc: (id: string) => ipcRenderer.invoke('trash:restore', id) as Promise<Doc>,
  purgeDoc: (id: string) => ipcRenderer.invoke('trash:purge', id) as Promise<{ ok: boolean }>,
  addToFolder: (folderId: string, docId: string) =>
    ipcRenderer.invoke('folder:add', folderId, docId) as Promise<{ ok: boolean }>,
  removeFromFolder: (folderId: string, docId: string) =>
    ipcRenderer.invoke('folder:remove', folderId, docId) as Promise<{ ok: boolean }>,
  createFolder: (name: string) => ipcRenderer.invoke('folder:create', name) as Promise<Folder>,
  patchFolder: (
    id: string,
    body: { name?: string; parent_id?: string | null }
  ) => ipcRenderer.invoke('folder:patch', id, body) as Promise<Folder>,
  deleteFolder: (id: string) => ipcRenderer.invoke('folder:delete', id) as Promise<{ ok: boolean }>,
  /** Rename local PDFs to a template.  `apply: false` only reports the plan. */
  renamePdfs: (template: string, apply: boolean) =>
    ipcRenderer.invoke('pdf:rename', template, apply) as Promise<{
      total: number
      renamed: number
      skipped: number
      sample: string[]
    }>,

  ftStatus: () => ipcRenderer.invoke('ft:status') as Promise<FtStatus>,
  ftBuild: (rebuild?: boolean) => ipcRenderer.invoke('ft:build', rebuild) as Promise<FtStatus>,
  ftCancel: () => ipcRenderer.invoke('ft:cancel') as Promise<FtStatus>,
  ftClear: () => ipcRenderer.invoke('ft:clear') as Promise<FtStatus>,
  ftSearch: (q: string) => ipcRenderer.invoke('ft:search', q) as Promise<FtHit[]>,
  onFtProgress: (cb: (s: FtStatus) => void) => {
    const h = (_e: unknown, s: FtStatus) => cb(s)
    ipcRenderer.on('ft:progress', h)
    return () => ipcRenderer.removeListener('ft:progress', h)
  },

  loadAnnotations: () => ipcRenderer.invoke('annotations:load') as Promise<Annotation[]>,
  pullAnnotations: (docId: string) =>
    ipcRenderer.invoke('annotations:pull', docId) as Promise<CloudAnnotation[]>,
  pushAnnotations: (
    docId: string,
    filehash: string,
    items: { page: number; x: number; y: number; w: number; h: number }[]
  ) => ipcRenderer.invoke('annotations:push', docId, filehash, items) as Promise<CloudAnnotation[]>,
  deleteRemoteAnnotation: (id: string) =>
    ipcRenderer.invoke('annotations:deleteRemote', id) as Promise<{ ok: boolean }>,
  fileHash: (docId: string) =>
    ipcRenderer.invoke('annotations:fileHash', docId) as Promise<string | null>,
  saveAnnotations: (list: Annotation[]) => ipcRenderer.invoke('annotations:save', list),
  loadNotes: () => ipcRenderer.invoke('notes:load') as Promise<Record<string, string>>,
  saveNotes: (notes: Record<string, string>) =>
    ipcRenderer.invoke('notes:save', notes) as Promise<{ ok: boolean }>,
  loadReading: () => ipcRenderer.invoke('reading:load') as Promise<Record<string, number>>,
  setReading: (docId: string, page: number) =>
    ipcRenderer.invoke('reading:set', docId, page) as Promise<{ ok: boolean }>,
  createDoc: (body: Record<string, unknown>) =>
    ipcRenderer.invoke('doc:create', body) as Promise<Doc>,
  openRefFiles: () =>
    ipcRenderer.invoke('dialog:openFiles') as Promise<{ name: string; text: string }[]>,
  lookupMeta: (docId: string) =>
    ipcRenderer.invoke('meta:lookup', docId) as Promise<MetaCandidate[]>,
  resolveIdentifier: (value: string) =>
    ipcRenderer.invoke('meta:resolve', value) as Promise<MetaCandidate[]>,
  importPdf: (
    name: string,
    bytes: ArrayBuffer,
    ids: { doi?: string; arxiv?: string }
  ) => ipcRenderer.invoke('doc:importPdf', name, bytes, ids) as Promise<Doc>,
  downloadPdf: (docId: string) =>
    ipcRenderer.invoke('pdf:download', docId) as Promise<{
      ok: boolean
      path?: string
      size?: number
      error?: string
    }>,

  /** `quiet` suppresses the answers nobody asked for: a check the app makes
   *  on its own at startup says nothing unless there is something to say. */
  checkUpdate: (quiet?: boolean) =>
    ipcRenderer.invoke('updater:check', quiet) as Promise<{
      version?: string | null
      available?: boolean
      unsupported?: boolean
      error?: string
    }>,
  downloadUpdate: () =>
    ipcRenderer.invoke('updater:download') as Promise<{
      ok?: boolean
      noUpdate?: boolean
      error?: string
    }>,
  installUpdate: () => ipcRenderer.invoke('updater:install') as Promise<{ ok: boolean }>,
  onUpdateState: (cb: (s: UpdateState) => void) => {
    const h = (_e: unknown, s: UpdateState) => cb(s)
    ipcRenderer.on('updater:state', h)
    return () => ipcRenderer.removeListener('updater:state', h)
  },

  /** PDFs are served over the custom mendeley:// scheme registered in main */
  pdfUrl: (absPath: string) =>
    'mendeley://pdf/' + encodeURIComponent(absPath),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  revealPdf: (p: string) =>
    ipcRenderer.invoke('pdf:reveal', p) as Promise<{ ok: boolean; error?: string }>,
  openPdfExternally: (p: string) =>
    ipcRenderer.invoke('pdf:openExternal', p) as Promise<{ ok: boolean; error?: string }>
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
