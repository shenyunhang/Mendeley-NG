import { useEffect, useRef } from 'react'

interface Props {
  /** What is about to happen, named: "删除文件夹「综述」" */
  title: string
  /**
   * What it means, including whether it can be taken back.  "移入回收站，
   * 可以在回收站里恢复" and "彻底删除，不可恢复" are two different decisions,
   * and a box that does not say which one this is has not really asked.
   */
  body?: string
  /** Label for the button that does it.  Defaults to 删除. */
  ok?: string
  onOk: () => void
  onCancel: () => void
}

/**
 * The second question before anything that cannot be taken back.
 *
 * It exists instead of `window.confirm` for three reasons.  A native dialog
 * does not follow the theme, so it is a white system box over a dark app.  It
 * cannot say whether the thing can be undone, which is most of what the
 * reader is deciding on.  And it cannot be tested: the smoke run had to stub
 * it to always refuse, which meant the paths behind it were never exercised.
 *
 * Focus starts on 取消 rather than on the button that does it.  A box that
 * puts the cursor on 确定 turns a stray Enter into a deletion, and the whole
 * point of asking is that it should take a deliberate press.
 */
export default function ConfirmDialog({ title, body, ok = '删除', onOk, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onCancel])

  return (
    <div className="modal-veil" onMouseDown={onCancel}>
      <div className="modal confirm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">{title}</div>
        {body ? <div className="confirm-body">{body}</div> : null}
        <div className="modal-acts">
          <button className="danger" onClick={onOk}>
            {ok}
          </button>
          <button ref={cancelRef} onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
