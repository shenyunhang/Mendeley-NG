import { describe, expect, it } from 'vitest'

import {
  NO_OVERLAYS,
  topOverlay,
  type OverlayLayer,
  type OverlayLayers
} from '../src/lib/overlayStack'

/**
 * The App used to keep the Esc priority as a hand-written if-chain inside a
 * keyboard handler, so the only thing guarding "one press closes one layer"
 * was a smoke run that presses the key at a real window. This is that rule
 * with fixed inputs, including every combination of open layers.
 */
const KEYS: (keyof OverlayLayers)[] = ['settings', 'columns', 'sort', 'filters']
const LAYERS: OverlayLayer[] = ['settings', 'columns', 'sort', 'filters']

function layersFrom(bits: number): OverlayLayers {
  return {
    settings: !!(bits & 8),
    columns: !!(bits & 4),
    sort: !!(bits & 2),
    filters: !!(bits & 1)
  }
}

/** The expected answer is written out independently of the implementation:
 *  the first set bit in the fixed order wins. */
function expected(bits: number): OverlayLayer | null {
  for (let i = 0; i < 4; i++) {
    if (bits & (8 >> i)) return LAYERS[i]!
  }
  return null
}

describe('the detector', () => {
  it('can see an open layer before any "nothing is open" conclusion is trusted', () => {
    expect(topOverlay({ ...NO_OVERLAYS, filters: true })).toBe('filters')
    expect(topOverlay({ ...NO_OVERLAYS, settings: true })).toBe('settings')
  })
})

describe('topOverlay', () => {
  it('answers every one of the sixteen combinations correctly', () => {
    for (let bits = 0; bits < 16; bits++) {
      expect(topOverlay(layersFrom(bits)), `bits ${bits}`).toBe(expected(bits))
    }
  })

  it('an empty stack hands the key back to the app', () => {
    expect(topOverlay(NO_OVERLAYS)).toBeNull()
  })

  it('the sheet wins over every card underneath it', () => {
    const all: OverlayLayers = {
      settings: true,
      columns: true,
      sort: true,
      filters: true
    }
    expect(topOverlay(all)).toBe('settings')
    expect(topOverlay({ ...all, settings: false })).toBe('columns')
    expect(topOverlay({ ...all, settings: false, columns: false })).toBe('sort')
    expect(topOverlay({ ...all, settings: false, columns: false, sort: false })).toBe('filters')
  })

  it('one press closes one layer, and four presses empty a full stack in order', () => {
    const state = { ...layersFrom(15) }
    const closed: OverlayLayer[] = []
    for (let press = 0; press < 4; press++) {
      const top = topOverlay(state)
      if (!top) break
      closed.push(top)
      const key = KEYS[LAYERS.indexOf(top)]!
      state[key] = false
    }
    expect(closed).toEqual(['settings', 'columns', 'sort', 'filters'])
    expect(topOverlay(state)).toBeNull()
  })

  it('a layer that is not on top is never named while something above it is open', () => {
    for (let bits = 0; bits < 16; bits++) {
      const top = topOverlay(layersFrom(bits))
      if (!top) continue
      const rank = LAYERS.indexOf(top)
      for (let lower = rank + 1; lower < 4; lower++) {
        expect(top, `bits ${bits} must not answer ${LAYERS[lower]}`).not.toBe(LAYERS[lower])
      }
    }
  })
})
