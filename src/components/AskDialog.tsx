import { useEffect, useRef, useState } from 'react'

interface Props {
  title: string
  initial?: string
  placeholder?: string
  onOk: (value: string) => void
  onCancel: () => void
}

/**
 * A one-line question, because `window.prompt` throws in Electron:
 * "prompt() is not supported."  It is present — `typeof` says function — so
 * the failure only shows up when the user actually clicks the button that
 * calls it.  `confirm` does work and is still used as-is.
 */
export default function AskDialog({
  title,
  initial = '',
  placeholder,
  onOk,
  onCancel
}: Props) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  // Esc is taken on the way down, so the app's window listener -- which
  // dismisses the sheets and the multi-selection -- is not reached on the
  // same press. One key closing two things is worse than one closing none.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onCancel])

  return (
    <div className="modal-veil" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">{title}</div>
        <input
          ref={ref}
          value={v}
          placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onOk(v.trim())
          }}
        />
        <div className="modal-acts">
          <button className="primary" onClick={() => onOk(v.trim())}>
            确定
          </button>
          <button onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}
