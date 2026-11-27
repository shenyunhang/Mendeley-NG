import { useMemo } from 'react'
import { READ_ON_DOUBLE_CLICK_PROPS } from '../lib/doubleClickRead'
import { normaliseQuery } from '../lib/searchScope'
import { markAllTerms } from '../lib/match'
import type { Doc, RefHit } from '../../shared/types'
import { useI18n } from '../lib/i18nContext'

interface Props {
  query: string
  hits: RefHit[]
  docs: Doc[]
  building: boolean
  progress: { done: number; total: number } | null
  status: { indexed: number; total: number } | null
  error: string | null
  onBuild: () => void
  onClose: () => void
  onOpen: (d: Doc, page: number) => void
}

/** A hit reads better with the word that found it marked, and the snippet is
 *  already centred on that word by the index. Lower-casing does not move the
 *  offset on ordinary text, so the cut can be made on the original string. */
function Snippet({ text, query, terms }: { text: string; query: string; terms?: string[] }) {
  // A near hit has no verbatim query inside its snippet, so the index sends
  // the words that really occur and all of them get marked.
  if (terms?.length) {
    return (
      <>
        {markAllTerms(text, terms).map((p, i) =>
          p.hit ? <mark key={i}>{p.t}</mark> : <span key={i}>{p.t}</span>
        )}
      </>
    )
  }
  // The IPC and the index use the same normalisation; the snippet itself is
  // already normalised. Using the raw query here would silently lose the mark
  // on a term typed with two spaces.
  const q = normaliseQuery(query)
  const i = q.length ? text.toLowerCase().indexOf(q) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

/**
 * References results. Like the full-text panel this replaces the document
 * list, because a hit is a place at the end of a PDF, not a row in the
 * catalogue. The two panels deliberately share their CSS so the reader does
 * not have to learn a second list.
 */
export default function RefsView({
  query,
  hits,
  docs,
  building,
  progress,
  status,
  error,
  onBuild,
  onClose,
  onOpen
}: Props) {
  const t = useI18n()
  const byId = useMemo(() => {
    const m = new Map<string, Doc>()
    for (const d of docs) m.set(d.id, d)
    return m
  }, [docs])

  const groups = useMemo(() => {
    const m = new Map<string, RefHit[]>()
    for (const h of hits) {
      const list = m.get(h.docId)
      if (list) list.push(h)
      else m.set(h.docId, [h])
    }
    return [...m.entries()]
      .map(([id, hs]) => ({ id, hs, d: byId.get(id) }))
      .sort((a, b) => (a.d?.title ?? a.id).localeCompare(b.d?.title ?? b.id))
  }, [hits, byId])

  const pct =
    progress && progress.total
      ? Math.round((progress.done / progress.total) * 100)
      : 0

  return (
    <div className="pane pane-mid">
      <div className="pane-head">
        <span>{t('参考文献')}</span>
        <span className="grow" />
        <span style={{ fontSize: '0.733rem', color: 'var(--fg-dim)' }}>
          {status ? `已索引 ${status.indexed} / ${status.total} 篇` : '…'}
        </span>
        <button
          style={{ padding: '2px 6px', fontSize: '0.733rem' }}
          disabled={building}
          title="读取每篇本地 PDF 末尾的参考文献段；已索引且文件未变的会跳过"
          onClick={onBuild}
        >
          {building ? `索引中 ${pct}%` : t('建索引')}
        </button>
        <button style={{ padding: '2px 6px', fontSize: '0.733rem' }} onClick={onClose}>
          {t('返回列表')}
        </button>
      </div>

      {building && (
        <div className="batch-bar">
          <span>
            正在读取参考文献 {progress?.done ?? 0} / {progress?.total ?? 0}（{pct}%）
          </span>
          <span className="ft-current">只读取每篇 PDF 末尾的参考文献段</span>
        </div>
      )}

      {error ? (
        <div className="empty">
          <p>建索引时出错了。</p>
          <p className="sub">{error}</p>
        </div>
      ) : !building && status && !status.total ? (
        <div className="empty">
          <p>{t('没有可索引的 PDF。')}</p>
          <p className="sub">
            库里还没有带本地 PDF 的文献。参考文献是从 PDF 末尾现读的，先同步或下载 PDF。
          </p>
        </div>
      ) : !building && !status?.indexed ? (
        <div className="empty">
          <p>还没有参考文献索引。</p>
          <p className="sub">
            建索引会读一遍每篇本地 PDF 的末尾几页，找「References / 参考文献」那一段。
            参考文献索引是单独建的，从每篇 PDF 末尾现读，和正文索引互不影响。
          </p>
          {status?.total ? (
            <button style={{ marginTop: 10 }} onClick={onBuild}>
              建索引（{status.total} 篇）
            </button>
          ) : null}
        </div>
      ) : (
        <div className="ft-list">
          {!query.trim() ? (
            <div className="empty">{t('输入要找的词')}</div>
          ) : building ? (
            <div className="empty">正在建立索引，稍后就能搜「{query}」…</div>
          ) : !groups.length ? (
            <div className="empty">
              <p>参考文献里没找到「{query}」。</p>
              <p className="sub">
                只搜每篇 PDF 末尾识别出的参考文献段；找不到该段的文献不在这次范围内。
              </p>
            </div>
          ) : (
            groups.map(({ id, hs, d }) => (
              // Double clicking a hit reads the paper it belongs to, at the
              // page the single click already opened.
              <div key={id} data-id={id} className="ft-row" {...READ_ON_DOUBLE_CLICK_PROPS}>
                <div
                  className="ft-title"
                  onClick={() => d && onOpen(d, hs[0]!.page)}
                  title={d?.title}
                >
                  {d?.title || t('(无标题)')}
                  <span className="ft-meta">
                    {d?.year ? ` ${d.year}` : ''}
                    {d?.source ? ` · ${d.source}` : ''}
                  </span>
                  {hs.some((h) => h.near) ? (
                    <span className="ft-near" title="没有完全匹配的结果，这是按词形相近找到的">
                      {t('相近')}
                    </span>
                  ) : null}
                </div>
                {hs.slice(0, 4).map((h, i) => (
                  <div
                    key={i}
                    className="ft-hit"
                    onClick={() => d && onOpen(d, h.page)}
                    title="打开这一页"
                  >
                    <span className="pg">p{h.page}</span>
                    <span className="ft-snip" title={h.snippet}>
                      <Snippet
                        text={h.snippet}
                        query={query}
                        terms={h.near ? h.terms : undefined}
                      />
                    </span>
                  </div>
                ))}
                {hs.length > 4 && <div className="ft-more">还有 {hs.length - 4} 处…</div>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
