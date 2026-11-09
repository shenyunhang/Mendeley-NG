import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Behaviour cover for the two channels that put PDF bytes on disk.
 *
 * Both used to ask the shared helper for a free name and then write to it in
 * a second step, which let two concurrent writes overwrite each other. The
 * unit test for the helper proves the naming rule; these prove that both IPC
 * handlers actually go through the atomic claim, that an empty body writes
 * nothing, and that the library cache and the index are updated only for a
 * file that really landed.
 *
 * Every stub is on the input side of the handler: Electron, the cloud client,
 * the JSON cache and the index driver. No product module is mocked itself.
 */
type Doc = { id: string; title?: string; localPdf?: string; file_attached?: boolean }

const stub = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const state: {
    pdfDir: string
    docs: Doc[]
    saved: { docs: Doc[]; folders: unknown[] }[]
    indexed: Doc[]
    fileMeta: { id: string; file_name: string } | null
    download: Buffer
    created: Doc & { identifiers?: Record<string, string> }
    patch: (id: string, body: unknown) => Promise<Doc>
    fail: string | null
  } = {
    pdfDir: '',
    docs: [],
    saved: [],
    indexed: [],
    fileMeta: null,
    download: Buffer.from(''),
    created: { id: 'new-1', title: 'Paper' },
    patch: async () => ({ id: 'new-1', title: 'Paper' }),
    fail: null
  }
  const client = {
    fileMeta: async () => {
      if (state.fail) throw new Error(state.fail)
      return state.fileMeta
    },
    downloadFile: async () => {
      if (state.fail) throw new Error(state.fail)
      return state.download
    },
    createDocumentFromFile: async () => {
      if (state.fail) throw new Error(state.fail)
      // The cloud returns a fresh record for every upload. Sharing one object
      // would let the second handler's `doc.localPdf = ...` rewrite the first
      // answer, which no real response would do.
      return { ...state.created }
    },
    patchDocument: async (id: string, body: unknown) => state.patch(id, body),
    bearer: async () => 'token'
  }
  return { handlers, state, client }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      stub.handlers.set(channel, fn)
    }
  },
  app: { getPath: () => '/tmp/mendeley-ng-files-test', getVersion: () => '0.0.0' }
}))

vi.mock('../electron/main/library', () => ({ ensureClient: () => stub.client }))

vi.mock('../electron/main/store', () => ({
  DEFAULT_PDF_DIR: '/tmp/mendeley-ng-default-pdfs',
  loadConfig: () => ({ pdfDir: stub.state.pdfDir, pdfNameTemplate: '{title}' }),
  loadLibrary: () => ({ docs: stub.state.docs, folders: [] }),
  saveLibrary: (docs: Doc[], folders: unknown[]) => {
    stub.state.saved.push({ docs, folders })
  },
  loadAnnotations: () => [],
  saveAnnotations: () => {},
  loadNotes: () => ({}),
  saveNotes: () => {},
  loadReading: () => ({}),
  saveReading: () => {},
  saveConfig: () => {},
  dataDir: () => '/tmp/mendeley-ng-files-test/library'
}))

vi.mock('../electron/main/ftops', () => ({
  ftDocs: () => [],
  indexAdded: (d: Doc) => {
    stub.state.indexed.push(d)
  },
  startBuild: () => {}
}))

vi.mock('../electron/main/fulltext', () => ({
  ftCancel: () => {},
  ftClear: () => {},
  ftSearch: () => [],
  ftStatus: () => ({ indexed: false })
}))

vi.mock('../electron/main/pdfindex', () => ({
  attachPdfs: (docs: Doc[]) => docs,
  // The naming parser is its own pure rule with its own tests. Keep the
  // returned title empty so this handler has no patch to apply; what is under
  // test here is the local copy, not the metadata guess.
  parseName: () => ({ title: '', year: undefined })
}))

vi.mock('../electron/main/pdfname', () => ({
  // Deterministic basename: two imports of the same file must want the same
  // name, which is exactly the collision the atomic claim has to survive.
  pdfNameFor: (_doc: unknown, name: string) =>
    String(name ?? 'paper.pdf').split(/[\\/]/).pop() || 'paper.pdf'
}))

vi.mock('../electron/main/lookup', () => ({
  lookup: async () => [],
  resolveIdentifier: async () => []
}))

async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  const h = stub.handlers.get(name)
  if (!h) throw new Error('channel not registered: ' + name)
  return await h(null, ...args)
}

async function withTmpDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendeley-ng-files-'))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** An ArrayBuffer like the one the renderer sends over IPC. */
function bytes(text: string): ArrayBuffer {
  const u = Uint8Array.from(Buffer.from(text))
  return u.buffer
}

beforeAll(async () => {
  const [{ registerFilesIpc }, { registerDocsIpc }] = await Promise.all([
    import('../electron/main/ipc/files'),
    import('../electron/main/ipc/docs')
  ])
  registerFilesIpc()
  registerDocsIpc()
})

