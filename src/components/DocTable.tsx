import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Doc } from '../../shared/types'

const COLS = '24px 26px 1.5fr 3.2fr 56px 1.3fr 1.1fr'

type SortKey = 'title' | 'authors' | 'year' | 'source' | 'citation_key' | 'starred'

interface Props {
  docs: Doc[]
  sort: { key: string; dir: 1 | -1 }
  onSort: (k: SortKey) => void
  selectedId: string | null
  /** `index` is the position in the sorted, filtered list, which is what a
   *  shift-click range has to span. */
  onSelect: (d: Doc, index: number, mod: { shift: boolean; add: boolean }) => void
  onToggleStar: (d: Doc) => void
  /** ids of every row in the current multi-selection */
  multi: string[]
  /** base UI font size; the row height follows it, so the virtualiser has to
   *  re-measure whenever it changes */
  fontSize: number
}

const HEAD: [string, SortKey][] = [
  ['★', 'starred'],
  ['', 'year'],
  ['作者', 'authors'],
  ['标题', 'title'],
  ['年份', 'year'],
  ['发表处', 'source'],
  ['Key', 'citation_key']
]

export default function DocTable({
  docs,
  sort,
  onSort,
  selectedId,
  onSelect,
  onToggleStar,
  multi,
  fontSize
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null)

  // --row-h is expressed in rem, so ask the layout engine for the real height
  // instead of hard-coding 30 and drifting out of sync when the user rescales
  const rowH = useMemo(() => {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--row-h)'
    document.body.appendChild(probe)
    const h = probe.offsetHeight
    probe.remove()
    return h || 30
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize])

  const v = useVirtualizer({
    count: docs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowH,
    overscan: 24
  })

  useEffect(() => {
    v.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowH])

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: COLS,
          background: 'var(--bg-2)',
          borderBottom: '1px solid var(--border)',
          flex: '0 0 auto'
        }}
      >
        {HEAD.map(([label, key], i) => (
          <div
            key={i}
            onClick={() => label && onSort(key)}
            style={{
              padding: '6px 8px',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: sort.key === key ? 'var(--accent)' : 'var(--fg-dim)',
              cursor: label ? 'pointer' : 'default',
              userSelect: 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {label}
            {sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
          </div>
        ))}
      </div>

      <div className="table-wrap" ref={parentRef}>
        {!docs.length ? (
          <div className="empty">没有匹配的文献</div>
        ) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((vi) => {
              const d = docs[vi.index]
              const picked = multi.includes(d.id)
              const au = d.authors?.[0]
              const name = au
                ? [au.last_name, au.first_name].filter(Boolean).join(' ')
                : ''
              return (
                <div
                  key={d.id}
                  className={
                    'row' + (selectedId === d.id ? ' sel' : '') + (picked ? ' multi' : '')
                  }
                  draggable
                  onDragStart={(e) =>
                    e.dataTransfer.setData('text/doc-id', d.id)
                  }
                  onClick={(e) =>
                    onSelect(d, vi.index, { shift: e.shiftKey, add: e.ctrlKey || e.metaKey })
                  }
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: vi.size,
                    transform: `translateY(${vi.start}px)`,
                    display: 'grid',
                    gridTemplateColumns: COLS,
                    alignItems: 'center',
                    fontSize: '0.867rem',
                    borderBottom: '1px solid #2c2c2c',
                    background: selectedId === d.id ? 'var(--accent-dim)' : undefined,
                    cursor: 'pointer'
                  }}
                >
                  <div style={{ paddingLeft: 6 }}>
                    <span
                      className="star"
                      style={{ color: d.starred ? 'var(--star-on)' : 'var(--star-off)' }}
                      title={d.starred ? '取消星标' : '加星标'}
                      onClick={(e) => {
                        // without this the click also selects the row, and a
                        // star toggle is not a request to open the paper
                        e.stopPropagation()
                        onToggleStar(d)
                      }}
                    >
                      {d.starred ? '★' : '☆'}
                    </span>
                  </div>
                  <div style={{ paddingLeft: 8 }}>
                    <span
                      className={'pdf-dot' + (d.localPdf || d.file_attached ? '' : ' no-pdf')}
                      title={d.localPdf ? '有本地 PDF' : d.file_attached ? '云端有文件' : '无 PDF'}
                    />
                  </div>
                  <div
                    style={{ padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={name}
                  >
                    {name}
                    {(d.authors?.length ?? 0) > 1 ? ' 等' : ''}
                  </div>
                  <div
                    style={{
                      padding: '0 8px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      // unread stands out the way an unread mail does
                      fontWeight: d.read === false ? 600 : undefined
                    }}
                    title={d.title}
                  >
                    {d.title || '(无标题)'}
                  </div>
                  <div style={{ padding: '0 8px' }}>{d.year ?? ''}</div>
                  <div
                    style={{ padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={d.source}
                  >
                    {d.source ?? ''}
                  </div>
                  <div
                    style={{
                      padding: '0 8px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--fg-dim)'
                    }}
                    title={d.citation_key}
                  >
                    {d.citation_key ?? ''}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
