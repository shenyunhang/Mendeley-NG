import { useMemo } from 'react'
import type { Doc, FtHit, FtStatus } from '../../shared/types'

interface Props {
  query: string
  hits: FtHit[]
  docs: Doc[]
  status: FtStatus | null
  onClose: () => void
  onOpen: (d: Doc, page: number) => void
  onBuild: (rebuild: boolean) => void
  onCancel: () => void
  onClear: () => void
}

/**
 * Full-text results.  It replaces the document list rather than filtering it,
 * because a hit is a place inside a paper, not a paper: the row that matters
 * is the snippet, and the list would only get in the way of it.
 */
export default function FullTextView({
  query,
  hits,
  docs,
  status,
  onClose,
  onOpen,
  onBuild,
  onCancel,
  onClear
}: Props) {
  const byId = useMemo(() => {
    const m = new Map<string, Doc>()
    for (const d of docs) m.set(d.id, d)
    return m
  }, [docs])

  // one row per document, with every page it matched on
  const groups = useMemo(() => {
    const m = new Map<string, FtHit[]>()
    for (const h of hits) {
      const list = m.get(h.docId)
      if (list) list.push(h)
      else m.set(h.docId, [h])
    }
    return [...m.entries()]
  }, [hits])

  const building = status?.building
  const pct =
    status && status.total
      ? Math.round((status.done / status.total) * 100)
      : 0

  return (
    <div className="pane pane-mid">
      <div className="pane-head">
        <span>全文检索</span>
        <span className="grow" />
        <span style={{ fontSize: '0.733rem', color: 'var(--fg-dim)' }}>
          {status
            ? `已索引 ${status.indexed} / ${status.total} 篇 · 每篇前 ${status.pages} 页`
            : '…'}
        </span>
        <button
          style={{ padding: '2px 6px', fontSize: '0.733rem' }}
          disabled={building}
          title="把还没索引的本地 PDF 补进索引"
          onClick={() => onBuild(false)}
        >
          {building ? `索引中 ${pct}%` : '建索引'}
        </button>
        <button
          style={{ padding: '2px 6px', fontSize: '0.733rem' }}
          disabled={building}
          title="清空并从头重建（已删文献留下的空洞只有重建能回收）"
          onClick={() => {
            if (!confirm('清空全文索引并从头重建？会重新读取全部本地 PDF。')) return
            onBuild(true)
          }}
        >
          重建
        </button>
        <button
          style={{ padding: '2px 6px', fontSize: '0.733rem' }}
          disabled={building}
          title="删除索引"
          onClick={() => {
            if (!confirm('删除全文索引？搜索正文前需要重建。')) return
            onClear()
          }}
        >
          清空
        </button>
        <button style={{ padding: '2px 6px', fontSize: '0.733rem' }} onClick={onClose}>
          返回列表
        </button>
      </div>

      {building && (
        <div className="batch-bar">
          <span>
            正在读取 PDF 正文 {status?.done ?? 0} / {status?.total ?? 0}（{pct}%）
          </span>
          {/* which file is the only honest answer to "is it stuck?": a bar
              that has not moved for a minute looks exactly like a hang */}
          <span className="ft-current" title={status?.current}>
            {status?.current || ''}
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="danger"
            style={{ padding: '2px 6px', fontSize: '0.733rem' }}
            title="停下。已经读进去的会留着，下次接着读"
            onClick={onCancel}
          >
            停止
          </button>
        </div>
      )}

      {!status?.indexed && !building && (
        <div className="empty">
          还没有索引。点「建索引」读取本地 PDF 的正文，大约每篇 90 毫秒，
          几千篇要几分钟——中途可以停，下次会接着读。
        </div>
      )}

      {status?.indexed ? (
        <div className="ft-list">
          {!query.trim() ? (
            <div className="empty">输入要找的词</div>
          ) : !groups.length ? (
            <div className="empty">
              正文里没找到「{query}」。注意只索引了每篇的前 {status.pages} 页。
            </div>
          ) : (
            groups.map(([id, list]) => {
              const d = byId.get(id)
              return (
                <div key={id} className="ft-row">
                  <div
                    className="ft-title"
                    onClick={() => d && onOpen(d, list[0].page)}
                    title={d?.title}
                  >
                    {d?.title || '(无标题)'}
                    <span className="ft-meta">
                      {d?.year ? ` ${d.year}` : ''}
                      {d?.source ? ` · ${d.source}` : ''}
                    </span>
                  </div>
                  {list.slice(0, 4).map((h, i) => (
                    <div
                      key={i}
                      className="ft-hit"
                      onClick={() => d && onOpen(d, h.page)}
                      title="打开这一页"
                    >
                      <span className="pg">p{h.page}</span>
                      <span className="ft-snip">{h.snippet}</span>
                    </div>
                  ))}
                  {list.length > 4 && (
                    <div className="ft-more">还有 {list.length - 4} 处…</div>
                  )}
                </div>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
}
