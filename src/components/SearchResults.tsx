import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Doc } from '../../shared/types'
import { matchDoc, type DocMatch, type Part } from '../lib/match'

interface Props {
  docs: Doc[]
  /** What is being searched for.  The same list is drawn without any marks
   *  when this is empty, which is why the caller only shows this pane while
   *  there is something in the box. */
  query: string
  noteMap: Record<string, string>
  selectedId: string | null
  onSelect: (d: Doc, index: number, mod: { shift: boolean; add: boolean }) => void
  onContextMenu?: (d: Doc, e: React.MouseEvent) => void
  multi: string[]
  /** base UI font size; the card height follows it */
  fontSize: number
  empty?: React.ReactNode
}

/** Draw one run of text, marking the part that matched. */
function Runs({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? <mark key={i}>{p.t}</mark> : <span key={i}>{p.t}</span>
      )}
    </>
  )
}

/**
 * The library as search results rather than as a table.
 *
 * A table can say that a paper matched.  It cannot say why, and "why" is the
 * whole reason somebody reads a list of results instead of just opening the
 * one they wanted: the same fifty papers come back for a word that is in the
 * title and for a word that appears once in the abstract, and only the second
 * one is worth opening.
 *
 * So the fields that matched are shown as a snippet around the match, and the
 * ones that did not match are not shown at all — a paper wrapped in all of
 * its metadata buries the one line that explains why it is on the list.
 *
 * The pane is a list of cards rather than a second mode of the table because
 * the two want incompatible things: a table is for comparing one column
 * across many papers, and these are for reading one paper at a time.  It is
 * only drawn while there is a query.
 */
export default function SearchResults({
  docs,
  query,
  noteMap,
  selectedId,
  onSelect,
  onContextMenu,
  multi,
  fontSize,
  empty
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null)

  // read back from CSS rather than hard-coding it, so a card that the reader
  // has made taller by scaling the UI is not measured at the old height
  const cardH = useMemo(() => {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--res-h)'
    document.body.appendChild(probe)
    const h = probe.offsetHeight
    probe.remove()
    return h || 76
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize])

  const v = useVirtualizer({
    count: docs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cardH,
    overscan: 12
  })

  useEffect(() => {
    v.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardH])

  /**
   * The match for one card, built the first time that card is asked for.
   *
   * Building all of them up front is the obvious way to write this and the
   * expensive one: a card costs a pass over every searchable field, abstract
   * included, and only the twenty-odd on screen are ever drawn.  Building
   * them per card makes a scroll free after the first pass, because the
   * cache outlives the render that filled it.
   */
  const q = query.trim()
  const matchAt = useMemo(() => {
    const cache = new Map<string, DocMatch>()
    return (i: number): DocMatch => {
      const d = docs[i]
      const hit = cache.get(d.id)
      if (hit) return hit
      const made = matchDoc(d, q, noteMap[d.id])
      cache.set(d.id, made)
      return made
    }
  }, [docs, q, noteMap])

  return (
    <div className="res-wrap" ref={parentRef}>
      {!docs.length ? (
        (empty ?? <div className="empty">没有匹配的文献</div>)
      ) : (
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const d = docs[vi.index]
            const m = matchAt(vi.index)
            const picked = multi.includes(d.id)
            return (
              <div
                key={d.id}
                className={
                  'res-row' + (selectedId === d.id ? ' sel' : '') + (picked ? ' multi' : '')
                }
                draggable
                onDragStart={(e) => {
                  // the gesture means the selection, not the card it started
                  // on, so a card that is part of it travels with the rest
                  const ids = picked && multi.length > 1 ? multi : [d.id]
                  e.dataTransfer.setData('text/doc-ids', JSON.stringify(ids))
                  e.dataTransfer.setData('text/doc-id', d.id)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={(e) =>
                  onSelect(d, vi.index, { shift: e.shiftKey, add: e.ctrlKey || e.metaKey })
                }
                onContextMenu={(e) => {
                  if (!multi.includes(d.id)) onSelect(d, vi.index, { shift: false, add: false })
                  onContextMenu?.(d, e)
                }}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`
                }}
              >
                <div className="res-head">
                  <span className="res-title">
                    <Runs parts={m.title} />
                  </span>
                  {m.year ? <span className="res-year">{m.year}</span> : null}
                </div>
                {m.authors.length ? (
                  <div className="res-authors">
                    <Runs parts={m.authors} />
                    {m.source ? <span className="res-src"> · {m.source}</span> : null}
                  </div>
                ) : null}
                {/* only the fields the query is in, and at most two of them:
                    a card that grows to fit every match stops being scannable,
                    and the rest are one click away in the details pane */}
                {m.fields.slice(0, 2).map((f) => (
                  <div className="res-field" key={f.label}>
                    <span className="res-label">{f.label}</span>
                    <Runs parts={f.parts} />
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
