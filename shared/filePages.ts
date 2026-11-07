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
 * A page whose file ids are all already seen is treated as the end. That is
 * both the correct response to a short/duplicate last page and a guard against
 * a wrong marker quietly turning into hundreds of identical requests.
 *
 * Nothing here touches the network: the caller injects the page fetcher, so
 * the paging can be checked with fixed pages instead of a live account.
 */
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
  const seenFiles = new Set<string>()
  let marker: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchPage(marker)
    if (!rows || rows.length === 0) break
    let fresh = 0
    for (const row of rows) {
      if (row.id && !seenFiles.has(row.id)) {
        seenFiles.add(row.id)
        fresh++
      }
      if (row.document_id) ids.add(row.document_id)
    }
    if (fresh === 0) break
    if (rows.length < limit) break
    const next = rows[rows.length - 1]?.id
    if (!next || next === marker) break
    marker = next
  }
  return ids
}
