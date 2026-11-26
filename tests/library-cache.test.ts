import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `store.ts` now keeps the parsed library behind a file-identity check.
 * These cases cover the three ways such a cache can lie: a file changed by
 * another writer, an edit made locally but never saved, and a write performed
 * by this process. The first read is also asserted to be the only large parse.
 */
const m = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => m.dir }
}))

let mod!: typeof import('../electron/main/store')
let file = ''

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `id-${i}`,
  title: `Paper ${i}`,
  folder_uuids: [] as string[]
}))

function writeLib(n: number, syncedAt = '2026-01-01T00:00:00.000Z') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ docs: docs(n), folders: [{ id: 'f1', name: 'Folder' }], syncedAt }),
    'utf8'
  )
}

beforeEach(async () => {
  vi.resetModules()
  m.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-cache-'))
  file = path.join(m.dir, 'library', 'library.json')
  mod = await import('../electron/main/store')
  writeLib(40)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(m.dir, { recursive: true, force: true })
})

describe('stamp-checked library cache', () => {
  it('parses the large file once across repeated reads', () => {
    const spy = vi.spyOn(JSON, 'parse')
    const a = mod.loadLibrary()
    const b = mod.loadLibrary()
    const c = mod.loadLibrary()
    expect(a?.docs).toHaveLength(40)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    const bigParses = spy.mock.calls.filter(
      ([raw]) => typeof raw === 'string' && raw.length > 1000
    )
    expect(bigParses).toHaveLength(1)
  })

  it('reparses when another writer changes the file', () => {
    expect(mod.loadLibrary()?.docs).toHaveLength(40)
    writeLib(7)
    expect(mod.loadLibrary()?.docs).toHaveLength(7)
  })

  it('reparses a same-size edit with a newer timestamp', () => {
    const first = mod.loadLibrary()
    expect(first?.docs[0]?.title).toBe('Paper 0')
    const raw = fs.readFileSync(file, 'utf8')
    // Same byte length, different content: only the timestamp can tell them
    // apart, which is why the stamp uses nanoseconds rather than milliseconds.
    const changed = raw.replace('Paper 0', 'Paper X')
    expect(changed).toHaveLength(raw.length)
    fs.writeFileSync(file, changed, 'utf8')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(file, future, future)
    expect(mod.loadLibrary()?.docs[0]?.title).toBe('Paper X')
  })

  it('does not let an unsaved local edit linger in the cache', () => {
    const a = mod.loadLibrary()!
    a.docs[0]!.title = 'unsaved edit'
    a.docs[0]!.folder_uuids!.push('f1')
    const b = mod.loadLibrary()!
    expect(b.docs[0]?.title).toBe('Paper 0')
    expect(b.docs[0]?.folder_uuids).toEqual([])
  })

  it('drops the entry on its own write and keeps the watermark', () => {
    const a = mod.loadLibrary()!
    mod.saveLibrary(docs(3), a.folders)
    const b = mod.loadLibrary()!
    expect(b.docs).toHaveLength(3)
    expect(b.syncedAt).toBe(a.syncedAt)
  })

  it('answers null for a missing or malformed cache', () => {
    expect(mod.loadLibrary()?.docs).toHaveLength(40)
    fs.writeFileSync(file, '{"docs":null,"folders":null}', 'utf8')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(file, future, future)
    expect(mod.loadLibrary()).toBeNull()
    fs.rmSync(file)
    expect(mod.loadLibrary()).toBeNull()
  })
})
