import type { Doc, Folder } from '../../shared/types'

/**
 * Which folder the tree should point at after a paper is opened from inside
 * another paper — the "打开" button of a citation popover, or a link in the
 * PDF that names a paper already on the shelf.
 *
 * `folderId` is both the tree's highlight and the list's filter. Moving it
 * keeps what is shown and what is selected the same thing; a separate
 * highlight-only state would put a folder name in the tree while the list
 * answered for a different one, which is the split 171 had to fix.
 *
 * Three answers that are easy to get wrong:
 *  - a paper in no folder clears the folder rather than leaving the tree
 *    pointing at one that does not contain the paper now on screen;
 *  - a paper that is already inside the folder on screen leaves it alone,
 *    so opening a reference does not yank the list away from the reader;
 *  - a folder id the library no longer has is skipped, because a deleted
 *    folder would leave the filter showing nothing.
 *
 * Nothing here knows about React, Electron or the DOM.
 */
export function folderForOpenedDoc(
  doc: Doc | undefined,
  currentFolderId: string | null,
  folders: Folder[]
): string | null {
  const ids = doc?.folder_uuids ?? []
  if (!ids.length) return null
  if (currentFolderId && ids.includes(currentFolderId)) return currentFolderId
  const known = new Set(folders.map((f) => f.id))
  return ids.find((id) => known.has(id)) ?? null
}
