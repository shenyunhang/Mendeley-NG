import { useCallback, useRef, useState } from 'react'

/**
 * One step of undo.  `run` is a closure rather than a description of the
 * change, because the operations being undone are all cloud calls whose
 * inverse is another cloud call; there is no shared state to diff against.
 */
export interface UndoEntry {
  id: string
  label: string
  run: () => Promise<void>
}

/**
 * The undo stack.
 *
 * Kept here rather than in the component because the keydown listener is
 * installed once and has to reach the stack through a ref: a closure captured
 * at mount would still be looking at the first render's empty list, and Ctrl+Z
 * would undo nothing.  What the stack holds belongs to no one view — every
 * panel in the app can put a step on it.
 */
export function useUndo(onError: (message: string) => void) {
  const [undo, setUndo] = useState<UndoEntry[]>([])

  /** Most recent last, capped: an undo stack that grows without bound is a
   *  memory leak dressed up as a feature. */
  const pushUndo = useCallback((label: string, run: () => Promise<void>) => {
    setUndo((s) => [...s, { id: 'u' + Date.now().toString(36), label, run }].slice(-20))
  }, [])

  const doUndo = async () => {
    const top = undo[undo.length - 1]
    if (!top) return
    // pop first, so a failure cannot leave the same step to be retried
    // forever against a cloud that has already moved on
    setUndo((s) => s.slice(0, -1))
    try {
      await top.run()
    } catch (e) {
      onError('撤销失败：' + String(e))
    }
  }

  // read by the keydown listener, which is installed once and outlives every
  // render: it has to be handed the current stack, not the one at mount
  const undoRef = useRef<() => void>(() => {})
  undoRef.current = () => {
    void doUndo()
  }

  return { undo, pushUndo, doUndo, undoRef }
}
