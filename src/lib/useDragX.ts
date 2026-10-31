import { useEffect, useRef, useState } from 'react'

/**
 * Follow a horizontal drag from a mouse press until the button comes up.
 *
 * The pointer is tracked on `window` rather than on the strip that started the
 * drag: a handle seven pixels wide is outrun by the cursor within a few frames
 * of any real movement, and a drag tracked on the handle itself would stop dead
 * at that moment.  That is the whole reason this exists as a hook rather than
 * as two copies of the same six lines.
 *
 * Moves are coalesced into one per frame.  A pointer event can arrive more
 * often than the screen refreshes, and every move here relayouts a list or a
 * PDF, so handing each one through is work nobody can see.
 */
export function useDragX(onMove: (clientX: number) => void) {
  const [on, setOn] = useState(false)
  // the drag outlives the render it started in, so the callback is reached
  // through a ref instead of a closure that would go stale mid-drag
  const moveRef = useRef(onMove)
  moveRef.current = onMove

  useEffect(() => {
    if (!on) return
    let queued = 0
    let lastX = 0
    const flush = () => {
      queued = 0
      moveRef.current(lastX)
    }
    const move = (e: MouseEvent) => {
      // without this the browser starts a text selection in the pane behind
      // and the drag turns into a highlighted paragraph
      e.preventDefault()
      lastX = e.clientX
      if (!queued) queued = requestAnimationFrame(flush)
    }
    const up = () => {
      // the last move may still be waiting for its frame; dropping it would
      // mean a quick flick — down, move, up inside one frame — moved nothing
      if (queued) {
        cancelAnimationFrame(queued)
        flush()
      }
      setOn(false)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    // the cursor has to stay a resize cursor even once the pointer has run
    // past the strip and is over a pane or a row
    document.body.classList.add('resizing')
    return () => {
      if (queued) cancelAnimationFrame(queued)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
  }, [on])

  const start = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    setOn(true)
  }
  return { on, start }
}
