import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface RowMenuItem {
  /** Absent for a separator, which has no label because it is not a choice. */
  label?: string
  title?: string
  /** A rule rather than an action. */
  sep?: boolean
  danger?: boolean
  disabled?: boolean
  run?: () => void
}

interface Props {
  x: number
  y: number
  /** The heading, e.g. how many rows the actions will apply to. */
  head?: string
  items: RowMenuItem[]
  onClose: () => void
}

const W = 208
const MARGIN = 8

/**
 * The menu a row answers a right click with.  Everything in it is an action
 * that otherwise costs a trip to the toolbar or a drag across the window.
 *
 * It is a plain absolutely positioned card rather than a native menu: the
 * actions are the renderer's own, and a native menu would mean another round
 * of IPC for every item.
 */
export default function RowMenu({ x, y, head, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Opened downwards and rightwards by default, then pulled back in when that
  // would put part of the card outside the window: a menu that opens
  // half-offscreen is the classic sign of one that does not measure.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight || 240
    const left =
      x + W + MARGIN > window.innerWidth ? Math.max(MARGIN, x - W) : x
    const top =
      y + h + MARGIN > window.innerHeight ? Math.max(MARGIN, y - h) : y
    setPos({ left, top })
  }, [x, y, items.length])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // capture, so a menu dismissed by a click on a row does not also let that
    // click through and open another one
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    // a scroll moves the rows out from under the menu, and a menu left behind
    // is worse than one dismissed
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="row-menu"
      style={{ left: pos.left, top: pos.top, width: W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {head && <div className="row-menu-head">{head}</div>}
      {items.map((it, i) =>
        it.sep ? (
          <div key={'s' + i} className="row-menu-sep" />
        ) : (
          <button
            key={it.label}
            className={'row-menu-item' + (it.danger ? ' danger' : '')}
            disabled={it.disabled}
            title={it.title}
            onClick={() => {
              onClose()
              it.run?.()
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  )
}
