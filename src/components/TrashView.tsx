import { useMemo, useState } from 'react'
import type { Doc } from '../../shared/types'

interface Props {
  docs: Doc[]
  onClose: () => void
  onRestore: (id: string) => void
}

/**
 * Trash browser.  Restoring puts the document back in the library but does not
 * reinstate its folder memberships — Mendeley drops those on trash, and saying
 * so beats letting the user wonder where their folders went.
 */
export default function TrashView({ docs, onClose, onRestore }: Props) {
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return docs
    return docs.filter((d) =>
      [d.title, d.source, d.citation_key, (d.authors ?? []).map((a) => a.last_name ?? '').join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(s)
    )
  }, [docs, q])

  return (
    <div className="pane pane-mid">
      <div className="pane-head">
        <span>回收站</span>
        <span className="grow" />
        <span style={{ color: 'var(--fg-dim)' }}>
          {rows.length} / {docs.length} 条 · 恢复后需重新归入文件夹
        </span>
        <button style={{ padding: '2px 6px', fontSize: '0.733rem' }} onClick={onClose}>
          返回库
        </button>
      </div>
      <div style={{ padding: '6px 8px', flex: '0 0 auto' }}>
        <input
          style={{ width: '100%' }}
          placeholder="在回收站里筛选"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="folders">
        {rows.map((d) => (
          <div key={d.id} className="trash-row" title={d.title}>
            <span className="t">{d.title || '(无标题)'}</span>
            <span className="n">
              {d.authors?.[0]?.last_name ?? ''}
              {d.year ? ` ${d.year}` : ''}
            </span>
            <button
              style={{ padding: '2px 8px', fontSize: '0.733rem' }}
              onClick={() => onRestore(d.id)}
            >
              恢复
            </button>
          </div>
        ))}
        {!rows.length && <div className="empty">回收站是空的</div>}
      </div>
    </div>
  )
}
