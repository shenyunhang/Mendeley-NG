/** Where a fixed card sits, without asking the browser anything.
 *
 * `usePopSpot` in `popspot.ts` owned this rule, but read `window` directly.
 * That is fine for a card hanging off a button that never moves, and it is
 * not fine for a card hanging off a marker in a PDF: the reader can resize
 * the window while the card is open, and the marker is redrawn with its
 * page.  Putting the viewport and both boxes in the caller's hands makes
 * the rule possible to ask about a resize that has not happened in a
 * browser yet, which is the only way to test it without moving a real
 * window in the smoke run.
 */

export interface Spot {
  top: number
  left: number
}

export interface Viewport {
  width: number
  height: number
}

/** The part of a DOMRect the placement rule actually reads. */
export interface Box {
  top: number
  bottom: number
  left: number
  width: number
  height: number
}

/** How far below its anchor a card sits, and how far off the window edge. */
export const GAP = 4

/**
 * Cards used to be placed by CSS, `top: calc(100% + 4px)` under a button
 * with `position: relative`.  That stopped working when the bar was allowed
 * to scroll sideways: a box that scrolls on one axis clips on the other, so
 * `overflow-x: auto` turns `overflow-y` into `auto` as well, and a card
 * below the button is cut off at the bar's bottom edge — the menu opens and
 * there is nothing there.  Nothing about the card itself says so.
 *
 * `position: fixed` escapes the clip, being measured against the viewport
 * rather than against a scrolling box.  The price is that the coordinates
 * have to be worked out here, and that a card has to know where it hangs
 * off the bottom of the window.
 */
export function spotFor(anchor: Box, card: Box, view: Viewport): Spot {
  let top = anchor.bottom + GAP
  // upwards rather than off the bottom, and only when there is no room below
  if (top + card.height > view.height - GAP) {
    top = Math.max(GAP, anchor.top - card.height - GAP)
  }
  let left = anchor.left
  if (left + card.width > view.width - GAP) {
    left = Math.max(GAP, view.width - card.width - GAP)
  }
  return { top: Math.round(top), left: Math.round(left) }
}

export interface SpotReading {
  /** Null when the marker has been torn down with the page it was on. */
  anchor: Box | null
  /** Null while the card has not been laid out yet. */
  card: Box | null
  view: Viewport
}

export interface CardSpotter {
  /** Measure once, after the card is in the document, before it is painted. */
  measure: () => void
  /** The window changed size: measure again, or close a card whose marker
   *  has gone.  Both boxes are read afresh, because a resize reflows the
   *  page and moves the marker as well as changing the viewport. */
  resize: () => void
  /** The card is gone: no later resize may write anything. */
  dispose: () => void
}

/**
 * The one-shot measurement was the bug. A card placed once with
 * `position: fixed` keeps its old coordinates when the window changes, so
 * narrowing the window leaves it outside the new viewport with no way to
 * reach "打开". Re-measuring also has to answer what happens when the
 * marker is no longer there: a card with nothing to hang off is a card
 * about a page the reader has left, so it closes rather than being placed
 * from stale coordinates.
 *
 * `read` is injected so this controller has no DOM and no React in it.
 * `onGone` is separate from `render` because closing a card is the flash
 * controller's business, not the placement rule's.
 */
export function createCardSpotter(
  read: () => SpotReading,
  render: (spot: Spot | null) => void,
  onGone: () => void
): CardSpotter {
  let live = true
  const apply = (fromResize: boolean) => {
    if (!live) return
    const r = read()
    if (!r.anchor) {
      // On the first measure a missing anchor is just layout timing: the
      // card is hidden until it can be placed. On a resize it means the
      // marker left with its page, and the card must not stay behind.
      if (fromResize) onGone()
      else render(null)
      return
    }
    if (!r.card) {
      render(null)
      return
    }
    render(spotFor(r.anchor, r.card, r.view))
  }
  return {
    measure: () => apply(false),
    resize: () => apply(true),
    dispose: () => {
      live = false
    }
  }
}
