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

      {/*
        Three different reasons a search over the text can come up empty, and
        they are not interchangeable: there may be nothing to read yet, the
        reading may not have been done, or it may have been done for only
        some of the library — which is the one that looks like "the search
        cannot find it" rather than "it was never indexed".
      */}
      {!building && status && !status.total ? (
        <div className="empty">
          <p>没有可索引的 PDF。</p>
          <p className="sub">
            库里还没有带本地 PDF 的文献。设好 PDF 目录、把文件同步或下载下来之后，
            正文才有东西可读。
          </p>
        </div>
      ) : !status?.indexed && !building ? (
        <div className="empty">
          {/* An update that changes how the index is stored loses the old one,
              and "还没有索引" is not what happened.  Saying so is the
              difference between a reader who rebuilds and one who thinks the
              six minutes they spent were thrown away. */}
          <p>{status?.legacy ? '索引要重建一次。' : '还没有索引。'}</p>
          <p className="sub">
            {status?.legacy
              ? '这次更新换了索引的存法：偏移量现在带一个字节锚点，建索引中途退出后下次才能接着建，'
                + '而不用从头再来。旧索引读不了，重建一遍就好。'
              : '建索引会读一遍本地 PDF 的正文，大约每篇 90 毫秒，几千篇要几分钟——中途'
                + '可以停，下次会接着读。'}
            {' '}只取每篇的前 {status?.pages ?? 3} 页：标题、作者、摘要和引言开头，
            也就是要找的词通常在的地方。
          </p>
          {status?.total ? (
            <button style={{ marginTop: 10 }} onClick={() => onBuild(false)}>
              建索引（{status.total} 篇）
            </button>
          ) : null}
        </div>
      ) : !building && status?.skipped?.length ? (
        // Which papers did not make it, and why.  "5237 / 5245" on its own
        // cannot answer the question a reader actually has when a search
        // comes back empty: is the word not in the library, or is it in this
        // one paper that has no text layer?  Only the second one is
        // something they can do anything about.
        <div className="ft-skipped">
          <span>
            {status.skipped.length} 篇没能进索引，搜不到的词可能就在其中：
          </span>
          {status.skipped.slice(0, 4).map((s) => (
            <span key={s.name} className="ft-skip" title={s.why}>
              {s.name} · {s.why}
            </span>
          ))}
          {status.skipped.length > 4 ? (
            <span className="ft-skip">等 {status.skipped.length} 篇</span>
          ) : null}
        </div>
      ) : status && status.indexed < status.total && !building ? (
        <div className="setup-hint">
          <span>
            还有 {status.total - status.indexed} 篇没有索引，它们不在这次的搜索范围内——
            找不到的词可能就在其中。
          </span>
          <button onClick={() => onBuild(false)}>继续索引</button>
        </div>
      ) : null}

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
