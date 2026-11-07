/**
 * Walk a marker-paged API endpoint without looping forever when the marker
 * is wrong.
 *
 * `/files` used `document_id` as its marker and the server answered with page
 * one again; the old loop asked for two hundred pages of the same rows and
 * ended up with just the first page's worth of ids (182). That guard now lives
 * here for every paged endpoint: a page whose ids are all already seen ends
 * the walk, and so does a marker that does not move forward.
 *
 * Nothing here touches the network: the caller injects the page fetcher.
 */
export async function collectPaged<T extends { id?: string | null }>(
  fetchPage: (marker?: string) => Promise<T[] | null | undefined>,
  limit: number,
  maxPages = 200,
  onPage?: (count: number) => void
): Promise<T[]> {
  const out: T[] = []
  const seen = new Set<string>()
  let marker: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchPage(marker)
    if (!rows || rows.length === 0) break
    // An endpoint that does not give ids at all still deserves its one page.
    // There is nothing to page with in that case, so stop after taking it.
    if (rows.every((r) => !r.id)) {
      out.push(...rows)
      onPage?.(out.length)
      break
    }
    const fresh = rows.filter((r) => !r.id || !seen.has(r.id))
    const newIds = rows.filter((r) => !!r.id && !seen.has(r.id)).length
    // The server ignored the marker, or the marker was the wrong field: this
    // is the same page again. Pushing it would write thousands of duplicate
    // folders into library.json, and asking again would never terminate.
    if (newIds === 0) break
    out.push(...fresh)
    for (const r of fresh) if (r.id) seen.add(r.id)
    onPage?.(out.length)
    if (rows.length < limit) break
    const next = rows[rows.length - 1]?.id
    if (!next || next === marker) break
    marker = next
  }
  return out
}
