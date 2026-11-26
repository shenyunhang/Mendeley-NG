/**
 * How a file chosen in the import dialog travels across the IPC boundary.
 *
 * Bibliography formats are UTF-8 text and go to the preview, where a reader
 * can untick duplicates before anything is created. A PDF is the paper
 * itself: its bytes have to reach create-from-file untouched, and its
 * metadata is read by the server rather than by the renderer. One dialog can
 * return both kinds, so the split is a rule of its own rather than a branch
 * buried in a button handler.
 */

/** One file returned by the open dialog. Exactly one payload is present;
 *  which one is decided by the file name in the main process. */
export interface PickedImportFile {
  name: string
  text?: string
  bytes?: ArrayBuffer
}

export interface PickedImportPdf {
  name: string
  bytes: ArrayBuffer
}

export function isPdfImportFileName(name: string): boolean {
  return /\.pdf$/i.test(name)
}

export function splitPickedImportFiles(files: PickedImportFile[]): {
  pdfs: PickedImportPdf[]
  bibliographies: PickedImportFile[]
} {
  const pdfs: PickedImportPdf[] = []
  const bibliographies: PickedImportFile[] = []
  for (const file of files) {
    // An empty ArrayBuffer is still an object, so this is a shape test rather
    // than a size test: a zero-byte PDF must reach the upload and be reported
    // there, not be quietly treated as an empty bibliography file.
    if (file.bytes) pdfs.push({ name: file.name, bytes: file.bytes })
    else bibliographies.push(file)
  }
  return { pdfs, bibliographies }
}
