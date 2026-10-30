import { BrowserWindow, app, dialog, ipcMain, net, protocol, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Mendeley, findToken, importTokenFrom } from './mendeley'
import {
  DEFAULT_PDF_DIR,
  loadAnnotations,
  loadConfig,
  loadLibrary,
  saveAnnotations,
  saveConfig,
  saveLibrary
} from './store'
import { attachPdfs } from './pdfindex'
import { initUpdater, type UpdateState } from './updater'
import type {
  Annotation,
  AppConfig,
  CloudAnnotation,
  Doc,
  Folder,
  SyncStatus
} from '../../shared/types'

let win: BrowserWindow | null = null
let client: Mendeley | null = null

function status(s: SyncStatus) {
  win?.webContents.send('sync:status', s)
}

function ensureClient(): Mendeley {
  if (client) return client
  const found = findToken()
  if (!found) throw new Error('NO_TOKEN')
  client = new Mendeley(found.path, found.tok)
  return client
}

async function sync(full: boolean) {
  const c = ensureClient()
  status({ phase: 'folders', done: 0, total: 0, message: '拉取文件夹' })
  const folders = await c.allFolders()
  status({ phase: 'documents', done: 0, total: 0, message: '拉取文献' })
  const docs = await c.allDocuments((n) =>
    status({ phase: 'documents', done: n, total: 0, message: '拉取文献' })
  )

  status({ phase: 'files', done: 0, total: 0, message: '核对 PDF 挂载' })
  const withFile = await c.fileDocumentIds()
  for (const d of docs) {
    if (withFile.size) d.file_attached = withFile.has(d.id)
  }

  status({ phase: 'pdf', done: 0, total: 0, message: '匹配本地 PDF' })
  const cfg = loadConfig()
  const pdf = attachPdfs(docs, cfg.pdfDir)

  // keep annotations and previously resolved pdf paths across a resync
  const prev = loadLibrary()
  if (prev) {
    const byId = new Map(prev.docs.map((d) => [d.id, d]))
    for (const d of docs) {
      const old = byId.get(d.id)
      if (old && !d.localPdf && old.localPdf && fs.existsSync(old.localPdf)) {
        d.localPdf = old.localPdf
      }
    }
  }
  if (!full && prev) {
    // partial refresh: keep folder membership we already know about
    const known = new Map(prev.docs.map((d) => [d.id, d.folder_uuids]))
    for (const d of docs) {
      if (!d.folder_uuids?.length && known.get(d.id)?.length) {
        d.folder_uuids = known.get(d.id)
      }
    }
  }

  saveLibrary(docs, folders)
  status({
    phase: 'done',
    done: docs.length,
    total: docs.length,
    message: `同步完成：${docs.length} 条文献，${folders.length} 个文件夹，本地 PDF 匹配 ${pdf.matched}/${pdf.total}`
  })
  return { docs, folders }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 650,
    // no zoomFactor and no DPI overrides on purpose: Chromium already renders
    // at the system scale factor, which is the whole point of this rewrite
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    win = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/**
 * `--smoke` runs the whole stack headlessly and writes a screenshot, which is
 * the only way to confirm both the sync pipeline and the high-DPI rendering
 * from a command line.  It is a development aid, never used by the packaged app.
 */
async function runSmoke() {
  const log = (...a: unknown[]) => console.log('[smoke]', ...a)
  const disp = screen.getPrimaryDisplay()
  log('display', disp.size.width + 'x' + disp.size.height, 'scaleFactor', disp.scaleFactor)

  log('token', !!findToken())
  try {
    if (process.argv.includes('--no-sync')) {
      const cached = loadLibrary()
      log('skip sync, cache', cached ? cached.docs.length + ' docs' : 'empty')
    } else {
    const t0 = Date.now()
    const { docs, folders } = await sync(true)
    log('sync ok', docs.length, 'docs', folders.length, 'folders', Date.now() - t0, 'ms')
    const withPdf = docs.filter((d) => d.localPdf).length
    log('pdf matched', withPdf + '/' + docs.length)
    const s = docs.find((d) => d.citation_key)
    log('sample', JSON.stringify({
      title: s?.title?.slice(0, 60), year: s?.year, key: s?.citation_key,
      folders: s?.folder_uuids?.length, pdf: !!s?.localPdf
    }))
    }
  } catch (e) {
    log('sync FAILED', String(e))
  }

  const w = new BrowserWindow({ width: 1500, height: 950, show: false, backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
  const errs: string[] = []
  w.webContents.on('console-message', (_e, _l, msg) => { if (/error|Error/.test(msg)) errs.push(msg) })
  w.webContents.on('did-fail-load', (_e, code, desc) => errs.push('did-fail-load ' + code + ' ' + desc))
  win = w
  await w.loadFile(path.join(__dirname, '../renderer/index.html'))
  await new Promise((r) => setTimeout(r, 2500))
  const info = await w.webContents.executeJavaScript(
    'JSON.stringify({dpr: devicePixelRatio, rows: document.querySelectorAll("table,.row,[data-row]").length, body: document.body.innerText.slice(0,300)})'
  )
  log('renderer', info)
  if (errs.length) log('renderer errors', errs.slice(0, 10).join(' | '))
  const shot = async (name: string) => {
    const p = path.join(app.getPath('temp'), 'mendeley-ng-' + name + '.png')
    const img = await w.webContents.capturePage()
    fs.writeFileSync(p, img.toPNG())
    log('screenshot ->', p, img.getSize().width + 'x' + img.getSize().height)
  }
  await shot('smoke')

  // click the first row and give pdf.js time to paint, so the run also proves
  // the reader works and that the canvas is backed at device resolution
  const clicked = await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")].filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));'
    + 'if(!r.length)return "no row with pdf";r[0].click();return r[0].innerText.replace(/\\n/g," | ").slice(0,80)})()'
  )
  log('clicked row:', clicked)
  await new Promise((r) => setTimeout(r, 5000))
  const pdfInfo = await w.webContents.executeJavaScript(
    '(()=>{const c=document.querySelector("canvas");return JSON.stringify({canvases:document.querySelectorAll("canvas").length,bufW:c&&c.width,bufH:c&&c.height,cssW:c&&c.style.width,dpr:devicePixelRatio})})()'
  )
  log('pdf', pdfInfo)
  await shot('smoke-pdf')
  app.exit(0)
}

app.whenReady().then(() => {
  // serve local PDFs through our own scheme so webSecurity stays on
  protocol.handle('mendeley', (req) => {
    const u = new URL(req.url)
    if (u.hostname === 'pdf') {
      const p = decodeURIComponent(u.pathname.replace(/^\//, ''))
      return net.fetch('file:///' + p.replace(/\\/g, '/').replace(/^\/+/, ''))
    }
    return new Response('not found', { status: 404 })
  })

  if (process.argv.includes('--smoke')) {
    runSmoke().catch((e) => {
      console.log('[smoke] crashed', String(e))
      app.exit(1)
    })
    return
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('library:load', () => {
  try {
    return loadLibrary()
  } catch (e) {
    return { error: String(e) }
  }
})

ipcMain.handle('library:sync', async (_e, full: boolean) => {
  try {
    return await sync(full)
  } catch (e) {
    const msg = String(e)
    status({ phase: 'error', done: 0, total: 0, message: msg })
    return { error: msg }
  }
})

ipcMain.handle('library:hasToken', () => !!findToken())

ipcMain.handle('config:get', () => loadConfig())
ipcMain.handle('config:set', (_e, c: Partial<AppConfig>) => {
  const cur = loadConfig()
  saveConfig({ ...cur, ...c })
  return loadConfig()
})

ipcMain.handle('dialog:pickPdfDir', async () => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath: loadConfig().pdfDir || DEFAULT_PDF_DIR
  })
  if (r.canceled || !r.filePaths[0]) return null
  const pdfDir = r.filePaths[0]
  saveConfig({ ...loadConfig(), pdfDir })
  return pdfDir
})

ipcMain.handle('dialog:importToken', async () => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'token.json', extensions: ['json'] }]
  })
  if (r.canceled || !r.filePaths[0]) return null
  try {
    const got = importTokenFrom(r.filePaths[0])
    client = new Mendeley(got.path, got.tok)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('doc:patch', async (_e, id: string, body: Record<string, unknown>) => {
  const c = ensureClient()
  const updated = await c.patchDocument(id, body)
  const lib = loadLibrary()
  if (lib) {
    const i = lib.docs.findIndex((d) => d.id === id)
    if (i >= 0) lib.docs[i] = { ...lib.docs[i], ...updated }
    saveLibrary(lib.docs, lib.folders)
  }
  return updated
})

// Mendeley has no hard delete for documents: they go to the trash and can be
// restored.  Probed against the live API to confirm the route is
// POST /trash/{id}/restore; POST /documents/{id}/restore returns
// "No service found for your request".
ipcMain.handle('doc:trash', async (_e, id: string) => {
  const c = ensureClient()
  await c.trashDocument(id)
  const lib = loadLibrary()
  if (lib) saveLibrary(lib.docs.filter((d) => d.id !== id), lib.folders)
  return { ok: true }
})

ipcMain.handle('trash:list', async () => {
  const c = ensureClient()
  return c.listTrash()
})

ipcMain.handle('trash:restore', async (_e, id: string) => {
  const c = ensureClient()
  return c.restoreDocument(id)
})

ipcMain.handle(
  'folder:add',
  async (_e, folderId: string, docId: string) => {
    const c = ensureClient()
    await c.addToFolder(folderId, docId)
    const lib = loadLibrary()
    if (lib) {
      const d = lib.docs.find((x) => x.id === docId)
      if (d) {
        d.folder_uuids = [...(d.folder_uuids ?? []), folderId]
        saveLibrary(lib.docs, lib.folders)
      }
    }
    return { ok: true }
  }
)

ipcMain.handle(
  'folder:remove',
  async (_e, folderId: string, docId: string) => {
    const c = ensureClient()
    await c.removeFromFolder(folderId, docId)
    const lib = loadLibrary()
    if (lib) {
      const d = lib.docs.find((x) => x.id === docId)
      if (d) {
        d.folder_uuids = (d.folder_uuids ?? []).filter((f) => f !== folderId)
        saveLibrary(lib.docs, lib.folders)
      }
    }
    return { ok: true }
  }
)

ipcMain.handle(
  'folder:patch',
  async (_e, id: string, body: { name?: string; parent_id?: string | null }) => {
    const c = ensureClient()
    const f = await c.patchFolder(id, body)
    const lib = loadLibrary()
    if (lib) saveLibrary(lib.docs, lib.folders.map((x) => (x.id === id ? f : x)))
    return f
  }
)

ipcMain.handle('folder:delete', async (_e, id: string) => {
  const c = ensureClient()
  await c.deleteFolder(id)
  const lib = loadLibrary()
  if (lib) saveLibrary(lib.docs, lib.folders.filter((x) => x.id !== id && x.parent_id !== id))
  return { ok: true }
})

ipcMain.handle('folder:create', async (_e, name: string) => {
  const c = ensureClient()
  const f = await c.createFolder(name)
  const lib = loadLibrary()
  if (lib) saveLibrary(lib.docs, [...lib.folders, f])
  return f
})

ipcMain.handle('annotations:pull', async (_e, docId: string) => {
  const c = ensureClient()
  return c.listAnnotations(docId)
})

ipcMain.handle('annotations:fileHash', async (_e, docId: string) => {
  const c = ensureClient()
  return c.fileHash(docId)
})

ipcMain.handle(
  'annotations:push',
  async (_e, docId: string, filehash: string, items: { page: number; x: number; y: number; w: number; h: number }[]) => {
    const c = ensureClient()
    const out: CloudAnnotation[] = []
    for (const it of items) {
      const created = await c.createAnnotation({
        document_id: docId,
        filehash,
        type: 'highlight',
        positions: [
          {
            top_left: { x: it.x, y: it.y },
            bottom_right: { x: it.x + it.w, y: it.y + it.h },
            page: it.page
          }
        ]
      })
      out.push(created)
    }
    return out
  }
)

ipcMain.handle('annotations:deleteRemote', async (_e, id: string) => {
  const c = ensureClient()
  await c.deleteAnnotation(id)
  return { ok: true }
})

ipcMain.handle('annotations:load', () => loadAnnotations())
ipcMain.handle('annotations:save', (_e, list: Annotation[]) => {
  saveAnnotations(list)
  return { ok: true }
})

ipcMain.handle('pdf:read', async (_e, p: string) => {
  try {
    const buf = fs.readFileSync(p)
    return { ok: true, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// updater events are pushed to the renderer, which renders them in the toolbar
initUpdater((s: UpdateState) => win?.webContents.send('updater:state', s))

ipcMain.handle('shell:openExternal', (_e, url: string) => {
  shell.openExternal(url)
  return { ok: true }
})

export type { Doc, Folder }
