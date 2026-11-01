import { useLayoutEffect, useState, type RefObject } from 'react'

export interface Spot {
  top: number
  left: number
}

/** How far below its button a card sits, and how far off the window edge. */
const GAP = 4

/**
 * Where a card goes: under whatever opened it, and inside the window.
 *
 * Cards used to be placed by CSS, `top: calc(100% + 4px)` under a button with
 * `position: relative`.  That stopped working when the bar was allowed to
 * scroll sideways: a box that scrolls on one axis clips on the other, so
 * `overflow-x: auto` turns `overflow-y` into `auto` as well, and a card below
 * the button is cut off at the bar's bottom edge — the menu opens and there
 * is nothing there.  Nothing about the card itself says so, which is why it
 * took a reader to notice.
 *
 * `position: fixed` escapes the clip, being measured against the viewport
 * rather than against a scrolling box.  The price is that the coordinates
 * have to be worked out here, and that a card has to know where it hangs
 * off the bottom of the window.
 */
export function spotFor(anchor: DOMRect, card: DOMRect): Spot {
  let top = anchor.bottom + GAP
  // upwards rather than off the bottom, and only when there is no room below
  if (top + card.height > window.innerHeight - GAP) {
    top = Math.max(GAP, anchor.top - card.height - GAP)
  }
  let left = anchor.left
  if (left + card.width > window.innerWidth - GAP) {
    left = Math.max(GAP, window.innerWidth - card.width - GAP)
  }
  return { top: Math.round(top), left: Math.round(left) }
}

/**
 * The spot for a card that is in the DOM, worked out after it has been laid
 * out and before the browser paints — so it is never shown at the place it
 * first landed, which is inside the bar.  Measured again when the window
 * changes size, because a fixed card does not move with its button.
 */
export function usePopSpot(
  anchor: RefObject<HTMLElement>,
  card: RefObject<HTMLElement>
): Spot | null {
  const [spot, setSpot] = useState<Spot | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const c = card.current?.getBoundingClientRect()
      if (a && c) setSpot(spotFor(a, c))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, card])
  return spot
}
