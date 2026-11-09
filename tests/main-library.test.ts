import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Behaviour cover for the cloud pull, not for the pure merge rules it calls.
 *
 * reconcileSyncWrite and createSyncQueue have their own unit tests; what was
 * untested is whether the pull actually feeds them the right snapshots, asks
 * the cloud trash on every run, keeps a folder membership the API left blank,
 * re-reads the config before writing the watermark, and serialises two pulls.
 * Every stub is on the input side: the client, the JSON cache, the window
 * status channel and the PDF matcher. The real merge rules run unchanged.
 */
type Doc = {
  id: string
  title?: string
  folder_uuids?: string[]
  localPdf?: string
  file_attached?: boolean
  starred?: boolean
}
type Library = { docs: Doc[]; folders: { id: string }[]; syncedAt?: string }

const stub = vi.hoisted(() => {
  const state: {
    library: Library | null
    config: Record<string, unknown>
    folders: { id: string }[]
    trash: { id: string }[]
    changed: Doc[]
    withFiles: string[]
    sinceCalls: (string | undefined)[]
    statuses: unknown[]
    savedLibraries: { docs: Doc[]; folders: { id: string }[] }[]
    savedConfigs: Record<string, unknown>[]
    attachCalls: number
    fail: string | null
    onPull: (() => void) | null
  } = {
    library: null,
    config: {},
    folders: [],
    trash: [],
    changed: [],
    withFiles: [],
    sinceCalls: [],
    statuses: [],
    savedLibraries: [],
    savedConfigs: [],
    attachCalls: 0,
    fail: null,
    onPull: null
  }
  const client = {
    allFolders: async () => state.folders,
    listTrash: async () => state.trash,
    allDocuments: async (_onPage: (n: number) => void, since?: string) => {
      state.sinceCalls.push(since)
      state.onPull?.()
      if (state.fail) throw new Error(state.fail)
      return state.changed
    },
    fileDocumentIds: async () => new Set(state.withFiles),
    listAnnotations: async () => [],
    fileHash: async () => null,
    createAnnotation: async () => ({ id: 'remote' })
  }
  return { state, client }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/mendeley-ng-library-test', getVersion: () => '0.0.0' },
  ipcMain: { handle: () => {} },
  BrowserWindow: class {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) }
}))

vi.mock('../electron/main/mendeley', () => ({
  findToken: () => ({ path: '/tmp/token.json', tok: { access_token: 'x' } }),
  // A constructor may return another object; that keeps the real ensureClient
  // path while answering every cloud call from the stub above.
  Mendeley: class {
    constructor() {
      return stub.client as never
    }
  }
}))

vi.mock('../electron/main/store', () => ({
  DEFAULT_PDF_DIR: '/tmp/mendeley-ng-default-pdfs',
  loadLibrary: () => stub.state.library,
  saveLibraryFromSync: (docs: Doc[], folders: { id: string }[]) => {
    stub.state.savedLibraries.push({ docs, folders })
    stub.state.library = { docs, folders, syncedAt: new Date().toISOString() }
  },
  loadConfig: () => stub.state.config,
  saveConfig: (c: Record<string, unknown>) => {
    stub.state.savedConfigs.push(c)
    stub.state.config = c
  },
  saveLibrary: () => {},
  loadAnnotations: () => [],
  saveAnnotations: () => {},
  loadNotes: () => ({}),
  saveNotes: () => {},
  loadReading: () => ({}),
  saveReading: () => {},
  dataDir: () => '/tmp/mendeley-ng-library-test/library'
}))

vi.mock('../electron/main/window', () => ({
  status: (s: unknown) => {
    stub.state.statuses.push(s)
  },
  getWin: () => null,
  setWin: () => {}
}))

vi.mock('../electron/main/pdfindex', () => ({
  attachPdfs: (docs: Doc[]) => {
    stub.state.attachCalls++
    return { matched: 0, total: docs.length }
  },
  parseName: () => ({ title: '', year: undefined })
}))

const { sync } = await import('../electron/main/library')

/** Await the body before cleaning up: the pull checks the PDF path with
 *  existsSync after its awaits, so a synchronous cleanup would delete the
 *  file before the assertion ever ran. */
async function withTmpDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendeley-ng-sync-'))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

beforeEach(() => {
  stub.state.library = null
  stub.state.config = { fontSize: 15, pdfDir: '/tmp/pdfs' }
  stub.state.folders = [{ id: 'f1' }]
  stub.state.trash = []
  stub.state.changed = []
  stub.state.withFiles = []
  stub.state.sinceCalls = []
  stub.state.statuses = []
  stub.state.savedLibraries = []
  stub.state.savedConfigs = []
  stub.state.attachCalls = 0
  stub.state.fail = null
  stub.state.onPull = null
})

