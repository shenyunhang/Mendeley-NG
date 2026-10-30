import { useEffect, useRef, useState } from 'react'

interface Props {
  /** Called with the pointer's viewport x on every move of the drag. */
  onMove: (clientX: number) => void
  /** Double click puts the edge back where it started. */
  onReset?: () => void
  title?: string
  /** Nudge with the arrow keys, for anyone not using a mouse. */
  onNudge?: (px: number) => void
}

/**
 * The draggable edge between two panes.
 *
 * The pointer is tracked on `window` rather than on the bar itself: a drag
 * that outruns the pointer would otherwise stop dead the moment the cursor
 * left a five-pixel strip, and that is exactly what happens when someone
 * drags quickly.
 *
 * Moves are coalesced into one per frame.  A pointer event can arrive more
 * often than the screen refreshes, and every move here relayouts a PDF.
 */
export default function Splitter({ onMove, onReset, title, onNudge }: Props) {
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
    // past the seven-pixel bar and is over a pane
    document.body.classList.add('resizing')
    return () => {
      if (queued) cancelAnimationFrame(queued)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
  }, [on])

  return (
    <div
      className={'splitter' + (on ? ' on' : '')}
      title={title ?? '拖动改变宽度，双击复位'}
      role="separator"
      aria-orientation="vertical"
      tabIndex={onNudge ? 0 : -1}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        setOn(true)
      }}
      onDoubleClick={() => onReset?.()}
      onKeyDown={(e) => {
        if (!onNudge) return
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          onNudge(-16)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          onNudge(16)
        }
      }}
    />
  )
}
