import { useRef, type RefObject } from 'react'
import {
  SORT_KEYS,
  SORT_LABEL,
  SORT_DIR_TEXT,
  type SortKey
} from '../lib/columns'
import { usePopSpot } from '../lib/popspot'

interface Props {
  /** The button it hangs from, rather than its own parent: a bar that can
   *  scroll sideways clips a card that reaches below it. */
  anchor: RefObject<HTMLElement>
  sort: { key: SortKey; dir: 1 | -1 }
  onPick: (k: SortKey) => void
  onClose: () => void
}

/**
 * How the list is ordered, as a card rather than as column headers.
 *
 * The headers can only sort a column that is on screen, and the moment there
 * is a word in the search box there are no headers at all: the results come
 * back as cards, and a card has nowhere to put an arrow.  Sorting is a
 * question about the list, not about one column, so it also has to be
 * askable from somewhere that is not a column.
 *
 * The direction is written out rather than left as an arrow.  "年份 ↓" is a
 * convention the reader has to decode, and getting it backwards means reading
 * the whole list from the wrong end before noticing.
 */
export default function SortMenu({ anchor, sort, onPick, onClose }: Props) {
  const card = useRef<HTMLDivElement>(null)
  const spot = usePopSpot(anchor, card)
  return (
    <div
      className="col-picker filter-menu"
      ref={card}
      style={spot ?? undefined}
      onMouseLeave={onClose}
    >
      <div className="col-picker-head">
        <b>排序</b>
        <span style={{ flex: 1 }} />
        <button className="mini" title="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="col-list">
        {SORT_KEYS.map((k) => {
          const mine = sort.key === k
          const [up, down] = SORT_DIR_TEXT[k]
          return (
            <div className="col-row" key={k}>
              <button
                className="sort-pick"
                data-sort={k}
                title={mine ? `${sort.dir === 1 ? up : down}　·　点一下反过来` : `按${SORT_LABEL[k]}排`}
                onClick={() => onPick(k)}
              >
                <span className="sort-arrow">
                  {mine ? (sort.dir === 1 ? '▲' : '▼') : ''}
                </span>
                {SORT_LABEL[k]}
                <span style={{ flex: 1 }} />
                {mine && <span className="sort-dir">{sort.dir === 1 ? up : down}</span>}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
