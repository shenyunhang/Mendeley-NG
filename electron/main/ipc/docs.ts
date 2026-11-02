import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import { ensureClient } from '../library'
import { lookup, resolveIdentifier } from '../lookup'
import { parseName } from '../pdfindex'
import { pdfNameFor } from '../pdfname'
import { indexAdded } from '../ftops'
import { DEFAULT_PDF_DIR, loadConfig, loadLibrary, saveLibrary } from '../store'
export function registerDocsIpc() {
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

  ipcMain.handle('trash:purge', async (_e, id: string) => {
    const c = ensureClient()
    await c.purgeDocument(id)
    return { ok: true }
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

  ipcMain.handle('doc:create', async (_e, body: Record<string, unknown>) => {
    const c = ensureClient()
    const doc = await c.createDocument(body)
    const lib = loadLibrary()
    if (lib) saveLibrary([...lib.docs, doc], lib.folders)
    return doc
  })

  ipcMain.handle('meta:lookup', async (_e, docId: string) => {
    const lib = loadLibrary()
    const doc = lib?.docs.find((d) => d.id === docId)
    if (!doc) return []
    return lookup(doc)
  })

  /** Add a paper by pasting a DOI, an arXiv id or a title.  Mendeley's catalogue
   *  needs a token, but the whole thing is still useful without one: the DOI
   *  then falls back to Crossref, which is anonymous. */
  ipcMain.handle('meta:resolve', async (_e, value: string) => {
    let bearer: string | undefined
    try {
      bearer = await ensureClient().bearer()
    } catch {
      /* no token: DOI resolution degrades to Crossref instead of failing */
    }
    return resolveIdentifier(value, bearer)
  })

  ipcMain.handle(
    'doc:importPdf',
    async (_e, name: string, bytes: ArrayBuffer, ids: { doi?: string; arxiv?: string }) => {
      const c = ensureClient()
      const buf = Buffer.from(bytes)
      const created = await c.createDocumentFromFile(name, buf)
      // The server reads metadata out of the PDF itself — title, authors, year
      // and identifiers all come back filled in for a real paper, and that is
      // far better than anything the file name can tell us.  Only fall back to
      // the "author - year - title.pdf" shape when extraction found nothing,
      // otherwise the patch would overwrite a correct title with a worse one.
      const base = name.replace(/\.pdf$/i, '')
      const p = parseName(name)
      const patch: Record<string, unknown> = {}
      if (!created.title || created.title === base) {
        if (p.title && p.title !== base) patch.title = p.title
        if (p.year) patch.year = p.year
      }
      // doi/arxiv are ignored at the top level; they live under identifiers
      const ident: Record<string, string> = { ...(created.identifiers ?? {}) }
      if (ids?.doi && !ident.doi) ident.doi = ids.doi
      if (ids?.arxiv && !ident.arxiv) ident.arxiv = ids.arxiv
      if (
        ident.doi !== created.identifiers?.doi ||
        ident.arxiv !== created.identifiers?.arxiv
      ) {
        patch.identifiers = ident
      }
      let doc = created
      if (Object.keys(patch).length) {
        try {
          doc = await c.patchDocument(created.id, patch)
        } catch {
          /* a bad guess is not worth failing the import over */
        }
      }
      // keep a local copy next to the rest of the library so it opens without
      // another round trip to the cloud
      const cfg = loadConfig()
      const dir = cfg.pdfDir || DEFAULT_PDF_DIR
      fs.mkdirSync(dir, { recursive: true })
      const dest = path.join(dir, pdfNameFor(doc, name, cfg.pdfNameTemplate))
      if (buf.length) fs.writeFileSync(dest, buf)
      doc.localPdf = dest
      doc.file_attached = true
      const lib = loadLibrary()
      if (lib) {
        saveLibrary(
          lib.docs.some((d) => d.id === doc.id) ? lib.docs : [...lib.docs, doc],
          lib.folders
        )
      }
      indexAdded(doc)
      return doc
    }
  )
}
