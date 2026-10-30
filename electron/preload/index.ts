import { contextBridge, ipcRenderer } from 'electron'
import type {
  Annotation,
  AppConfig,
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
  addToFolder: (folderId: string, docId: string) =>
    ipcRenderer.invoke('folder:add', folderId, docId) as Promise<{ ok: boolean }>,
  removeFromFolder: (folderId: string, docId: string) =>
    ipcRenderer.invoke('folder:remove', folderId, docId) as Promise<{ ok: boolean }>,
  createFolder: (name: string) => ipcRenderer.invoke('folder:create', name) as Promise<Folder>,

  loadAnnotations: () => ipcRenderer.invoke('annotations:load') as Promise<Annotation[]>,
  saveAnnotations: (list: Annotation[]) => ipcRenderer.invoke('annotations:save', list),

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
