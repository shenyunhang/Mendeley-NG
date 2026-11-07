import type { Annotation, CloudAnnotation, PdfPos } from '../../shared/types'
import { fromCloudPositions } from './pdfgeom'

/**
 * The rules for bringing one paper's marks into step with the cloud.
 *
 * A start-up sync has to work without an open PDF. It cannot measure a page,
 * so it must never invent coordinates: a local mark with `pos` (PDF points,
 * stored by `commitHighlight` when it was drawn) can be pushed, one without
 * it waits until the paper is opened and the manual sync runs. Cloud marks
 * arrive in the same unit and can be merged at once.
 *
 * Writing back is deliberately additive. A background sync must not overwrite
 * a mark the reader drew while it was talking to the network, so the file is
 * re-read before every write and only the fields the cloud actually owns are
 * updated. Nothing here touches the DOM, React, Electron or the network.
 */

export interface MergedAnnotations {
  merged: Annotation[]
  /** Local-only marks that are safe to upload because they carry positions. */
  toPush: { id: string; pos: PdfPos[] }[]
}

/**
 * Merge the cloud's answer for one paper into the marks we already hold.
 *
 * A cloud id we know keeps the local id, colour, text, note and rectangles:
 * Mendeley stores the boxes but not the words, so taking its copy would throw
 * away the only record of what was marked. Its positions are authoritative,
 * though, because they are in PDF points rather than a 0..1 box measured at
 * one particular zoom.
 *
 * A remote id the cloud no longer lists is kept here. Dropping it on the
 * word of a background request might be a partial response, while the manual
 * sync can still prune it with the reader watching.
 */
export function mergeCloudAnnotations(
  docId: string,
  local: Annotation[],
  cloud: CloudAnnotation[],
  now: string
): MergedAnnotations {
  const byRemote = new Map(
    local.filter((a) => a.remoteId).map((a) => [a.remoteId!, a] as const)
  )
  const merged: Annotation[] = []
  for (const c of cloud) {
    const pos = fromCloudPositions(c)
    if (!pos.length && c.type !== 'sticky_note') continue
    const prev = byRemote.get(c.id)
    byRemote.delete(c.id)
    merged.push(
      prev
        ? { ...prev, pos, remoteId: c.id }
        : {
            id: 'cloud-' + c.id,
            docId,
            page: pos[0]?.page ?? 1,
            type: c.type === 'sticky_note' ? 'note' : 'highlight',
            color: '#ffe066',
            rects: [],
            text: c.text,
            note: c.text,
            created: c.created ?? now,
            remoteId: c.id,
            pos
          }
    )
  }
  // What remains in the map was known from the cloud but is absent from this
  // answer; the rest are local-only. Both stay.
  const untouched = local.filter((a) => !a.remoteId || byRemote.has(a.remoteId!))
  const toPush = untouched
    .filter((a): a is Annotation & { pos: PdfPos[] } => !a.remoteId && !!a.pos?.length)
    .map((a) => ({ id: a.id, pos: a.pos }))
  return { merged: [...merged, ...untouched], toPush }
}

/**
 * Re-read the file and apply a merge without losing anything drawn meanwhile.
 * Marks for other papers pass through untouched; for this paper, only the
 * cloud-owned fields are taken from `merged`, and ids that appeared locally
 * in the meantime are appended rather than replaced.
 */
export function applyMergedAnnotations(
  current: Annotation[],
  docId: string,
  merged: Annotation[]
): Annotation[] {
  const mine = current.filter((a) => a.docId === docId)
  const byId = new Map(mine.map((a) => [a.id, a] as const))
  const out = mine.map((a) => {
    const m = merged.find((x) => x.id === a.id)
    return m ? { ...a, remoteId: m.remoteId, pos: m.pos ?? a.pos } : a
  })
  for (const m of merged) if (!byId.has(m.id)) out.push(m)
  return [...current.filter((a) => a.docId !== docId), ...out]
}

/** A successful upload is recorded by id, again against a fresh read. */
export function markPushed(
  current: Annotation[],
  id: string,
  remoteId: string,
  pos: PdfPos[]
): Annotation[] {
  return current.map((a) => (a.id === id ? { ...a, remoteId, pos } : a))
}
