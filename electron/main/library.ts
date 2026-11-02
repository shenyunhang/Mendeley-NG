import fs from 'node:fs'
import { Mendeley, findToken, type Token } from './mendeley'
import { attachPdfs } from './pdfindex'
import { loadConfig, loadLibrary, saveConfig, saveLibrary } from './store'
import { status } from './window'

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

export async function sync(full: boolean) {
  const c = ensureClient()
  const cfg = loadConfig()
  const prev = loadLibrary()

  // Incremental needs both a cache to merge into and a watermark.  The cache
  // timestamp is already a "before the request" stamp, which is exactly what
  // a since filter wants.
  const since =
    !full && prev?.syncedAt
      ? new Date(Date.parse(prev.syncedAt) - SYNC_OVERLAP_MS).toISOString()
      : undefined

  status({ phase: 'folders', done: 0, total: 0, message: '拉取文件夹' })
  const folders = await c.allFolders()

  const label = since ? '拉取改动' : '拉取文献'
  status({ phase: 'documents', done: 0, total: 0, message: label })
  const changed = await c.allDocuments(
    (n) => status({ phase: 'documents', done: n, total: 0, message: label }),
    since
  )

  const byId = new Map((prev?.docs ?? []).map((d) => [d.id, d]))
  for (const d of changed) byId.set(d.id, d)
  let docs = since ? [...byId.values()] : changed

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

  if (since && prev) {
    // Mendeley occasionally hands back a changed document with an empty
    // folder_uuids, and losing a folder membership is far worse than
    // redundantly keeping one, so the known value wins when the fresh one
    // is blank.  Only done incrementally: a full pull is authoritative.
    const known = new Map(prev.docs.map((d) => [d.id, d.folder_uuids]))
    for (const d of changed) {
      if (!d.folder_uuids?.length && known.get(d.id)?.length) {
        d.folder_uuids = known.get(d.id)
      }
    }
  }

  // keep previously resolved pdf paths across a resync
  if (prev) {
    const oldById = new Map(prev.docs.map((d) => [d.id, d]))
    for (const d of docs) {
      const old = oldById.get(d.id)
      if (old && !d.localPdf && old.localPdf && fs.existsSync(old.localPdf)) {
        d.localPdf = old.localPdf
      }
    }
  }

  saveLibrary(docs, folders)
  saveConfig({ ...cfg, lastSync: new Date().toISOString() })
  status({
    phase: 'done',
    done: docs.length,
    total: docs.length,
    message: since
      ? `增量同步：改动 ${changed.length} 条，共 ${docs.length} 条文献（删除只在全量同步时发现）`
      : `同步完成：${docs.length} 条文献，${folders.length} 个文件夹，本地 PDF 匹配 ${pdf.matched}/${pdf.total}`
  })
  return { docs, folders }
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
