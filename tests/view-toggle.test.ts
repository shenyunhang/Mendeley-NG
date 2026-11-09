import { describe, expect, it } from 'vitest'

import {
  LIBRARY,
  viewAfterReadingToggle,
  type View
} from '../src/lib/view'

/**
 * The reading button used to be a one-way door: pressing it from the reader
 * set the very same view again, so nothing happened and the reader had to
 * find Esc or the little back button in the pane head. These fix the toggle
 * rule on its own, before the smoke run presses the real button.
 */
describe('viewAfterReadingToggle', () => {
  it('the first press from the library gives the paper the whole window', () => {
    expect(viewAfterReadingToggle(LIBRARY)).toEqual({ kind: 'reader' })
  })

  it('pressing the same button from the reader returns to the table', () => {
    expect(viewAfterReadingToggle({ kind: 'reader' })).toEqual(LIBRARY)
  })

  it('two presses are a round trip', () => {
    const once = viewAfterReadingToggle(LIBRARY)
    expect(viewAfterReadingToggle(once)).toEqual(LIBRARY)
  })

  it('any other view still leads into the reader', () => {
    const others: View[] = [
      { kind: 'fulltext' },
      { kind: 'add' },
      { kind: 'dupes', groups: [] },
      { kind: 'trash', docs: [] },
      { kind: 'annotations', anns: [] },
      { kind: 'import', entries: [] }
    ]
    for (const v of others) {
      expect(viewAfterReadingToggle(v), v.kind).toEqual({ kind: 'reader' })
    }
  })

  it('does not mutate the view it was given', () => {
    const current: View = { kind: 'reader' }
    const next = viewAfterReadingToggle(current)
    expect(current).toEqual({ kind: 'reader' })
    expect(next).not.toBe(current)
  })
})
