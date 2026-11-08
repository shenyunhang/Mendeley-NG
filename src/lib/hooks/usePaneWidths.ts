import { useRef } from 'react'
import { PANE_WIDTH_PERSIST_DEBOUNCE_MS } from '../timing'
import { usePersistAfterMount } from './usePersistAfterMount'
import {
  LEFT_MAX,
  LEFT_MIN,
  MID_MIN,
  RIGHT_MAX,
  RIGHT_MIN,
  clampLeft,
  clampNum,
  clampRight
} from '../panes'

/**
 * The two draggable pane edges, and the widths they are remembered by.
 *
 * Both drags are clamped against the same floor for the middle pane, so
 * neither can squeeze the document list out of existence, and the clamp is
 * recomputed from the live box because the window can be resized between two
 * drags.  The folder tree is a fixed width, because a tree does not get wider
 * when the window does; the reader is a share of the window, because that is
 * exactly what it should follow.  Both are remembered.
 *
 * The widths come from `useConfig` and are written back through it: this hook
 * owns only the dragging, not the persistence of the numbers it drags to.
 */
export function usePaneWidths({
  leftW,
  rightPct,
  setLeftW,
  setRightPct
}: {
  leftW: number
  rightPct: number
  setLeftW: (w: number) => void
  setRightPct: (p: number) => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)

  /**
   * Dragging a pane edge.  Both are clamped against the same floor for the
   * middle pane, so neither drag can squeeze the document list out of
   * existence, and the clamp is recomputed from the live box because the
   * window can be resized between two drags.
   */
  const dragLeft = (x: number) => {
    const box = bodyRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return
    const rightPx = (box.width * rightPct) / 100
    const hi = Math.max(LEFT_MIN, Math.min(LEFT_MAX, box.width - rightPx - MID_MIN))
    setLeftW(Math.round(clampNum(x - box.left, LEFT_MIN, hi)))
  }

  const dragRight = (x: number) => {
    const box = bodyRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return
    // the right pane is a share of the window, so the drag is converted to a
    // percentage: the width the user chose then survives a resize
    const hi = ((box.width - leftW - MID_MIN) / box.width) * 100
    const pct = ((box.right - x) / box.width) * 100
    setRightPct(Math.round(clampNum(pct, RIGHT_MIN, Math.min(RIGHT_MAX, hi)) * 10) / 10)
  }

  /**
   * Remember the widths, but only once the drag has stopped.
   *
   * Saving from the drag's own "mouse up" instead of here is the obvious
   * version and it is wrong: that handler closes over the state of the render
   * it was created in, so releasing inside the same frame as the last move
   * saves the width from before the move.  Waiting on the state settles the
   * question, and the debounce means one write per drag rather than one per
   * frame, which is a hundred writes to a file nobody asked to touch.
   */
  usePersistAfterMount(
    [leftW, rightPct],
    () => {
      void window.api.setConfig({ paneLeft: leftW, paneRight: rightPct })
    },
    PANE_WIDTH_PERSIST_DEBOUNCE_MS
  )

  const setLeft = (w: number) => {
    const next = clampLeft(w)
    setLeftW(next)
    void window.api.setConfig({ paneLeft: next })
  }
  const setRight = (p: number) => {
    const next = clampRight(p)
    setRightPct(next)
    void window.api.setConfig({ paneRight: next })
  }

  return { bodyRef, dragLeft, dragRight, setLeft, setRight }
}
