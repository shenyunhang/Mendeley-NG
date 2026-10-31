import { useEffect, useState } from 'react'

export interface MenuItem {
  label: string
  title?: string
  disabled?: boolean
  danger?: boolean
  run: () => void
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
 * It closes when the pointer leaves, which is how the column picker and the
 * filter card behave, so the bar is consistent about what a menu does.
 */
export default function MenuButton({ label, title, disabled, primary, items }: Props) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
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
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [open])

  return (
    <div className="menu-btn" onMouseLeave={() => setOpen(false)}>
      <button
        className={primary ? 'primary' : ''}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {label} ▾
      </button>
      {open && (
        <div className="menu-pop">
          {items.map((it) => (
            <button
              key={it.label}
              className={'menu-item' + (it.danger ? ' danger' : '')}
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                setOpen(false)
                it.run()
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