describe('full pull', () => {
  it('asks for every document, reconciles, writes the cache and reports done', async () => {
    stub.state.changed = [{ id: 'd1', title: 'One' }, { id: 'd2', title: 'Two' }]
    const r = await sync(true)
    expect(stub.state.sinceCalls).toEqual([undefined])
    expect(r.docs.map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(r.folders).toEqual([{ id: 'f1' }])
    expect(stub.state.savedLibraries).toHaveLength(1)
    expect(stub.state.attachCalls).toBe(1)
    const done = stub.state.statuses.at(-1) as { phase: string; done: number }
    expect(done.phase).toBe('done')
    expect(done.done).toBe(2)
  })

  it('marks file_attached from the cloud file list', async () => {
    stub.state.changed = [{ id: 'd1' }, { id: 'd2' }]
    stub.state.withFiles = ['d2']
    const r = await sync(true)
    expect(r.docs.find((d) => d.id === 'd1')?.file_attached).toBe(false)
    expect(r.docs.find((d) => d.id === 'd2')?.file_attached).toBe(true)
  })

  it('cross-checks the cloud trash on every pull, not only a full one', async () => {
    stub.state.library = {
      docs: [{ id: 'gone' }],
      folders: [],
      syncedAt: '2026-01-01T00:00:00.000Z'
    }
    stub.state.changed = [{ id: 'gone', title: 'back again' }]
    stub.state.trash = [{ id: 'gone' }]
    const r = await sync(false)
    expect(r.docs.map((d) => d.id)).toEqual([])
    expect(stub.state.savedLibraries[0]?.docs).toEqual([])
  })
})

describe('incremental pull', () => {
  const WATERMARK = '2026-01-01T00:00:00.000Z'

  it('sends a since filter overlapped by one minute and merges into the cache', async () => {
    stub.state.library = {
      docs: [{ id: 'old', title: 'Old' }],
      folders: [],
      syncedAt: WATERMARK
    }
    stub.state.changed = [{ id: 'new', title: 'New' }]
    const r = await sync(false)
    expect(stub.state.sinceCalls).toEqual(['2025-12-31T23:59:00.000Z'])
    expect(r.docs.map((d) => d.id).sort()).toEqual(['new', 'old'])
  })

  it('keeps a folder membership the API answered blank', async () => {
    stub.state.library = {
      docs: [{ id: 'd1', folder_uuids: ['f1'] }],
      folders: [],
      syncedAt: WATERMARK
    }
    stub.state.changed = [{ id: 'd1', folder_uuids: [] }]
    const r = await sync(false)
    expect(r.docs[0]?.folder_uuids).toEqual(['f1'])
  })

  it('a full pull treats an empty folder list as authoritative', async () => {
    stub.state.changed = [{ id: 'd1', folder_uuids: [] }]
    const r = await sync(true)
    expect(r.docs[0]?.folder_uuids).toEqual([])
  })

  it('keeps a resolved local PDF path when the file is still there', async () => {
    await withTmpDir((dir) => {
      const pdf = path.join(dir, 'paper.pdf')
      fs.writeFileSync(pdf, 'bytes')
      stub.state.library = {
        docs: [{ id: 'd1', localPdf: pdf }],
        folders: [],
        syncedAt: WATERMARK
      }
      stub.state.changed = [{ id: 'd1', title: 'renamed in the cloud' }]
      return sync(false).then((r) => {
        expect(r.docs[0]?.localPdf).toBe(pdf)
        expect(r.docs[0]?.title).toBe('renamed in the cloud')
      })
    })
  })

  it('skips the two expensive steps when nothing changed', async () => {
    stub.state.library = {
      docs: [{ id: 'old' }],
      folders: [],
      syncedAt: WATERMARK
    }
    stub.state.changed = []
    const r = await sync(false)
    expect(stub.state.attachCalls).toBe(0)
    expect(r.docs).toHaveLength(1)
  })

  it('does not resurrect a paper trashed locally while the pull was in flight', async () => {
    stub.state.library = {
      docs: [{ id: 'd1' }, { id: 'd2' }],
      folders: [],
      syncedAt: WATERMARK
    }
    stub.state.changed = [{ id: 'd1' }]
    // the reader deleted d2 from the cache while the network call was open
    stub.state.onPull = () => {
      stub.state.library = { docs: [{ id: 'd1' }], folders: [], syncedAt: WATERMARK }
    }
    const r = await sync(false)
    expect(r.docs.map((d) => d.id)).toEqual(['d1'])
  })
})

describe('config and queue', () => {
  it('re-reads the config before writing, so a change during the pull survives', async () => {
    stub.state.changed = [{ id: 'd1' }]
    stub.state.onPull = () => {
      stub.state.config = { ...stub.state.config, fontSize: 22 }
    }
    await sync(true)
    const written = stub.state.savedConfigs.at(-1)!
    expect(written.fontSize).toBe(22)
    expect(typeof written.lastSync).toBe('string')
  })

  it('two concurrent pulls are serialised and the second sees the first result', async () => {
    stub.state.changed = [{ id: 'first' }]
    const a = sync(true)
    // the queue has not started the second pull yet, so its snapshot is the
    // library the first one is about to write
    const b = sync(false)
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.docs.map((d) => d.id)).toEqual(['first'])
    expect(stub.state.savedLibraries).toHaveLength(2)
    expect(stub.state.sinceCalls.length).toBe(2)
    expect(rb.docs.map((d) => d.id)).toEqual(['first'])
  })

  it('a failed pull does not poison the queue', async () => {
    stub.state.fail = 'network down'
    await expect(sync(true)).rejects.toThrow('network down')
    stub.state.fail = null
    stub.state.changed = [{ id: 'after' }]
    const r = await sync(true)
    expect(r.docs.map((d) => d.id)).toEqual(['after'])
  })
})
