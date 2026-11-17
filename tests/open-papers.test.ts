import { describe, expect, it } from 'vitest'

import type { Doc } from '../shared/types'
import {
  nextActivePaper,
  paperEntry,
  pinPaper,
  removePaper,
  upsertPaper,
  type OpenPaper
} from '../src/lib/openPapers'

/** The tab bar's rules, with no React and no window involved. */

const doc = (id: string, localPdf?: string): Doc => ({
  id,
  title: 'Paper ' + id,
  localPdf
})

/** A permanent tab by default; preview tabs are made explicitly. */
const tab = (id: string, page: number | null = 1, preview = false): OpenPaper => ({
  id,
  doc: doc(id, 'C:/pdf/' + id + '.pdf'),
  page,
  tab: 'pdf',
  preview
})

describe('paperEntry', () => {
  it('opens a paper with a file in the reader and one without on its details', () => {
    expect(paperEntry(doc('a', 'a.pdf'), 7, true)).toEqual({
      id: 'a',
      doc: doc('a', 'a.pdf'),
      page: 7,
      tab: 'pdf',
      preview: true
    })
    expect(paperEntry(doc('b'), null, false).tab).toBe('details')
  })

  it('keeps "no page specified" distinct from page one and records preview', () => {
    expect(paperEntry(doc('a', 'a.pdf'), null, true).page).toBeNull()
    expect(paperEntry(doc('a', 'a.pdf'), 1, true).page).toBe(1)
    expect(paperEntry(doc('a', 'a.pdf'), 1, true).preview).toBe(true)
    expect(paperEntry(doc('a', 'a.pdf'), 1, false).preview).toBe(false)
  })
})

describe('upsertPaper: VS Code preview rules', () => {
  it('appends a permanent tab, even when a preview tab already exists', () => {
    const list = [tab('a', 1, true), tab('b')]
    expect(upsertPaper(list, tab('c')).map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('a single click replaces the existing preview tab in place', () => {
    const list = [tab('a'), tab('b', 1, true), tab('c')]
    const next = upsertPaper(list, tab('d', 5, true))
    expect(next.map((p) => p.id)).toEqual(['a', 'd', 'c'])
    expect(next[1]!.preview).toBe(true)
    expect(next[1]!.page).toBe(5)
  })

  it('permanent tabs are never replaced by a preview', () => {
    const list = [tab('a'), tab('b')]
    expect(upsertPaper(list, tab('c', 1, true)).map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('single clicking a permanent tab again does not degrade it to a preview', () => {
    const list = [tab('a'), tab('b')]
    const next = upsertPaper(list, tab('a', 9, true))
    expect(next).toHaveLength(2)
    expect(next[0]!.preview).toBe(false)
    expect(next[0]!.page).toBe(9)
  })

  it('reopens an existing tab in place with the new page, never twice', () => {
    const list = [tab('a'), tab('b'), tab('c')]
    const next = upsertPaper(list, tab('b', 12))
    expect(next.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(next[1]!.page).toBe(12)
    expect(next).not.toBe(list)
    // The original list is a snapshot, not something the caller mutates.
    expect(list[1]!.page).toBe(1)
  })

  it('a preview of a paper that already has a preview stays a preview', () => {
    const next = upsertPaper([tab('a', 1, true)], tab('a', 3, true))
    expect(next).toHaveLength(1)
    expect(next[0]!.preview).toBe(true)
    expect(next[0]!.page).toBe(3)
  })
})

describe('pinPaper', () => {
  it('turns a preview tab into a permanent one without moving it', () => {
    const list = [tab('a'), tab('b', 1, true), tab('c')]
    const next = pinPaper(list, 'b')
    expect(next.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(next[1]!.preview).toBe(false)
    expect(list[1]!.preview).toBe(true)
  })

  it('is a no-op for an already permanent tab or an unknown id', () => {
    const list = [tab('a')]
    expect(pinPaper(list, 'a')).toBe(list)
    expect(pinPaper(list, 'missing')).toBe(list)
  })

  it('a pinned preview survives the next single click', () => {
    const pinned = pinPaper([tab('a', 1, true)], 'a')
    const next = upsertPaper(pinned, tab('b', 1, true))
    expect(next.map((p) => p.id)).toEqual(['a', 'b'])
    expect(next[0]!.preview).toBe(false)
    expect(next[1]!.preview).toBe(true)
  })
})

describe('removePaper', () => {
  it('removes just the one tab and keeps the rest in order', () => {
    expect(removePaper([tab('a'), tab('b'), tab('c')], 'b').map((p) => p.id)).toEqual([
      'a',
      'c'
    ])
    expect(removePaper([tab('a')], 'missing').map((p) => p.id)).toEqual(['a'])
  })
})

describe('nextActivePaper', () => {
  it('moves to the neighbour after the closed tab', () => {
    const list = [tab('a'), tab('b'), tab('c')]
    expect(nextActivePaper(list, 'b')?.id).toBe('c')
    expect(nextActivePaper(list, 'a')?.id).toBe('b')
  })

  it('falls back to the last tab when the final one was closed', () => {
    const list = [tab('a'), tab('b'), tab('c')]
    expect(nextActivePaper(list, 'c')?.id).toBe('b')
  })

  it('empties the pane when the last tab goes', () => {
    expect(nextActivePaper([tab('a')], 'a')).toBeNull()
    expect(nextActivePaper([], 'a')).toBeNull()
  })

  it('answers null for a tab that is not there', () => {
    expect(nextActivePaper([tab('a')], 'missing')).toBeNull()
  })
})
