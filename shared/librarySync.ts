/**
 * The rules that turn a cloud answer into the list a sync proposes to write.
 *
 * They used to sit inline in `pull`, between the network calls and the
 * three-way reconcile, so the only way to check them was to read the pull or
 * run a smoke test against a real library. They are pure: the file existence
 * check is injected, nothing here reads a disk, opens a window or calls the
 * network. The reconcile itself stays in libraryReconcile.ts.
 */

type Identified = { id: string }

/**
 * Full pull: the cloud answer is authoritative and the old cache is dropped.
 * Incremental: the cache is the corpus and `changed` only updates the rows it
 * names, so a paper that was not modified since the watermark survives.
 */
export function mergeChangedIntoCache<T extends Identified>(
  previous: T[],
  changed: T[],
  incremental: boolean
): T[] {
  if (!incremental) return changed
  const byId = new Map(previous.map((d) => [d.id, d]))
  for (const d of changed) byId.set(d.id, d)
  return [...byId.values()]
}

/**
 * Mendeley occasionally answers an incremental change with an empty
 * folder_uuids. Losing a folder membership is far worse than redundantly
 * keeping one, so a known non-empty value wins over a blank fresh one. Only
 * ever called on an incremental pull: a full pull is authoritative.
 *
 * The changed rows are updated in place, because the caller has already put
 * those very objects into the proposed list.
 */
export function keepKnownFolderMemberships<
  T extends Identified & { folder_uuids?: string[] }
>(previous: T[], changed: T[]): void {
  const known = new Map(previous.map((d) => [d.id, d.folder_uuids]))
  for (const d of changed) {
    if (!d.folder_uuids?.length && known.get(d.id)?.length) {
      d.folder_uuids = known.get(d.id)
    }
  }
}

/**
 * A cloud row has no idea where the PDF was saved on this machine. Keep the
 * resolved path across a resync when the file is still there, so an
 * incremental pull does not turn a paper that opens offline into one that
 * needs a download. Rows that already name a path keep their own answer.
 */
export function keepLocalPdfPaths<
  T extends Identified & { localPdf?: string | null }
>(previous: T[], docs: T[], exists: (path: string) => boolean): void {
  const oldById = new Map(previous.map((d) => [d.id, d]))
  for (const d of docs) {
    const old = oldById.get(d.id)
    if (old && !d.localPdf && old.localPdf && exists(old.localPdf)) {
      d.localPdf = old.localPdf
    }
  }
}
