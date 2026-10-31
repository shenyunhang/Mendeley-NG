import { useState } from 'react'
import type { Doc } from '../../shared/types'
import { pickKeeper, type DupeGroup } from '../lib/dupes'

interface Props {
  groups: DupeGroup[]
  onClose: () => void
  onMerge: (g: DupeGroup, keeper: Doc) => void
}

const REASON: Record<DupeGroup['reason'], string> = {
  doi: '同一 DOI',
  arxiv: '同一 arXiv id',
  title: '标题相同'
}

/**
 * Duplicate browser.  Nothing is merged without an explicit click, and the
 * losers go to the trash rather than being deleted, because a wrong merge is
 * otherwise unrecoverable.
 */
export default function DupesView({ groups, onClose, onMerge }: Props) {
  const [keep, setKeep] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const keeperOf = (g: DupeGroup) =>
    g.docs.find((d) => d.id === keep[g.key]) ?? pickKeeper(g.docs)

  return (
    <div className="pane pane-mid">
      <div className="pane-head">
        <span>查重</span>
        <span className="grow" />
        <span style={{ color: 'var(--fg-dim)' }}>
          {groups.length} 组 · 合并会保留最完整的一条，其余移入回收站
        </span>
        <button style={{ padding: '2px 6px', fontSize: '0.733rem' }} onClick={onClose}>
          返回库
        </button>
      </div>
      <div className="folders">
        {groups.map((g) => {
          const keeper = keeperOf(g)
          return (
            <div key={g.key} className="dupe-group">
              <div className="dupe-head">
                <span className="badge">{REASON[g.reason]}</span>
                <span style={{ color: 'var(--fg-dim)' }}>{g.docs.length} 条</span>
                {g.reason === 'title' && (
                  <span style={{ color: 'var(--warn)', fontSize: '0.733rem' }}>
                    仅标题相同，可能是不同文件（如多份 rebuttal）
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  className="primary"
                  style={{ padding: '2px 8px', fontSize: '0.733rem' }}
                  disabled={busy === g.key}
                  onClick={async () => {
                    setBusy(g.key)
                    await onMerge(g, keeper)
                    setBusy(null)
                  }}
                >
                  {busy === g.key ? '合并中…' : '合并'}
                </button>
              </div>
              {g.docs.map((d) => (
                <div
                  key={d.id}
                  className={'trash-row' + (d.id === keeper.id ? ' keeper' : '')}
                  title={d.title}
                >
                  <span className="t">
                    {d.title || '(无标题)'}
                    {d.localPdf ? '' : ' ·'}
                  </span>
                  <span className="n">
                    {d.authors?.[0]?.last_name ?? ''}
                    {d.year ? ` ${d.year}` : ''}
                    {d.source ? ` · ${d.source}` : ''}
                    {d.localPdf ? ' · 有PDF' : ' · 无PDF'}
                  </span>
                  {d.id === keeper.id ? (
                    <span className="badge">保留</span>
                  ) : (
                    <button
                      style={{ padding: '2px 8px', fontSize: '0.733rem' }}
                      onClick={() => setKeep({ ...keep, [g.key]: d.id })}
                    >
                      设为保留
                    </button>
                  )}
                </div>
              ))}
            </div>
          )
        })}
        {!groups.length && <div className="empty">没有发现重复</div>}
      </div>
    </div>
  )
}
