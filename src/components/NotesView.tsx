import { useMemo, useState } from 'react'
import type { Annotation, Doc } from '../../shared/types'

interface Props {
  /** Every annotation in the store, not just the open document's. */
  anns: Annotation[]
  docs: Doc[]
  onClose: () => void
  /** Select the document and open its reader at the page. */
  onOpen: (d: Doc, page: number) => void
  onDelete: (id: string) => void
  onCopy: (a: Annotation, d: Doc | undefined) => void
}

interface Row {
  a: Annotation
  doc: Doc | undefined
  page: number
}

/** Highlights whose text is known are quoted; the rest are described by what
 *  they are, because "高亮" repeated twenty times tells nobody anything. */
const label = (a: Annotation): string => {
  const t = (a.note || a.text || '').replace(/\s+/g, ' ').trim()
  return t || (a.type === 'note' ? '笔记' : '高亮')
}

/**
 * Every annotation in the library, across documents.
 *
 * The question this answers is "where did I underline that" — asked days
 * later, about a paper that is no longer open.  Per-document lists cannot
 * answer it, and the annotations live in a local store keyed by document id,
 * so a cross-document view is a join rather than a new data structure.
 */
export default function NotesView({
  anns,
  docs,
  onClose,
  onOpen,
  onDelete,
  onCopy
}: Props) {
  const [q, setQ] = useState('')
  const [onlyNotes, setOnlyNotes] = useState(false)

  const byId = useMemo(() => {
    const m = new Map<string, Doc>()
    for (const d of docs) m.set(d.id, d)
    return m
  }, [docs])

  const rows = useMemo<Row[]>(() => {
    const s = q.trim().toLowerCase()
    const out: Row[] = []
    for (const a of anns) {
      const doc = byId.get(a.docId)
      const page = a.pos?.[0]?.page ?? a.page ?? 1
      if (onlyNotes && !(a.note || a.text)) continue
      if (s) {
        const hay = [label(a), a.note ?? '', a.text ?? '', doc?.title ?? '', doc?.source ?? '']
          .join(' ')
          .toLowerCase()
        if (!hay.includes(s)) continue
      }
      out.push({ a, doc, page })
    }
    // newest first: "what did I just mark" is asked more often than "what did
    // I mark two years ago"
    return out.sort((x, y) => String(y.a.created ?? '').localeCompare(String(x.a.created ?? '')))
  }, [anns, byId, q, onlyNotes])

  /** Grouped by document, so a paper with six highlights reads as one block
   *  instead of six unrelated lines. */
  const groups = useMemo(() => {
    const m = new Map<string, { doc: Doc | undefined; rows: Row[] }>()
    for (const r of rows) {
      const key = r.doc?.id ?? r.a.docId ?? '?'
      const g = m.get(key)
      if (g) g.rows.push(r)
      else m.set(key, { doc: r.doc, rows: [r] })
    }
    return [...m.values()].sort((a, b) => b.rows.length - a.rows.length)
  }, [rows])

  return (
    <div className="pane pane-mid">
      <div className="pane-head">
        <span>全部标注</span>
        <span className="grow" />
        <span style={{ color: 'var(--fg-dim)' }}>
          {rows.length} 条 · {groups.length} 篇
        </span>
        <button style={{ padding: '2px 6px', fontSize: '0.733rem' }} onClick={onClose}>
          返回库
        </button>
      </div>
      <div className="notes-bar">
        <input
          style={{ flex: 1 }}
          placeholder="在标注里筛选（笔记内容、篇名）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="notes-only">
          <input
            type="checkbox"
            checked={onlyNotes}
            onChange={(e) => setOnlyNotes(e.target.checked)}
          />
          只看写了笔记的
        </label>
        <button
          title="把当前筛选出来的标注文本复制到剪贴板"
          disabled={!rows.length}
          onClick={() =>
            void window.api.copyText(
              rows.map((r) => `${label(r.a)}\t${r.doc?.title ?? ''}\tp${r.page}`).join('\n')
            )
          }
        >
          复制列表
        </button>
      </div>
      <div className="notes-list">
        {!rows.length ? (
          <div className="empty">
            {anns.length ? '没有匹配的标注' : '还没有任何标注。在阅读器里选中文字即可高亮。'}
          </div>
        ) : (
          groups.map((g, i) => (
            <div key={g.doc?.id ?? i} className="notes-group">
              <div className="notes-doc" title={g.doc?.title ?? '(已不在库中)'}>
                <span className="notes-count">{g.rows.length}</span>
                {g.doc?.title ?? '(已不在库中)'}
              </div>
              {g.rows.map(({ a, doc, page }) => (
                <div
                  key={a.id}
                  className="notes-row"
                  title={doc ? `打开 ${doc.title} 第 ${page} 页` : '这篇已不在库中'}
                  onClick={() => doc && onOpen(doc, page)}
                >
                  <span className="ann-dot" style={{ background: a.color }} />
                  <span className="pg">p{page}</span>
                  <span className="notes-text">{label(a)}</span>
                  <span className="grow" />
                  <button
                    className="notes-act"
                    title="复制这条标注的文本"
                    onClick={(e) => {
                      e.stopPropagation()
                      onCopy(a, doc)
                    }}
                  >
                    复制
                  </button>
                  <button
                    className="notes-act danger"
                    title="删除这条标注"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(a.id)
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
