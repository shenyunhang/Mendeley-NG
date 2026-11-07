/**
 * What a sync is allowed to write back to the local library.
 *
 * A pull can run for minutes. While it is talking to Mendeley the reader may
 * trash a paper, import a PDF, or edit a field — all of which write the same
 * `library.json` the pull is about to overwrite. The old sync wrote the
 * snapshot it had taken at the start straight back to disk, so a paper
 * trashed during a pull came back, and because an incremental merge keeps
 * everything already in the cache, it then stayed there until a full pull.
 *
 * This is a three-way decision rather than a "cloud wins" one:
 *  - `started` is the cache as it was when the pull began;
 *  - `proposed` is what the pull computed (full pull: the cloud's answer;
 *    incremental: the cache plus the changed documents);
 *  - `current` is the same file re-read immediately before writing.
 *
 * `trashedIds` comes from `GET /trash`. `/deleted_documents` is a 404, so
 * this is the only deletion channel the API has; checking it on every pull
 * is what makes an incremental sync able to remove something that a previous
 * race had already written back.
 *
 * Nothing here touches the disk, the network, Electron or React.
 */
export interface SyncReconcile<T extends { id: string }> {
  started: T[]
  proposed: T[]
  current: T[] | null
  trashedIds: Set<string>
}

const same = (a: unknown, b: unknown): boolean =>
  Object.is(a, b) ||
  (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null &&
    JSON.stringify(a) === JSON.stringify(b))

/**
 * A three-way merge at the **field** level for one document that survives the
 * pull. The first version of this module only decided whether a whole row
 * should exist, so a star, a tag, a folder membership or a freshly downloaded
 * `localPdf` written while the pull was in flight was silently replaced by the
 * snapshot taken at the start. A field that the local side changed and the
 * cloud did not belongs to the local side; everything else stays with the
 * cloud answer.
 */
export function mergeDocFields<T extends { id: string }>(
  base: T | undefined,
  ours: T | undefined,
  theirs: T
): T {
  if (!base || !ours) return theirs
  const out = { ...theirs } as Record<string, unknown>
  for (const key of Object.keys(ours) as string[]) {
    const ov = ours[key as keyof T]
    const bv = base[key as keyof T]
    const tv = theirs[key as keyof T]
    if (!same(ov, bv) && same(tv, bv)) out[key] = ov
  }
  return out as T
}

export function reconcileSyncWrite<T extends { id: string }>(
  input: SyncReconcile<T>
): T[] {
  const { started, proposed, current, trashedIds } = input
  const startedIds = new Set(started.map((d) => d.id))
  const currentIds = new Set((current ?? []).map((d) => d.id))

  // A document that was in the starting snapshot but is gone from the file
  // now was removed locally while the pull was in flight. Do not resurrect
  // it. When there is no file to re-read, there is no local edit to protect.
  const locallyDeleted = new Set(
    current === null
      ? []
      : started.filter((d) => !currentIds.has(d.id)).map((d) => d.id)
  )

  const startedById = new Map(started.map((d) => [d.id, d]))
  const currentById = new Map((current ?? []).map((d) => [d.id, d]))
  const kept = proposed
    .filter((d) => !trashedIds.has(d.id) && !locallyDeleted.has(d.id))
    .map((d) => mergeDocFields(startedById.get(d.id), currentById.get(d.id), d))
  const keptIds = new Set(kept.map((d) => d.id))

  // Something added locally during the pull (a dropped PDF, a new folder
  // entry's document) is not in the starting snapshot and is not in the
  // cloud answer; keep it. An id that was in the starting snapshot but is
  // absent from `proposed` is a cloud deletion on a full pull and must stay
  // deleted, which is why `startedIds` excludes it here.
  const localAdditions = (current ?? []).filter(
    (d) => !keptIds.has(d.id) && !startedIds.has(d.id) && !trashedIds.has(d.id)
  )

  return [...kept, ...localAdditions]
}
