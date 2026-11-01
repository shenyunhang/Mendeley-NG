import { useRef, type RefObject } from 'react'
import { COLUMNS, DEFAULT_COLS, type ColKey } from '../lib/columns'
import { usePopSpot } from '../lib/popspot'
import type { SavedView } from '../../shared/types'

interface Props {
  /** The button it hangs from; see `spotFor` for why it cannot be placed by
   *  CSS any more. */
  anchor: RefObject<HTMLElement>
  cols: ColKey[]
  onChange: (cols: ColKey[]) => void
  views: SavedView[]
  onSaveView: () => void
  onApplyView: (v: SavedView) => void
  onDeleteView: (id: string) => void
  onClose: () => void
}

/**
 * Which columns the table shows, and in what order.  Kept as a floating card
 * rather than a modal: the point is to see the table change underneath while
 * boxes are ticked, which a modal would hide.
 */
export default function ColumnPicker({
  anchor,
  cols,
  onChange,
  views,
  onSaveView,
  onApplyView,
  onDeleteView,
  onClose
}: Props) {
  const card = useRef<HTMLDivElement>(null)
  const spot = usePopSpot(anchor, card)
  const toggle = (k: ColKey) => {
    // the last column cannot be switched off: a table with no columns is not
    // a view of anything
    if (cols.includes(k)) {
      if (cols.length === 1) return
      onChange(cols.filter((c) => c !== k))
    } else {
      onChange([...cols, k])
    }
  }

  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= cols.length) return
    const next = [...cols]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div className="col-picker" ref={card} style={spot ?? undefined} onMouseLeave={onClose}>
      <div className="col-picker-head">
        <b>列</b>
        <span style={{ flex: 1 }} />
        <button className="mini" title="关闭" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="col-list">
        {COLUMNS.map((c) => {
          const on = cols.includes(c.key)
          const i = cols.indexOf(c.key)
          return (
            <div key={c.key} className="col-row">
              <label>
                <input type="checkbox" checked={on} onChange={() => toggle(c.key)} />
                <span>{c.label || 'PDF'}</span>
              </label>
              <span className="col-move">
                <button
                  className="mini"
                  disabled={!on || i <= 0}
                  title="上移"
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  className="mini"
                  disabled={!on || i < 0 || i >= cols.length - 1}
                  title="下移"
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
              </span>
            </div>
          )
        })}
      </div>

      <div className="col-picker-foot">
        <button onClick={onSaveView}>保存为视图…</button>
        <span style={{ flex: 1 }} />
        <button onClick={() => onChange([...DEFAULT_COLS])} title="回到默认那几列">
          恢复默认
        </button>
      </div>

      {!!views.length && (
        <div className="col-views">
          <div className="group-head">视图</div>
          {views.map((v) => (
            <div key={v.id} className="ol-row" onClick={() => onApplyView(v)} title={v.cols.join(' · ')}>
              <span className="name">{v.name}</span>
              <span className="acts">
                <button
                  className="mini"
                  title="删除这个视图"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteView(v.id)
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