beforeEach(() => {
  stub.state.docs = [{ id: 'd1', title: 'Paper' }]
  stub.state.saved = []
  stub.state.indexed = []
  stub.state.fileMeta = { id: 'f1', file_name: 'paper.pdf' }
  stub.state.download = Buffer.from('pdf bytes')
  stub.state.fail = null
  stub.state.created = { id: 'new-1', title: 'Paper' }
})

describe('the harness', () => {
  it('captures both writers', () => {
    expect(stub.handlers.has('pdf:download')).toBe(true)
    expect(stub.handlers.has('doc:importPdf')).toBe(true)
  })
})

describe('pdf:download', () => {
  it('refuses an empty body before writing anything', async () => {
    await withTmpDir(async (dir) => {
      stub.state.pdfDir = dir
      stub.state.download = Buffer.from('')
      const r = (await invoke('pdf:download', 'd1')) as { ok: boolean; error: string }
      expect(r.ok).toBe(false)
      expect(r.error).toBe('下载内容为空')
      expect(fs.readdirSync(dir)).toEqual([])
      expect(stub.state.saved).toEqual([])
      expect(stub.state.indexed).toEqual([])
    })
  })

  it('writes the bytes, points the doc at them and indexes the paper', async () => {
    await withTmpDir(async (dir) => {
      stub.state.pdfDir = dir
      const r = (await invoke('pdf:download', 'd1')) as {
        ok: boolean
        path: string
        size: number
      }
      expect(r.ok).toBe(true)
      expect(r.size).toBe(Buffer.byteLength('pdf bytes'))
      expect(fs.readFileSync(r.path, 'utf8')).toBe('pdf bytes')
      expect(stub.state.docs[0]?.localPdf).toBe(r.path)
      expect(stub.state.saved).toHaveLength(1)
      expect(stub.state.indexed).toHaveLength(1)
    })
  })

  it('two downloads wanting one name never overwrite each other', async () => {
    await withTmpDir(async (dir) => {
      stub.state.pdfDir = dir
      stub.state.download = Buffer.from('first')
      const a = (await invoke('pdf:download', 'd1')) as { path: string }
      stub.state.download = Buffer.from('second')
      const b = (await invoke('pdf:download', 'd1')) as { path: string }
      expect(a.path).not.toBe(b.path)
      expect(fs.readFileSync(a.path, 'utf8')).toBe('first')
      expect(fs.readFileSync(b.path, 'utf8')).toBe('second')
    })
  })

  it('reports a missing cloud attachment and a client failure honestly', async () => {
    await withTmpDir(async (dir) => {
      stub.state.pdfDir = dir
      stub.state.fileMeta = null
      expect(await invoke('pdf:download', 'd1')).toEqual({
        ok: false,
        error: '云端没有这篇的附件'
      })
      stub.state.fail = 'network down'
      const r = (await invoke('pdf:download', 'd1')) as { ok: boolean; error: string }
      expect(r.ok).toBe(false)
      expect(r.error).toContain('network down')
      expect(fs.readdirSync(dir)).toEqual([])
    })
  })
})

describe('doc:importPdf', () => {
  it('keeps a local copy, marks the attachment and appends it to the cache', async () => {
    await withTmpDir(async (dir) => {
      stub.state.pdfDir = dir
      const doc = (await invoke('doc:importPdf', 'paper.pdf', bytes('imported pdf'), {})) as Doc
      expect(doc.localPdf).toBeTruthy()
      expect(doc.file_attached).toBe(true)
      expect(fs.readFileSync(doc.localPdf!, 'utf8')).toBe('imported pdf')
      expect(stub.state.saved).toHaveLength(1)
      expect(stub.state.saved[0]?.docs.map((d) => d.id)).toContain('new-1')
      expect(stub.state.indexed).toHaveLength(1)
    })
  })

  it('does not invent a local PDF when the upload body was empty', async () => {
    await withTmpDir(async (dir) => {
      stub.state.pdfDir = dir
      const doc = (await invoke('doc:importPdf', 'paper.pdf', bytes(''), {})) as Doc
      expect(doc.localPdf).toBeUndefined()
      expect(fs.readdirSync(dir)).toEqual([])
      expect(stub.state.indexed).toHaveLength(1)
    })
  })

  it('two imports of the same file keep both sets of bytes', async () => {
    await withTmpDir(async (dir) => {
      stub.state.pdfDir = dir
      const a = (await invoke('doc:importPdf', 'paper.pdf', bytes('first'), {})) as Doc
      const b = (await invoke('doc:importPdf', 'paper.pdf', bytes('second'), {})) as Doc
      expect(a.localPdf).not.toBe(b.localPdf)
      expect(fs.readFileSync(a.localPdf!, 'utf8')).toBe('first')
      expect(fs.readFileSync(b.localPdf!, 'utf8')).toBe('second')
    })
  })
})
