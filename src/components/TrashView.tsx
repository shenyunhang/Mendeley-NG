import { useMemo, useState } from 'react'
import type { Doc } from '../../shared/types'

interface Props {
  docs: Doc[]
  onClose: () => void
  onRestore: (id: string) => void
  onPurge?: (id: string) => void
  /** Open one of the trashed papers.
   *
   *  The bin is a list of names, but "do I want this back" is a question
   *  about the paper, and a name is not enough to answer it.  Without this
   *  the reader has to restore a document they cannot see, go find it in
   *  five thousand, and come back — or more likely decide from the title
   *  alone, which is how a wrong restore happens. */
  onOpen: (d: Doc) => void
  /** Which paper the right pane is showing.  Several deleted entries can
   *  share a title, so the one being looked at has to say so. */
  openId?: string | null
}

/**
 * Trash browser.  Restoring puts the document back in the library but does not
 * reinstate its folder memberships — Mendeley drops those on trash, and saying
 * so beats letting the user wonder where their folders went.
 */
export default function TrashView({
  docs,
  onClose,
  onRestore,
  onPurge,
  onOpen,
  openId
}: Props) {
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
          {rows.length} / {docs.length} 条 · 点一行看 PDF 或详情 · 恢复后需重新归入文件夹
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
      <div className="folders trash-list">
        {rows.map((d) => (
          <div
            key={d.id}
            // which paper a row is cannot be asked by position: the same
            // class carries the duplicate group's rows too, and a check that
            // names one has to be able to name it
            data-id={d.id}
            className={'trash-row' + (d.id === openId ? ' open' : '')}
            title={
              (d.title ?? '')
              + (d.localPdf ? '　点一下打开 PDF' : '　没有本地文件，点一下看详情')
            }
            onClick={() => onOpen(d)}
          >
            <span className="t">{d.title || '(无标题)'}</span>
            <span className="n">
              {d.authors?.[0]?.last_name ?? ''}
              {d.year ? ` ${d.year}` : ''}
              {d.localPdf ? ' · 有PDF' : ' · 无PDF'}
            </span>
            <button
              style={{ padding: '2px 8px', fontSize: '0.733rem' }}
              // the row opens the paper, so this one has to say it is not
              // the row: pressing 恢复 and having the right pane jump to a
              // different paper is the sort of surprise that makes people
              // stop pressing buttons in a list they are using to decide
              onClick={(e) => {
                e.stopPropagation()
                onRestore(d.id)
              }}
            >
              恢复
            </button>
            {onPurge && (
              <button
                className="danger"
                style={{ padding: '2px 8px', fontSize: '0.733rem' }}
                title="不可恢复，云端记录也会一并删除"
                onClick={(e) => {
                  e.stopPropagation()
                  onPurge(d.id)
                }}
              >
                彻底删除
              </button>
            )}
          </div>
        ))}
        {!rows.length && <div className="empty">回收站是空的</div>}
      </div>
    </div>
  )
}
