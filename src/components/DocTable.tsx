import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Doc } from '../../shared/types'
import {
  COL_BY_KEY,
  gridTemplate,
  type ColKey,
  type SortKey
} from '../lib/columns'

interface Props {
  docs: Doc[]
  sort: { key: string; dir: 1 | -1 }
  onSort: (k: SortKey) => void
  selectedId: string | null
  /** `index` is the position in the sorted, filtered list, which is what a
   *  shift-click range has to span. */
  onSelect: (d: Doc, index: number, mod: { shift: boolean; add: boolean }) => void
  onToggleStar: (d: Doc) => void
  /** Right click.  The raw event is passed through so the caller can put the
   *  menu where the pointer actually is. */
  onContextMenu?: (d: Doc, e: React.MouseEvent) => void
  /** ids of every row in the current multi-selection */
  multi: string[]
  /** base UI font size; the row height follows it, so the virtualiser has to
   *  re-measure whenever it changes */
  fontSize: number
  /** which columns to show, in order */
  cols: ColKey[]
  /**
   * What to show when there is nothing to list.  Passed in rather than
   * decided here because the table only knows that `docs` is empty, not
   * why: an empty library and a filter that excluded everything are the
   * same thing from down here and opposite things to the reader.
   */
  empty?: React.ReactNode
}

export default function DocTable({
  docs,
  sort,
  onSort,
  selectedId,
  onSelect,
  onToggleStar,
  onContextMenu,
  multi,
  fontSize,
  cols,
  empty
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

  // Arrow keys move the selection through rows that are not on screen, so the
  // list has to follow it; without this, arrowing past the fold looks exactly
  // like nothing happened.  `align: 'auto'` leaves a row alone when it is
  // already visible, so a mouse click never causes a jump.
  useEffect(() => {
    if (!selectedId) return
    const i = docs.findIndex((d) => d.id === selectedId)
    if (i >= 0) v.scrollToIndex(i, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const defs = useMemo(
    () =>
      cols
        .map((k) => COL_BY_KEY.get(k))
        .filter((c): c is NonNullable<typeof c> => Boolean(c)),
    [cols]
  )
  const COLS = useMemo(() => gridTemplate(cols), [cols])

  return (
    <>
      <div
        className="col-head"
        style={{
          display: 'grid',
          gridTemplateColumns: COLS,
          background: 'var(--bg-2)',
          borderBottom: '1px solid var(--border)',
          flex: '0 0 auto'
        }}
      >
        {defs.map((c) => (
          <div
            key={c.key}
            data-col={c.key}
            onClick={() => c.sort && onSort(c.sort)}
            style={{
              padding: '6px 8px',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: sort.key === c.sort ? 'var(--accent)' : 'var(--fg-dim)',
              cursor: c.sort ? 'pointer' : 'default',
              userSelect: 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
            title={c.sort ? `按${c.label || '此列'}排序` : undefined}
          >
            {c.label}
            {c.sort && sort.key === c.sort ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
          </div>
        ))}
      </div>

      <div className="table-wrap" ref={parentRef}>
        {!docs.length ? (
          (empty ?? <div className="empty">没有匹配的文献</div>)
        ) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((vi) => {
              const d = docs[vi.index]
              const picked = multi.includes(d.id)
              return (
                <div
                  key={d.id}
                  className={
                    'row' + (selectedId === d.id ? ' sel' : '') + (picked ? ' multi' : '')
                  }
                  draggable
                  onDragStart={(e) => {
                    // What travels is the selection, not this row: dragging one
                    // of ten selected papers and getting one paper in the
                    // folder is the sort of thing that makes the whole gesture
                    // look broken.  A row that is not part of the selection
                    // travels on its own.
                    const ids = picked && multi.length > 1 ? multi : [d.id]
                    e.dataTransfer.setData('text/doc-ids', JSON.stringify(ids))
                    // kept so that a drop target written for one document
                    // still works
                    e.dataTransfer.setData('text/doc-id', d.id)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={(e) =>
                    onSelect(d, vi.index, { shift: e.shiftKey, add: e.ctrlKey || e.metaKey })
                  }
                  onContextMenu={(e) => {
                    // a right click on an unselected row is a request to act on
                    // that row, so it selects first: otherwise the menu would
                    // describe one document while the pane showed another
                    if (!multi.includes(d.id)) {
                      onSelect(d, vi.index, { shift: false, add: false })
                    }
                    onContextMenu?.(d, e)
                  }}
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
                    cursor: 'pointer'
                  }}
                >
                  {defs.map((c) => {
                    if (c.kind === 'star') {
                      return (
                        <div key={c.key} style={{ paddingLeft: 6 }}>
                          <span
                            className="star"
                            style={{ color: d.starred ? 'var(--star-on)' : 'var(--star-off)' }}
                            title={d.starred ? '取消星标' : '加星标'}
                            onClick={(e) => {
                              // without this the click also selects the row,
                              // and a star toggle is not a request to open it
                              e.stopPropagation()
                              onToggleStar(d)
                            }}
                          >
                            {d.starred ? '★' : '☆'}
                          </span>
                        </div>
                      )
                    }
                    if (c.kind === 'pdf') {
                      return (
                        <div key={c.key} style={{ paddingLeft: 8 }}>
                          <span
                            className={
                              'pdf-dot' + (d.localPdf || d.file_attached ? '' : ' no-pdf')
                            }
                            title={c.text(d)}
                          />
                        </div>
                      )
                    }
                    return (
                      <div
                        key={c.key}
                        style={{
                          padding: '0 8px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          // unread stands out the way an unread mail does
                          fontWeight:
                            c.key === 'title' && d.read === false ? 600 : undefined,
                          color: c.key === 'citation_key' ? 'var(--fg-dim)' : undefined
                        }}
                        title={c.text(d)}
                      >
                        {c.text(d)}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
