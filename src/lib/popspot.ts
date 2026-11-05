import { useLayoutEffect, useState, type RefObject } from 'react'
import { spotFor as placeIn, type Spot } from './cardSpot'

export type { Spot } from './cardSpot'

/**
 * Where a card goes, against this window. The rule itself lives in
 * `cardSpot.ts` and takes the viewport as an argument, so the citation card
 * can be re-placed after a resize instead of being measured only once (159).
 * This wrapper keeps the five callers of `usePopSpot` reading the way they
 * always did, with the live window as their viewport.
 */
export function spotFor(anchor: DOMRect, card: DOMRect): Spot {
  return placeIn(anchor, card, {
    width: window.innerWidth,
    height: window.innerHeight
  })
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
