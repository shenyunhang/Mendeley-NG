import { describe, expect, it } from 'vitest'

import {
  keepKnownFolderMemberships,
  keepLocalPdfPaths,
  mergeChangedIntoCache
} from '../shared/librarySync'

/**
 * These three rules used to be inline in the pull. main-library.test.ts checks
 * that the pull still feeds them the right snapshots; this file checks the
 * rules themselves over fixed inputs, including the cases a real library only
 * produces once in a while.
 */
type Row = {
  id: string
  title?: string
  folder_uuids?: string[]
  localPdf?: string
}

describe('the detector', () => {
  it('can tell an incremental answer from an authoritative full one', () => {
    const previous = [{ id: 'old' }]
    const changed = [{ id: 'new' }]
    expect(mergeChangedIntoCache(previous, changed, false)).toBe(changed)
    expect(mergeChangedIntoCache(previous, changed, true)).not.toBe(changed)
  })
})

describe('mergeChangedIntoCache', () => {
  it('a full pull takes the cloud answer and drops cached-only rows', () => {
    expect(
      mergeChangedIntoCache(
        [{ id: 'a', title: 'cached' }, { id: 'gone' }],
        [{ id: 'a', title: 'cloud' }],
        false
      )
    ).toEqual([{ id: 'a', title: 'cloud' }])
  })

  it('an incremental pull keeps untouched rows and lets changed ones win by id', () => {
    const previous = [
      { id: 'a', title: 'old a' },
      { id: 'b', title: 'old b' }
    ]
    const changed = [{ id: 'b', title: 'new b' }, { id: 'c', title: 'new c' }]
    expect(mergeChangedIntoCache(previous, changed, true)).toEqual([
      { id: 'a', title: 'old a' },
      { id: 'b', title: 'new b' },
      { id: 'c', title: 'new c' }
    ])
  })

  it('an incremental pull with no changes is the cache itself', () => {
    const previous = [{ id: 'a' }, { id: 'b' }]
    expect(mergeChangedIntoCache(previous, [], true)).toEqual(previous)
  })

  it('an empty cache with an incremental pull still takes the changed rows', () => {
    expect(mergeChangedIntoCache([], [{ id: 'a' }], true)).toEqual([{ id: 'a' }])
  })
})

describe('keepKnownFolderMemberships', () => {
  it('an empty or missing folder list takes the known value', () => {
    // Annotate both sides: inference from the first array would make
    // folder_uuids required, which a changed row legitimately may omit.
    const previous: Row[] = [
      { id: 'a', folder_uuids: ['f1'] },
      { id: 'b', folder_uuids: ['f2'] }
    ]
    const changed: Row[] = [{ id: 'a', folder_uuids: [] }, { id: 'b' }]
    keepKnownFolderMemberships(previous, changed)
    expect(changed[0]?.folder_uuids).toEqual(['f1'])
    expect(changed[1]?.folder_uuids).toEqual(['f2'])
  })

  it('a non-empty answer is never overwritten, and a blank known value proves nothing', () => {
    const previous: Row[] = [
      { id: 'a', folder_uuids: ['f1'] },
      { id: 'b', folder_uuids: [] },
      { id: 'c' }
    ]
    const changed: Row[] = [
      { id: 'a', folder_uuids: ['f9'] },
      { id: 'b', folder_uuids: [] },
      { id: 'c', folder_uuids: [] },
      { id: 'not-in-cache', folder_uuids: [] }
    ]
    keepKnownFolderMemberships(previous, changed)
    expect(changed.map((d) => d.folder_uuids)).toEqual([
      ['f9'],
      [],
      [],
      []
    ])
  })

  it('changes the proposed objects in place, which the pull already holds', () => {
    const previous = [{ id: 'a', folder_uuids: ['f1'] }]
    const changed = [{ id: 'a', folder_uuids: [] }]
    keepKnownFolderMemberships(previous, changed)
    expect(changed[0]?.folder_uuids).toEqual(['f1'])
  })
})

describe('keepLocalPdfPaths', () => {
  it('restores a resolved path only when the file still exists', () => {
    const previous: Row[] = [
      { id: 'a', localPdf: '/papers/a.pdf' },
      { id: 'b', localPdf: '/papers/b.pdf' }
    ]
    const docs: Row[] = [{ id: 'a' }, { id: 'b' }]
    const asked: string[] = []
    keepLocalPdfPaths(previous, docs, (p) => {
      asked.push(p)
      return p.endsWith('a.pdf')
    })
    expect(docs[0]?.localPdf).toBe('/papers/a.pdf')
    expect(docs[1]?.localPdf).toBeUndefined()
    expect(asked).toEqual(['/papers/a.pdf', '/papers/b.pdf'])
  })

  it('never replaces a path the cloud answer already named', () => {
    const previous: Row[] = [{ id: 'a', localPdf: '/old.pdf' }]
    const docs: Row[] = [{ id: 'a', localPdf: '/new.pdf' }]
    keepLocalPdfPaths(previous, docs, () => true)
    expect(docs[0]?.localPdf).toBe('/new.pdf')
  })

  it('an absent cache leaves the proposed list alone', () => {
    const docs: Row[] = [{ id: 'a' }]
    keepLocalPdfPaths([], docs, () => true)
    expect(docs).toEqual([{ id: 'a' }])
  })
})
