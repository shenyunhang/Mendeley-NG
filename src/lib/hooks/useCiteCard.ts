import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createFlashMessage, type FlashMessage } from '../flash'
import { spotFor, type Spot } from '../popspot'

export interface CiteItem {
  n: number
  text: string
  doc: { id: string; title?: string } | null
}

/** One entry under the pointer: its number, its text, and the library's
 *  copy of it if there is one. */
export interface CiteCard {
  items: CiteItem[]
  anchor: DOMRect
}

/** How long the pointer has to get from the marker to the card's "打开"
 *  button.  The card has to be reachable: without the wait, moving towards
 *  the button closes the thing the button is on. */
const REACH_MS = 260

/**
 * The citation card itself: what it shows, where it sits, and when it goes.
 *
 * This is a clean cluster in the reader.  It answers one question — "what
 * does the entry under the pointer look like while it is being read?" — and
 * it does not need to know how the hotspots are built, which page holds
 * them, or how the reference list was parsed.  Those stay in `PdfViewer`,
 * which is the layer that owns pages.
 *
 * The controller is the one-pending-clear scheduler from 151, generalised
 * to an object payload in 156.  Keeping it here means the card is not
 * assembled out of a timer ref and three ad-hoc wrappers in the middle of a
 * fifteen-hundred-line component, and that `clear` also cancels the pending
 * hide: a card dismissed by scrolling or by turning the page no longer gets
 * a second, useless `setCite(null)` 260ms later.
 *
 * `show` deliberately takes resolved items rather than a citation marker.
 * Turning "[3]" into an entry needs the reference list and the library, and
 * neither belongs to a hook whose whole job is to place a box on screen.
 * The caller does that work and calls `keep` *before* deciding whether there
 * is anything to show: a marker whose every number is unreadable must cancel
 * the pending hide without replacing the card, because half a match is how a
 * reader is sent to a paper they did not ask about.
 */
export function useCiteCard(scope: { page: number; docId: string }) {
  const [cite, setCite] = useState<CiteCard | null>(null)
  const [spot, setSpot] = useState<Spot | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const timer = useRef<FlashMessage<CiteCard> | null>(null)
  if (timer.current === null) {
    timer.current = createFlashMessage<CiteCard>(setCite)
  }

  /** The pointer left the marker or the card: arrange a delayed hide. */
  const drop = () => timer.current?.hold(REACH_MS)
  /** The pointer came back onto the card: cancel that hide. */
  const keep = () => timer.current?.keep()
  /** Something moved out from under the card, or the reader opened a paper. */
  const close = () => timer.current?.clear()
  /** Put a resolved entry under the pointer. */
  const show = (items: CiteItem[], anchor: DOMRect) =>
    timer.current?.show({ items, anchor })

  // The card is measured after it is in the document and before it is
  // painted, so it is never shown at the corner it first lands in.
  useLayoutEffect(() => {
    if (!cite || !cardRef.current) {
      setSpot(null)
      return
    }
    setSpot(spotFor(cite.anchor, cardRef.current.getBoundingClientRect()))
  }, [cite])

  // A card belongs to the marker it was opened for, and that marker is on a
  // page that has since been left.
  useEffect(() => {
    close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.page, scope.docId])

  useEffect(() => () => timer.current?.dispose(), [])

  return { cite, spot, cardRef, show, drop, keep, close }
}
