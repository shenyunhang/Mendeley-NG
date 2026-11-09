import fs from 'node:fs'
import { Mendeley, findToken, type Token } from './mendeley'
import { attachPdfs } from './pdfindex'
import { loadConfig, loadLibrary, saveConfig, saveLibraryFromSync } from './store'
import { status } from './window'
import { reconcileSyncWrite } from '../../shared/libraryReconcile'
import {
  keepKnownFolderMemberships,
  keepLocalPdfPaths,
  mergeChangedIntoCache
} from '../../shared/librarySync'
import { createSyncQueue } from '../../shared/syncQueue'

/**
 * The API client, made once.
 *
 * Kept in a module rather than in the entry point because every handler that
 * writes to the cloud needs it and a client per call would re-read the token
 * file on each one — including the ones that run before the reader has signed
 * in at all.
 */
let client: Mendeley | null = null

export function ensureClient(): Mendeley {
  if (client) return client
  const found = findToken()
  if (!found) throw new Error('NO_TOKEN')
  client = new Mendeley(found.path, found.tok)
  return client
}

/** Overlap applied to the incremental watermark.  A document modified while
 *  the previous sync was in flight would otherwise be missed for ever, since
 *  its last_modified predates the timestamp we recorded when we started. */
const SYNC_OVERLAP_MS = 60_000

/**
 * Two pulls at once used to read the same watermark, then whichever finished
 * last overwrote the other's library and pushed `syncedAt` forward. A paper
 * the other request had just brought down could be lost for good. Serialise
 * them: every caller still gets its own answer, but only one pull writes the
 * cache at a time, and a later pull sees the earlier one's result.
 */
export const sync = createSyncQueue(pull)

async function pull(full: boolean) {
  const c = ensureClient()
  const cfg = loadConfig()
  const prev = loadLibrary()

  // Incremental needs both a cache to merge into and a watermark.  The cache
  // timestamp is already a "before the request" stamp, which is exactly what
  // a since filter wants.
  const since =
    !full && prev?.syncedAt && Date.parse(prev.syncedAt) > 0
      ? new Date(Date.parse(prev.syncedAt) - SYNC_OVERLAP_MS).toISOString()
      : undefined

  status({ phase: 'folders', done: 0, total: 0, message: '拉取文件夹' })
  const folders = await c.allFolders()

  // `/deleted_documents` is a 404, so GET /trash is the only deletion
  // channel the API has. Ask on every pull, not just a full one: a document
  // an earlier race wrote back must disappear on the very next incremental
  // sync, not wait for somebody to press the full button.
  status({ phase: 'documents', done: 0, total: 0, message: '核对回收站' })
  const trashedIds = new Set((await c.listTrash()).map((d) => d.id))

  const label = since ? '拉取改动' : '拉取文献'
  status({ phase: 'documents', done: 0, total: 0, message: label })
  const changed = await c.allDocuments(
    (n) => status({ phase: 'documents', done: n, total: 0, message: label }),
    since
  )

  const docs = mergeChangedIntoCache(prev?.docs ?? [], changed, !!since)

  // Nothing changed and we already have a library: skip the two expensive
  // steps, which is most of what an incremental sync is for.
  let pdf = { matched: 0, total: docs.length }
  if (!since || changed.length) {
    status({ phase: 'files', done: 0, total: 0, message: '核对 PDF 挂载' })
    const withFile = await c.fileDocumentIds()
    for (const d of docs) {
      if (withFile.size) d.file_attached = withFile.has(d.id)
    }

    status({ phase: 'pdf', done: 0, total: 0, message: '匹配本地 PDF' })
    pdf = attachPdfs(docs, cfg.pdfDir)
  }

  // Only incremental pulls need the two local-preservation rules: a full pull
  // is authoritative. Both are pure and injectable, with their own unit tests
  // in shared/librarySync.ts; the pull only supplies the file existence check.
  if (since && prev) keepKnownFolderMemberships(prev.docs, changed)
  if (prev) keepLocalPdfPaths(prev.docs, docs, (p) => fs.existsSync(p))

  // A pull runs for seconds or minutes, and everything it writes comes from
  // the snapshot taken at the top. Re-read the cache now and let one rule
  // decide what may be written: a paper trashed while this was in flight
  // must not be resurrected, a paper imported locally must not be dropped,
  // and anything in the cloud trash must not come back at all.
  const current = loadLibrary()
  const finalDocs = reconcileSyncWrite({
    started: prev?.docs ?? [],
    proposed: docs,
    current: current?.docs ?? null,
    trashedIds
  })
  saveLibraryFromSync(finalDocs, folders)
  // Read again rather than carrying the `cfg` from the top of the function:
  // a sync runs for seconds, and everything the reader changed while it ran —
  // a column pressed, a pane dragged, a sort chosen — would be written back
  // to the value it had when the sync started.  The watermark is the only
  // thing this function has to add.
  saveConfig({ ...loadConfig(), lastSync: new Date().toISOString() })
  status({
    phase: 'done',
    done: finalDocs.length,
    total: finalDocs.length,
    message: since
      ? `增量同步：改动 ${changed.length} 条，回收站对账 ${trashedIds.size} 条，共 ${finalDocs.length} 条文献`
      : `同步完成：${finalDocs.length} 条文献，${folders.length} 个文件夹，本地 PDF 匹配 ${pdf.matched}/${pdf.total}，回收站对账 ${trashedIds.size} 条`
  })
  return { docs: finalDocs, folders }
}

/**
 * Replace the client with one built from a token that was just imported.
 *
 * The old one is still holding the token it was built with, and a client
 * rebuilt lazily would go on answering with it until something happened to
 * call `ensureClient` again — which, on a machine that has just been given its
 * first token, is nothing.
 */
export function resetClient(tokenPath: string, tok: Token) {
  client = new Mendeley(tokenPath, tok)
}
