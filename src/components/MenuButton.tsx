import { useEffect, useRef, useState } from 'react'
import { usePopSpot } from '../lib/popspot'

export interface MenuItem {
  /** Absent for a separator, which has no label because it is not a choice. */
  label?: string
  title?: string
  disabled?: boolean
  danger?: boolean
  /** A rule rather than an action, for the item that is a different kind of
   *  thing from the ones above it. */
  sep?: boolean
  run?: () => void
}

interface Props {
  label: string
  title?: string
  disabled?: boolean
  /** Highlighted on the bar itself, for the one case where the menu has
   *  something waiting inside it — an update, say. */
  primary?: boolean
  items: MenuItem[]
}

/**
 * Several commands under one entry on the bar.
 *
 * The toolbar is a single row and has to stay one: a button squeezed narrow
 * enough wraps its own label onto two lines, and "检查 / 更新" is harder to
 * read at a glance than a wider button is to fit.  The commands that are not
 * needed every time go in here instead of being squeezed.
 *
 * It stays open until a choice is made, the button is pressed again, Escape,
 * or a press anywhere outside.  It must not close when the pointer leaves the
 * button: the card is `position: fixed` a few pixels below its anchor, so the
 * pointer crosses a strip belonging to neither box on its way to an item.
 * A `mouseleave` on the button therefore dismissed the menu during the
 * ordinary act of reaching for an item, and the horizontal correction near
 * the window edge made the crossing longer and easier to trigger.
 *
 * The column picker and the filter card keep their own pointer-leave rule,
 * but theirs is on the card itself, so moving towards the card never leaves
 * anything.  A dropdown whose items are the whole point of opening it is not
 * the same gesture.
 */
export default function MenuButton({ label, title, disabled, primary, items }: Props) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const spot = usePopSpot(btn, pop, open)

  useEffect(() => {
    if (!open) return
    // A press outside is the way out, not a pointer movement.  Capture, so a
    // press on another toolbar button dismisses this menu before that button
    // opens its own; the button and the card are both "inside".
    const outside = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (btn.current?.contains(t) || pop.current?.contains(t)) return
      setOpen(false)
    }
    // Esc is taken while the event is still travelling down, so that the
    // handler the app keeps on window — which dismisses the settings sheet,
    // the column card and the multi-selection — is not reached on the same
    // press.  One key closing two things is worse than one closing none.
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', h, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', h, true)
    }
  }, [open])

  return (
    <div className="menu-btn">
      <button
        ref={btn}
        className={primary ? 'primary' : ''}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {label} ▾
      </button>
      {open && (
        <div className="menu-pop" ref={pop} style={spot ?? undefined}>
          {items.map((it, i) =>
            it.sep ? (
              <div key={'s' + i} className="menu-sep" />
            ) : (
              <button
                key={it.label}
                className={'menu-item' + (it.danger ? ' danger' : '')}
                disabled={it.disabled}
                title={it.title}
                onClick={() => {
                  setOpen(false)
                  it.run?.()
                }}
              >
                {it.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
