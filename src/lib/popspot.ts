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
 *
 * `visible` is for a caller that stays mounted but renders its card only
 * while open. Both refs are stable, so without it this effect runs once at
 * mount — when the card is not in the DOM yet — and never again: `place()`
 * has nothing to measure, `spot` stays null, and the card is left at its
 * CSS static position with none of `spotFor`'s window-edge clamping. A
 * caller whose whole component mounts together with its card is already in
 * the DOM on the first effect and need not pass anything (160).
 */
export function usePopSpot(
  anchor: RefObject<HTMLElement>,
  card: RefObject<HTMLElement>,
  visible?: boolean
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
  }, [anchor, card, visible])
  return spot
}
