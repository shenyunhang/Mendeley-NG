import type { Doc } from '../../shared/types'

interface Props {
  doc: Doc
  onRestore: () => void
  onPurge: () => void
  onOpenPdf: () => void
}

/** What the right pane shows for a paper that is in the bin.
 *
 *  DetailsPanel is an editor: it writes fields back to the cloud and moves
 *  folder memberships.  A trashed document is not in the library, so those
 *  calls do not describe anything that exists there — and a "移入回收站"
 *  button on a document already in the bin is a contradiction.  This is a
 *  read-only view of the same record, with the two things that really are
 *  available: look at the file, or put the paper back. */
export default function TrashedDocPanel({ doc, onRestore, onPurge, onOpenPdf }: Props) {
  const authors = (doc.authors ?? [])
    .map((a) => [a.last_name, a.first_name].filter(Boolean).join(', '))
    .filter(Boolean)
    .join('; ')
  const doi = doc.identifiers?.doi ?? doc.doi ?? ''
  const arxiv = doc.identifiers?.arxiv ?? ''
  const bits = [
    doc.year != null ? String(doc.year) : '',
    doc.source ?? '',
    doc.type ?? ''
  ].filter(Boolean)

  return (
    <>
      <div className="details trash-doc">
        <div className="trash-doc-banner">
          这条在回收站里。恢复之后才能编辑、归入文件夹或同步。
        </div>
        <div className="field">
          <label>标题</label>
          <div className="trash-doc-title">{doc.title || '(无标题)'}</div>
        </div>
        {authors && (
          <div className="field">
            <label>作者</label>
            <div>{authors}</div>
          </div>
        )}
        {bits.length > 0 && (
          <div className="field">
            <label>年份 / 发表处 / 类型</label>
            <div>{bits.join(' · ')}</div>
          </div>
        )}
        {doc.abstract && (
          <div className="field">
            <label>摘要</label>
            <div className="trash-doc-abs">{doc.abstract}</div>
          </div>
        )}
        {doi && (
          <div className="field">
            <label>DOI</label>
            <div>{doi}</div>
          </div>
        )}
        {arxiv && (
          <div className="field">
            <label>arXiv</label>
            <div>{arxiv}</div>
          </div>
        )}
        {doc.localPdf && (
          <div className="field">
            <label>本地 PDF</label>
            <div className="trash-doc-pdf">{doc.localPdf}</div>
            <div style={{ marginTop: 4 }}>
              <button
                style={{ padding: '1px 5px', fontSize: 11 }}
                onClick={() => void window.api.revealPdf(doc.localPdf!)}
              >
                在文件夹中显示
              </button>{' '}
              <button
                style={{ padding: '1px 5px', fontSize: 11 }}
                onClick={() => void window.api.openPdfExternally(doc.localPdf!)}
              >
                用系统程序打开
              </button>
            </div>
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 10 }}>
          id {doc.id}
        </div>
      </div>
      <div className="meta-actions">
        {doc.localPdf && (
          <button className="primary" onClick={onOpenPdf}>
            打开 PDF
          </button>
        )}
        <button className="primary" onClick={onRestore}>
          恢复
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="danger"
          onClick={onPurge}
          title="不可恢复，云端记录也会一并删除"
        >
          彻底删除
        </button>
      </div>
    </>
  )
}
