import { useDragX } from '../lib/useDragX'

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
 * The drag itself lives in `useDragX` rather than here, because the column
 * headers need exactly the same thing and a second copy of "track the pointer
 * on the window" is a second place for it to be wrong.
 */
export default function Splitter({ onMove, onReset, title, onNudge }: Props) {
  const { on, start } = useDragX(onMove)

  return (
    <div
      className={'splitter' + (on ? ' on' : '')}
      title={title ?? '拖动改变宽度，双击复位'}
      role="separator"
      aria-orientation="vertical"
      tabIndex={onNudge ? 0 : -1}
      onMouseDown={start}
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
