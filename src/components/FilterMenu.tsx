import type { ListFilter } from '../lib/filters'

interface Props {
  on: ListFilter[]
  /** How many papers each switch would leave, counted before the switch is
   *  thrown.  A number answers "is this worth pressing" without pressing. */
  counts: Record<ListFilter, number>
  onToggle: (k: ListFilter) => void
  onClear: () => void
  onClose: () => void
}

const ITEMS: { key: ListFilter; label: string; title: string }[] = [
  { key: 'star', label: '星标', title: '只看打了星的' },
  { key: 'unread', label: '未读', title: '只看还没标为已读的' },
  { key: 'nopdf', label: '没有本地 PDF', title: '本地没有 PDF 的，无论云端有没有' },
  { key: 'cloud', label: '云端有本地没有', title: 'Mendeley 上有附件，本地还没下载' },
  { key: 'unfiled', label: '未归入文件夹', title: '不属于任何文件夹的' }
]

/**
 * The conditions that narrow the list.  Kept as a floating card rather than a
 * modal, for the same reason the column picker is: the point is to watch the
 * table change underneath while boxes are ticked.
 *
 * The counts are what make this worth opening at all — "没有本地 PDF" is the
 * question behind downloading a batch, and knowing beforehand that it is four
 * papers rather than four hundred decides whether it is worth doing now.
 */
export default function FilterMenu({ on, counts, onToggle, onClear, onClose }: Props) {
  return (
    <div className="col-picker filter-menu" onMouseLeave={onClose}>
      <div className="col-picker-head">
        <b>筛选</b>
        <span style={{ flex: 1 }} />
        <button className="mini" title="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="col-list">
        {ITEMS.map((it) => (
          <div className="col-row" key={it.key}>
            <label title={it.title}>
              <input
                type="checkbox"
                checked={on.includes(it.key)}
                onChange={() => onToggle(it.key)}
              />
              {it.label}
            </label>
            <span style={{ flex: 1 }} />
            <span style={{ color: 'var(--fg-dim)' }}>{counts[it.key]}</span>
          </div>
        ))}
      </div>
      <div className="col-picker-foot">
        <button className="mini" disabled={!on.length} onClick={onClear}>
          全部清除
        </button>
      </div>
    </div>
  )
}
