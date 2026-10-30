import { useEffect, useRef, useState } from 'react'
import { DOC_TYPES, DOC_TYPE_LABELS } from '../lib/doctypes'

export type BatchOp = 'tag-add' | 'tag-del' | 'type' | 'starred' | 'read'

interface OpDef {
  key: BatchOp
  label: string
  /** A value has to be typed, or picked from this list. */
  options?: { value: string; label: string }[]
  free?: boolean
  placeholder?: string
  /** What the button will do, spelled out before it is clicked. */
  hint: string
}

const OPS: OpDef[] = [
  {
    key: 'tag-add',
    label: '追加标签',
    free: true,
    placeholder: '要加的标签，例如 to-read',
    hint: '追加到每条原有的标签之后，不会覆盖'
  },
  {
    key: 'tag-del',
    label: '移除标签',
    free: true,
    placeholder: '要删掉的标签',
    hint: '只删这一个标签，其余保留'
  },
  {
    key: 'type',
    label: '改类型',
    options: DOC_TYPES.map((t) => ({ value: t, label: DOC_TYPE_LABELS[t] ?? t })),
    hint: '整条覆盖，不保留原类型'
  },
  {
    key: 'starred',
    label: '设星标',
    options: [
      { value: 'true', label: '加星' },
      { value: 'false', label: '取消星' }
    ],
    hint: '覆盖，不取反'
  },
  {
    key: 'read',
    label: '设已读',
    options: [
      { value: 'true', label: '已读' },
      { value: 'false', label: '未读' }
    ],
    hint: '覆盖，不取反'
  }
]

interface Props {
  count: number
  onClose: () => void
  onApply: (op: BatchOp, value: string) => Promise<void>
}

/**
 * One field, many documents.  Batching covered folders, the trash and
 * exports, but not metadata: tagging fifty papers meant fifty edits.
 *
 * `tags` is the only field that cannot simply be overwritten, because a
 * document may already carry some; that merge is the caller's job, not the
 * form's.
 */
export default function BatchEdit({ count, onClose, onApply }: Props) {
  const [op, setOp] = useState<BatchOp>('tag-add')
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [op])

  const def = OPS.find((o) => o.key === op)!
  const picked = def.options ? def.options.some((o) => o.value === val) : val.trim().length > 0
  const ready = !busy && picked

  const run = async () => {
    if (!ready) return
    setBusy(true)
    try {
      await onApply(op, val.trim())
    } finally {
      setBusy(false)
      onClose()
    }
  }

  return (
    <div className="modal-veil" onMouseDown={onClose}>
      <div className="modal batch-edit" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">批量修改 {count} 条的字段</div>
        <div className="be-row">
          <span className="be-key">字段</span>
          <select value={op} onChange={(e) => { setOp(e.target.value as BatchOp); setVal('') }}>
            {OPS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="be-row">
          <span className="be-key">值</span>
          {def.options ? (
            <select value={val} onChange={(e) => setVal(e.target.value)}>
              <option value="">请选择…</option>
              {def.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              ref={ref}
              value={val}
              placeholder={def.placeholder}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run()
                if (e.key === 'Escape') onClose()
              }}
            />
          )}
        </div>
        <div className="be-hint">{def.hint}</div>
        <div className="modal-acts">
          <button className="primary" disabled={!ready} onClick={() => void run()}>
            {busy ? '应用中…' : `应用到 ${count} 条`}
          </button>
          <button onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  )
}
