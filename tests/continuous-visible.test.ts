import { describe, expect, it } from 'vitest'

import {
  REPAINT_MARGIN_PX,
  pagesNearViewport,
  type PageBox
} from '../src/lib/continuousScroll'

/**
 * The zoom repaint used to add every [data-page] element to `visible`, which
 * made one Ctrl+wheel step render the whole paper. This is the rule that now
 * decides which pages a repaint may touch, with fixed rectangles.
 */
const viewport = { top: 100, bottom: 900 }
const margin = REPAINT_MARGIN_PX

function box(page: number, top: number, bottom: number): PageBox {
  return { page, top, bottom }
}

describe('the detector', () => {
  it('can see a page outside the viewport when the margin allows it', () => {
    expect(
      pagesNearViewport(viewport, [box(1, -500, -100)], margin)
    ).toEqual([1])
    expect(pagesNearViewport(viewport, [box(1, -5000, -4000)], margin)).toEqual([])
  })
})

describe('pagesNearViewport', () => {
  it('keeps pages inside the viewport', () => {
    expect(
      pagesNearViewport(viewport, [
        box(1, 0, 100),
        box(2, 100, 500),
        box(3, 500, 900),
        box(4, 900, 1300)
      ], margin)
    ).toEqual([1, 2, 3, 4])
  })

  it('drops a long paper on both sides, not just the far end', () => {
    const boxes = Array.from({ length: 30 }, (_, i) =>
      box(i + 1, i * 1000, i * 1000 + 1000)
    )
    const got = pagesNearViewport(viewport, boxes, margin)
    // the margin reaches one page ahead, not the remaining twenty-eight
    expect(got.length).toBeLessThan(5)
    expect(got).toEqual([1, 2])
  })

  it('the margin is what lets a page be painted before it is reached', () => {
    const below = box(9, viewport.bottom + 100, viewport.bottom + 300)
    expect(pagesNearViewport(viewport, [below], 0)).toEqual([])
    expect(pagesNearViewport(viewport, [below], margin)).toEqual([9])
    const above = box(8, viewport.top - 300, viewport.top - 100)
    expect(pagesNearViewport(viewport, [above], 0)).toEqual([])
    expect(pagesNearViewport(viewport, [above], margin)).toEqual([8])
  })

  it('a page exactly at the boundary is included on both edges', () => {
    expect(
      pagesNearViewport(viewport, [
        box(1, viewport.top - margin - 200, viewport.top - margin),
        box(2, viewport.bottom + margin, viewport.bottom + margin + 200)
      ], margin)
    ).toEqual([1, 2])
  })

  it('ignores malformed page numbers and non-finite rectangles', () => {
    expect(
      pagesNearViewport(viewport, [
        box(0, 200, 300),
        box(-1, 200, 300),
        box(Number.NaN, 200, 300),
        box(Number.POSITIVE_INFINITY, 200, 300),
        box(4, Number.NaN, 300),
        box(5, 200, Number.POSITIVE_INFINITY),
        box(6, 200, 300)
      ], margin)
    ).toEqual([6])
  })

  it('an empty column needs no repaint', () => {
    expect(pagesNearViewport(viewport, [], margin)).toEqual([])
  })
})
