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
            if (e.key === 'Escape') onCancel()
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
