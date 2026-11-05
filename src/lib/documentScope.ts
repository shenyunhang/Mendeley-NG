/**
 * State that belongs to one document, and a read that may only write it while
 * that document is still the one being read.
 *
 * The bug this exists for: the reader does not remount when the paper changes,
 * so `usePdfAnnotations` used to keep the previous paper's highlights in one
 * bare array. Switching papers left them drawn over the new PDF until the new
 * file came back — the "标注 (N)" button, the sidebar list, the "撤销刚才的
 * 高亮" affordance and every highlight rectangle were all the old paper's —
 * and a slow read for the old paper could land last and overwrite the new
 * answer. Worse, any edit made during that window acted on the wrong paper's
 * annotations. The PDF document, its outline, the continuous pages, the links
 * and the references are each loaded behind a `dead` flag in that same
 * component; annotations were the one keyed read without one.
 *
 * Two rules, the same shape as the full-text search: every value carries the
 * id of the document it belongs to, so a mismatch cannot be drawn; every read
 * carries a generation, so a superseded read cannot write at all. There is
 * deliberately no timer here. A search is debounced because typing starts one
 * per keystroke; a file read starts once and should start at once. The extra
 * method this one needs is a bare `cancel`, so a highlight made by hand can
 * invalidate a read that is already on its way without scheduling anything.
 *
 * Nothing here knows about React, Electron, PDFs or the DOM. The read and the
 * renderer are injected so the ordering can be checked by resolving promises
 * by hand rather than by sleeping.
 */

export interface ForDocument<T> {
  docId: string
  value: T
}

/**
 * `undefined` means "no answer for this document yet". An empty array is an
 * answer — a paper with no highlights — and must not be confused with it, or
 * the reader would wait forever for marks that were already counted.
 */
export function valueForDocument<T>(
  state: ForDocument<T> | null,
  docId: string
): T | undefined {
  return state && state.docId === docId ? state.value : undefined
}

export interface DocumentLoad<T> {
  /** Read for `docId`, superseding any read still in flight. */
  start: (docId: string) => void
  /** Invalidate an in-flight read without writing: on unmount, on a document
   *  switch, and whenever a local edit should win over a read already out. */
  cancel: () => void
}

export function createDocumentLoad<T>(
  load: (docId: string) => Promise<T>,
  render: (state: ForDocument<T>) => void,
  /** What a failed read answers with. */
  empty: T
): DocumentLoad<T> {
  let generation = 0
  return {
    start(docId) {
      const mine = ++generation
      load(docId).then(
        (value) => {
          if (mine === generation) render({ docId, value })
        },
        () => {
          if (mine === generation) render({ docId, value: empty })
        }
      )
    },
    cancel() {
      ++generation
    }
  }
}
