import { describe, expect, it } from 'vitest'

import type { Doc } from '../shared/types'
import {
  nextActivePaper,
  paperEntry,
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

const tab = (id: string, page: number | null = 1): OpenPaper => ({
  id,
  doc: doc(id, 'C:/pdf/' + id + '.pdf'),
  page,
  tab: 'pdf'
})

describe('paperEntry', () => {
  it('opens a paper with a file in the reader and one without on its details', () => {
    expect(paperEntry(doc('a', 'a.pdf'), 7)).toEqual({
      id: 'a',
      doc: doc('a', 'a.pdf'),
      page: 7,
      tab: 'pdf'
    })
    expect(paperEntry(doc('b'), null).tab).toBe('details')
  })

  it('keeps "no page specified" distinct from page one', () => {
    expect(paperEntry(doc('a', 'a.pdf'), null).page).toBeNull()
    expect(paperEntry(doc('a', 'a.pdf'), 1).page).toBe(1)
  })
})

describe('upsertPaper', () => {
  it('appends a paper that has no tab yet', () => {
    expect(upsertPaper([], tab('a')).map((p) => p.id)).toEqual(['a'])
    expect(upsertPaper([tab('a')], tab('b')).map((p) => p.id)).toEqual(['a', 'b'])
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
