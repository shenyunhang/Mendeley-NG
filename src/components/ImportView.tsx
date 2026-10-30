import { useState } from 'react'
import type { Doc } from '../../shared/types'
import { entryToBody, isDuplicate, type Entry } from '../lib/import'

interface Props {
  entries: Entry[]
  docs: Doc[]
  onClose: () => void
  onImported: (docs: Doc[]) => void
}

/**
 * Import preview.  Nothing is sent until the user confirms, and what is shown
 * is what will be created, including the entries that are skipped as already
 * present, because silently importing a duplicate is worse than showing it.
 */
export default function ImportView({ entries, docs, onClose, onImported }: Props) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [skip, setSkip] = useState<number[]>(() =>
    entries.map((e, i) => (isDuplicate(e, docs) ? i : -1)).filter((i) => i >= 0)
  )
  const [picked, setPicked] = useState<number[]>(() =>
    entries.map((_, i) => i).filter((i) => !skip.includes(i))
  )

  const toggle = (i: number) =>
    setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))

  const run = async () => {
    setBusy(true)
    const created: Doc[] = []
    let failed = 0
    for (const i of picked) {
      try {
        created.push(await window.api.createDoc(entryToBody(entries[i])))
      } catch {
        failed++
      }
    }
    setBusy(false)
    setDone(`已导入 ${created.length} 条${failed ? `，失败 ${failed} 条` : ''}`)
    onImported(created)
  }

  return (
    <div className="pane pane-mid">
      <div className="pane-head">
        <span>导入</span>
        <span className="grow" />
        <span style={{ color: 'var(--fg-dim)' }}>
          {entries.length} 条 · 已选 {picked.length} 条 · 跳过 {skip.length} 条重复
        </span>
        <button
          className="primary"
          style={{ padding: '2px 8px', fontSize: '0.733rem' }}
          disabled={busy || !picked.length}
          onClick={run}
        >
          {busy ? '导入中…' : '导入选中项'}
        </button>
        <button style={{ padding: '2px 6px', fontSize: '0.733rem' }} onClick={onClose}>
          关闭
        </button>
      </div>
      {done && <div className="pdf-msg">{done}</div>}
      <div className="folders">
        {entries.map((e, i) => (
          <div
            key={i}
            className="trash-row"
            style={skip.includes(i) ? { opacity: 0.45 } : undefined}
            title={e.title}
          >
            <input
              type="checkbox"
              checked={picked.includes(i)}
              disabled={busy}
              onChange={() => toggle(i)}
            />
            <span className="t">{e.title || '(无标题)'}</span>
            <span className="n">
              {e.authors[0]?.last_name ?? ''}
              {e.year ? ` ${e.year}` : ''}
              {e.source ? ` · ${e.source}` : ''}
            </span>
            <span className="badge">{e.type}</span>
            {skip.includes(i) && <span className="badge">重复</span>}
          </div>
        ))}
        {!entries.length && <div className="empty">没有解析出条目</div>}
      </div>
    </div>
  )
}
