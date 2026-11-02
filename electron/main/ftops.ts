import {
  ftAdd,
  ftBuild,
  ftCancel,
  ftClear,
  ftStatus,
  ftVoid,
  initFullText,
  setFullTextPages
} from './fulltext'
import { dataDir, loadConfig, loadLibrary } from './store'
import { getWin } from './window'
import type { Doc, FtStatus } from '../../shared/types'

/**
 * The full-text index, driven.
 *
 * `fulltext.ts` knows how to read a PDF and how to answer a query; this is the
 * layer that knows which papers those questions are being asked about, when a
 * fresh one has to be folded in, and who is told how a build is going.  It is
 * separate because the index itself has no business reading the library or
 * holding a window, and because three callers want the same three answers —
 * the IPC handlers, the smoke run, and the import path that adds a paper.
 */

/** Where the index lives, and how many pages of each paper it may read.
 *  Called once, before anything asks for a status: a status read with the
 *  wrong budget reports an index that was built for a different question. */
export function initFt() {
  // MENDELEY_FT_DIR puts the index somewhere other than alongside the library,
  // which is also how the smoke run keeps a throwaway index of its own.
  // MENDELEY_FT_LIMIT caps how many documents one run will read; it exists so
  // the smoke run can exercise indexing without reading every PDF.
  initFullText(process.env.MENDELEY_FT_DIR || dataDir())
  const p = Number(loadConfig().ftPages ?? 0)
  if (p > 0) setFullTextPages(p)
}

/** The papers the index is about: every one that has a file on this disk,
 *  capped by `MENDELEY_FT_LIMIT` when a run only wants to exercise indexing. */
export function ftDocs(): Doc[] {
  const all = loadLibrary()?.docs ?? []
  const n = Number(process.env.MENDELEY_FT_LIMIT || 0)
  if (n <= 0) return all
  return all.filter((d) => d.localPdf).slice(0, n)
}

/**
 * Start a build and answer with the status the panel shows while it goes.
 * A build cannot be awaited by whoever asked: it reads every local PDF, which
 * takes minutes on a large library.
 */
export function startBuild(rebuild = false): FtStatus {
  const docs = ftDocs()
  void ftBuild(docs, (s) => getWin()?.webContents.send('ft:progress', s), rebuild).catch(
    () => undefined
  )
  return ftStatus(docs)
}

/**
 * Index a paper that has just been given a local PDF.
 *
 * It is not awaited: the import has already answered, and the point of it is
 * that nothing is asked of the reader.  One PDF is a fraction of a second,
 * where indexing the library takes minutes — which is why a newly imported
 * paper used to stay invisible to full-text search until the whole thing was
 * rebuilt, and usually was not.
 *
 * And when there is no index to add it to, adding it is not enough.  One
 * paper in an otherwise empty index makes search look like it works and
 * answer with the paper that was just imported, which is the one paper
 * nobody needs to search for.  So the library is built as well, in the
 * background, with the same progress and the same cancel as pressing the
 * button.
 */
export function indexAdded(doc: Doc) {
  // Read before the add: once the paper is in, the index is no longer empty
  // and the question cannot be asked any more.
  const wasVoid = ftVoid()
  void ftAdd([doc], [doc.id])
    .then((n) => {
      if (n > 0) getWin()?.webContents.send('ft:progress', ftStatus(ftDocs()))
      if (n > 0 && wasVoid && ftDocs().filter((d) => d.localPdf).length > 1) startBuild()
    })
    .catch(() => undefined)
}

export { ftCancel, ftClear }
