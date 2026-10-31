import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Doc } from '../../shared/types'
import {
  COL_BY_KEY,
  clampColWidth,
  gridTemplate,
  type ColKey,
  type ColumnDef,
  type SortKey
} from '../lib/columns'
import { useDragX } from '../lib/useDragX'

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
  /** Widths the reader has dragged to, in CSS px, keyed by column.  Only the
   *  columns that were dragged are in here; the rest keep the track their
   *  definition gives them. */
  colWidths?: Record<string, number>
  /** A width for one column, or null to hand it back to its default track.
   *  Called as the drag goes, so there is one source of truth; the caller is
   *  the one that decides when that is worth writing down. */
  onColWidth?: (key: ColKey, width: number | null) => void
  /**
   * Move one column to a new position.  `toIndex` is a gap between columns in
   * the order as it is now, 0 being before the first and `cols.length` being
   * after the last, so the caller does not have to know whether the column
   * being dragged is before or after where it is going.
   */
  onColMove?: (key: ColKey, toIndex: number) => void
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
  colWidths,
  onColWidth,
  onColMove,
  empty
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)

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
  const COLS = useMemo(() => gridTemplate(cols, colWidths), [cols, colWidths])

  // What a width drag starts from.  A column's default is a fraction, not a
  // number of pixels, so the width has to be measured off the header rather
  // than read out of the definition — otherwise the first move jumps.
  const dragFrom = useRef<{ key: ColKey; x0: number; w0: number } | null>(null)
  const [dragKey, setDragKey] = useState<ColKey | null>(null)
  const { on: dragging, start } = useDragX((x) => {
    const d = dragFrom.current
    if (!d) return
    const def = COL_BY_KEY.get(d.key)
    if (def) onColWidth?.(d.key, clampColWidth(def, d.w0 + (x - d.x0)))
  })
  useEffect(() => {
    if (!dragging) setDragKey(null)
  }, [dragging])

  const startColDrag = (e: React.MouseEvent, c: ColumnDef) => {
    const cell = (e.currentTarget as HTMLElement).parentElement
    dragFrom.current = {
      key: c.key,
      x0: e.clientX,
      w0: cell?.getBoundingClientRect().width ?? 100
    }
    setDragKey(c.key)
    start(e)
  }

  /**
   * Reordering by dragging the header itself.
   *
   * The header is also the sort control, so a press is not a drag until the
   * pointer has actually travelled: otherwise every click that lands a pixel
   * off would reorder a column instead of sorting by it.  `movedRef` is read
   * by the click handler and cleared there, because the click arrives after
   * the mouse is already up and there is no other point at which to ask.
   *
   * Where it will land is a gap between two columns, chosen by which side of
   * a column's midline the pointer is on.  Half a column is the honest
   * boundary: it is where a reader aiming at "after 年份" puts the pointer.
   */
  const movedRef = useRef(false)
  const moveFrom = useRef<{ x0: number } | null>(null)
  const [moveKey, setMoveKey] = useState<ColKey | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [dropX, setDropX] = useState(0)
  const { on: moving, start: startMove } = useDragX((x) => {
    const head = headRef.current
    if (!head || !moveKey) return
    if (!movedRef.current && Math.abs(x - (moveFrom.current?.x0 ?? x)) > 4) {
      movedRef.current = true
    }
    const cells = Array.from(head.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.col != null
    )
    if (!cells.length) return
    let target = cells.length
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i].getBoundingClientRect()
      if (x < r.left + r.width / 2) {
        target = i
        break
      }
    }
    setDropAt(target)
    const last = cells[cells.length - 1]
    setDropX(target < cells.length ? cells[target].offsetLeft : last.offsetLeft + last.offsetWidth)
  })
  useEffect(() => {
    if (moving || !moveKey) return
    if (dropAt != null) onColMove?.(moveKey, dropAt)
    setMoveKey(null)
    setDropAt(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving, moveKey])

  const startColMove = (e: React.MouseEvent, c: ColumnDef) => {
    movedRef.current = false
    moveFrom.current = { x0: e.clientX }
    setMoveKey(c.key)
    startMove(e)
  }

  return (
    <>
      <div
        className="col-head"
        ref={headRef}
        style={{
          display: 'grid',
          gridTemplateColumns: COLS,
          background: 'var(--bg-2)',
          borderBottom: '1px solid var(--border)',
          flex: '0 0 auto',
          // the header and the rows are two scroll boxes; the one below drives
          // this one, so a row dragged wider than the pane cannot leave the
          // two out of step.  hidden rather than auto, because a scrollbar of
          // its own is a second thing to aim at under a seven-pixel handle
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        {defs.map((c) => (
          <div
            key={c.key}
            data-col={c.key}
            className={moveKey === c.key ? 'col-moving' : undefined}
            onMouseDown={(e) => startColMove(e, c)}
            onClick={() => {
              // a press that travelled was a drag, and the click that follows
              // it is not a request to sort
              if (movedRef.current) {
                movedRef.current = false
                return
              }
              if (c.sort) onSort(c.sort)
            }}
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              padding: '6px 8px',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: sort.key === c.sort ? 'var(--accent)' : 'var(--fg-dim)',
              cursor: c.sort ? 'pointer' : 'default',
              userSelect: 'none',
              overflow: 'hidden'
            }}
            title={
              (c.sort ? `按${c.label || '此列'}排序　·　` : '') +
              `左右拖动可以把「${c.label || '此列'}」挪到别的位置`
            }
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {c.label}
              {c.sort && sort.key === c.sort ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
            </span>
            <span
              className={'col-grip' + (dragKey === c.key ? ' on' : '')}
              title={`拖动改变「${c.label || '此列'}」的宽度，双击复位`}
              onMouseDown={(e) => {
                // without this the press also lands on the header, which
                // would start a reorder drag on top of the width one
                e.stopPropagation()
                startColDrag(e, c)
              }}
              // a press on the handle is not a request to sort
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation()
                onColWidth?.(c.key, null)
              }}
            />
          </div>
        ))}
        {/* where the column would land.  Drawn on the header rather than on a
            cell, because a gap after the last column has no cell to draw on. */}
        {moveKey && dropAt != null && <div className="col-drop" style={{ left: dropX }} />}
      </div>

      <div
        className="table-wrap"
        ref={parentRef}
        onScroll={(e) => {
          const h = headRef.current
          if (h) h.scrollLeft = e.currentTarget.scrollLeft
        }}
      >
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
