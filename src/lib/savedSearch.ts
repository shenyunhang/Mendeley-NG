/**
 * The one rule behind a saved search's name, its sidebar count and the list
 * it opens.
 *
 * The name used to be built from every checked filter while `addSearch` only
 * remembered the star, and the sidebar count only asked about the star. So a
 * search saved as "未读" reopened with no "未读" checked, showed an unfiltered
 * count and listed every paper. Same display-value / effective-value split as
 * 171, 178 and 190. One rule now decides membership for the count; the name
 * and the restored filters both come from the same `filters` array.
 */
export interface SavedSearchQuery {
  query: string
  starred: boolean
  filters?: string[]
}

export function savedSearchMatches<
  T extends { id: string; starred?: boolean; folder_uuids?: string[] | null }
>(
  d: T,
  s: SavedSearchQuery,
  testFor: (key: string) => ((d: T) => boolean) | undefined,
  haystack: Map<string, string>,
  folderIds: Set<string> | null
): boolean {
  const q = s.query.trim().toLowerCase()
  if (s.starred && !d.starred) return false
  for (const k of s.filters ?? []) {
    const test = testFor(k)
    if (test && !test(d)) return false
  }
  if (folderIds && !(d.folder_uuids ?? []).some((f) => folderIds.has(f))) return false
  if (q && !(haystack.get(d.id) ?? '').includes(q)) return false
  return true
}
