import { useMemo } from 'react'
import type { Doc, FtHit, FtStatus } from '../../shared/types'
import { compareDocs, type SortKey } from '../lib/columns'

interface Props {
  query: string
  hits: FtHit[]
  docs: Doc[]
  /** How the reader has asked for papers to be ordered.  The same answer
   *  governs this list as the catalogue's: a hit is a place inside a paper,
   *  but what is being listed is still papers, and a control that says 排序
   *  has to mean the same thing whichever list it is looking at. */
  sort: { key: SortKey; dir: 1 | -1 }
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
  sort,
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

  // One row per document, with every page it matched on, in the order the
  // reader asked for.  Without this a hit comes out in the order it happens
  // to sit in the index file, which is the order the papers were read in and
  // means nothing to anybody looking at the list.
  const groups = useMemo(() => {
    const m = new Map<string, FtHit[]>()
    for (const h of hits) {
      const list = m.get(h.docId)
      if (list) list.push(h)
      else m.set(h.docId, [h])
    }
    const withDoc = [...m.entries()].map(([id, hs]) => ({ id, hs, d: byId.get(id) }))
    withDoc.sort((a, b) => {
      if (!a.d || !b.d) return a.d ? -1 : b.d ? 1 : 0
      return compareDocs(a.d, b.d, sort.key, sort.dir)
    })
    return withDoc
  }, [hits, byId, sort])

  const building = status?.building
  const pct =
    status && status.total
      ? Math.round((status.done / status.total) * 100)
      : 0

  /**
   * Which papers did not make it, and why.  "5237 / 5245" on its own cannot
   * answer the question a reader actually has when a search comes back
   * empty: is the word not in the library, or is it in this one paper that
   * has no text layer?  Only the second one is something they can do
   * anything about.
   */
  const skipNote = status?.skipped.length ? (
    <div className="ft-skipped">
      <span>{status.skipped.length} 篇没能进索引，搜不到的词可能就在其中：</span>
      {status.skipped.slice(0, 6).map((s) => (
        <span key={s.name} className="ft-skip" title={s.why}>
          {s.name} · {s.why}
        </span>
      ))}
      {status.skipped.length > 6 ? (
        <span className="ft-skip">等 {status.skipped.length} 篇</span>
      ) : null}
    </div>
  ) : null

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
          onClick={() => onBuild(true)}
        >
          重建
        </button>
        <button
          style={{ padding: '2px 6px', fontSize: '0.733rem' }}
          disabled={building}
          title="删除索引"
          onClick={() => onClear()}
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
      {/*
        A run that finished having read nothing used to land on "还没有索引",
        the same words as a library that has never been indexed.  Those are
        not the same thing at all: one is a reader who has been told to wait
        six more minutes for a build they already did, and the other is a
        reader who has been told nothing about why every paper failed.  When
        the run is over and there is nothing to show, the reasons are the
        answer, however unflattering they are.
      */}
      {!building && status && !status.total ? (
        <div className="empty">
          <p>没有可索引的 PDF。</p>
          <p className="sub">
            库里还没有带本地 PDF 的文献。设好 PDF 目录、把文件同步或下载下来之后，
            正文才有东西可读。
          </p>
        </div>
      ) : !building && status?.reader ? (
        <div className="empty">
          {/* A reader that will not start is one fact about the install, not
              five thousand facts about five thousand PDFs.  Every document
              fails the same way, so the only honest thing to show is what the
              reader said and that it is not the papers' fault — anything else
              sends somebody off to "fix" files that were never broken. */}
          <p>pdf.js 起不来，不是这些 PDF 的问题。</p>
          <p className="sub">
            读的时候 pdf.js 报的是：<code className="ft-err">{status.reader}</code>
          </p>
          <p className="sub">
            最常见的成因是包里少了 pdf.js 的 worker 线程文件——那样<strong>每一篇</strong>
            都会以同样一句话失败，跟 PDF 本身无关。重装或升级到修复后的版本即可；
            同一台机器上从源码跑（<code>npm start</code>）能读到正文，就说明是装的这个包缺文件。
          </p>
        </div>
      ) : !building && status && !status.indexed && status.done > 0 && status.skipped.length ? (
        <div className="empty">
          <p>读完了，但一篇正文都没读出来。</p>
          <p className="sub">
            下面是最前面几篇失败的原因。如果条条都是「文件不在原处」，
            是 PDF 目录变了、或者文件被挪走了——去设置里重新指一次目录再同步；
            如果条条都是「PDF 打不开」或「读超时」，那是 pdf.js 在这台机器上起不来，
            重跑一遍通常没用。扫描件没有文本层是正常的，不是故障。
          </p>
          {skipNote}
          <button style={{ marginTop: 10 }} onClick={() => onBuild(true)}>
            重建索引
          </button>
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
      ) : !building && status?.skipped.length ? (
        skipNote
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
            groups.map(({ id, hs: list, d }) => {
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
