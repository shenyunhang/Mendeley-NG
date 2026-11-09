/**
 * Collect the document ids that really carry a file from `GET /files`.
 *
 * The API pages this endpoint with `marker`, and the marker is the **file's
 * own `id`**, not `document_id`. Passing `document_id` makes the server
 * answer with the first page again: the old loop kept asking for 200 more
 * rows, added the same 200 ids to a set, and eventually gave up — so a
 * library with 5399 attachments looked like it had exactly 200. Every
 * document that was not on page one was then labelled "no PDF in the cloud",
 * which is why syncing never brought their files down.
 *
 * The walk itself is the one in paged.ts: a page whose file ids are all
 * already seen ends it, and so does a marker that does not move forward.
 * This module only says what a page is worth to us: the document ids on it.
 *
 * Nothing here touches the network: the caller injects the page fetcher, so
 * the paging can be checked with fixed pages instead of a live account.
 */
import { collectPaged } from './paged'

export interface FilePageRow {
  id?: string
  document_id?: string
}

export async function collectFileDocumentIds(
  fetchPage: (marker?: string) => Promise<FilePageRow[] | null | undefined>,
  limit = 200,
  maxPages = 200
): Promise<Set<string>> {
  const ids = new Set<string>()
  // collectPaged drops rows whose file id was already seen, but a document id
  // on such a row is still a fact about the library. Observe the page as it
  // arrives rather than reading the collected rows back, so the shared walk
  // owns only the paging rule and this module keeps its old answer exactly.
  const observe: typeof fetchPage = async (marker) => {
    const rows = await fetchPage(marker)
    for (const row of rows ?? []) {
      if (row.document_id) ids.add(row.document_id)
    }
    return rows
  }
  await collectPaged<FilePageRow>(observe, limit, maxPages)
  return ids
}
