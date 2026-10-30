import { contextBridge, ipcRenderer } from 'electron'
import type {
  Annotation,
  AppConfig,
  CloudAnnotation,
  Doc,
  Folder,
  Library,
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

  getConfig: () => ipcRenderer.invoke('config:get') as Promise<AppConfig>,
  setConfig: (c: Partial<AppConfig>) => ipcRenderer.invoke('config:set', c) as Promise<AppConfig>,
  pickPdfDir: () => ipcRenderer.invoke('dialog:pickPdfDir') as Promise<string | null>,
  importToken: () => ipcRenderer.invoke('dialog:importToken') as Promise<{ ok: boolean; error?: string } | null>,

  patchDoc: (id: string, body: Record<string, unknown>) =>
    ipcRenderer.invoke('doc:patch', id, body) as Promise<Doc>,
  trashDoc: (id: string) => ipcRenderer.invoke('doc:trash', id) as Promise<{ ok: boolean }>,
  listTrash: () => ipcRenderer.invoke('trash:list') as Promise<Doc[]>,
  restoreDoc: (id: string) => ipcRenderer.invoke('trash:restore', id) as Promise<Doc>,
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
  downloadPdf: (docId: string) =>
    ipcRenderer.invoke('pdf:download', docId) as Promise<{
      ok: boolean
      path?: string
      size?: number
      error?: string
    }>,

  checkUpdate: () =>
    ipcRenderer.invoke('updater:check') as Promise<{
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
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
