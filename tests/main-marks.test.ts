import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Behaviour cover for the annotation and reading-position channels.
 *
 * annotationMerge has its own unit tests; what was untested is whether the
 * start-up sync asks only about papers that already have local marks, isolates
 * one broken paper, writes the merge back through a fresh read, and only
 * pushes marks that have positions and a filehash. The reading-position cases
 * pin down a real defect: an in-process snapshot of reading.json that never
 * expired could overwrite a page another writer had just saved.
 *
 * The stubs are on the input side: Electron, the cloud client and the JSON
 * cache. The real merge rules run unchanged.
 */
import type { Annotation, CloudAnnotation } from '../shared/types'

const stub = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const state: {
    annotations: Annotation[]
    reading: Record<string, number>
    notes: Record<string, string>
    savedAnnotations: Annotation[][]
    savedReading: Record<string, number>[]
    cloudByDoc: Map<string, CloudAnnotation[]>
    hashByDoc: Map<string, string | null>
    created: Record<string, unknown>[]
    failDocs: Set<string>
    clientFail: string | null
  } = {
    annotations: [],
    reading: {},
    notes: {},
    savedAnnotations: [],
    savedReading: [],
    cloudByDoc: new Map(),
    hashByDoc: new Map(),
    created: [],
    failDocs: new Set(),
    clientFail: null
  }
  const client = {
    listAnnotations: async (docId: string) => {
      if (state.failDocs.has(docId)) throw new Error('cloud refused ' + docId)
      return state.cloudByDoc.get(docId) ?? []
    },
    fileHash: async (docId: string) => state.hashByDoc.get(docId) ?? null,
    createAnnotation: async (body: Record<string, unknown>) => {
      state.created.push(body)
      return { id: 'R' + state.created.length, ...body }
    },
    deleteAnnotation: async () => {}
  }
  return { handlers, state, client }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      stub.handlers.set(channel, fn)
    }
  },
  app: { getPath: () => '/tmp/mendeley-ng-marks-test', getVersion: () => '0.0.0' }
}))

vi.mock('../electron/main/library', () => ({
  ensureClient: () => {
    if (stub.state.clientFail) throw new Error(stub.state.clientFail)
    return stub.client
  }
}))

vi.mock('../electron/main/store', () => ({
  loadAnnotations: () => stub.state.annotations.map((a) => ({ ...a })),
  saveAnnotations: (list: Annotation[]) => {
    // the real store rewrites the file; a fresh read must see exactly this
    stub.state.annotations = list.map((a) => ({ ...a }))
    stub.state.savedAnnotations.push(list)
  },
  loadReading: () => ({ ...stub.state.reading }),
  saveReading: (r: Record<string, number>) => {
    stub.state.reading = { ...r }
    stub.state.savedReading.push({ ...r })
  },
  loadNotes: () => ({ ...stub.state.notes }),
  saveNotes: (n: Record<string, string>) => {
    stub.state.notes = { ...n }
  }
}))

function ann(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'L1',
    docId: 'd1',
    page: 1,
    type: 'highlight',
    color: '#ffe066',
    rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
    created: 'now',
    ...over
  }
}

function cloud(over: Partial<CloudAnnotation> = {}): CloudAnnotation {
  return {
    id: 'C1',
    document_id: 'd1',
    type: 'highlight',
    positions: [
      { top_left: { x: 10, y: 20 }, bottom_right: { x: 50, y: 40 }, page: 2 }
    ],
    ...over
  }
}

async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  const h = stub.handlers.get(name)
  if (!h) throw new Error('channel not registered: ' + name)
  return await h(null, ...args)
}

beforeAll(async () => {
  const { registerMarksIpc } = await import('../electron/main/ipc/marks')
  registerMarksIpc()
})

beforeEach(() => {
  stub.state.annotations = []
  stub.state.reading = {}
  stub.state.notes = {}
  stub.state.savedAnnotations = []
  stub.state.savedReading = []
  stub.state.cloudByDoc = new Map()
  stub.state.hashByDoc = new Map()
  stub.state.created = []
  stub.state.failDocs = new Set()
  stub.state.clientFail = null
})

describe('the harness', () => {
  it('captures the channels it is about to exercise', () => {
    for (const name of [
      'annotations:syncAtStart',
      'annotations:load',
      'annotations:save',
      'reading:load',
      'reading:set',
      'notes:load',
      'notes:save'
    ]) {
      expect(stub.handlers.has(name), name).toBe(true)
    }
  })
})

describe('annotations:syncAtStart', () => {
  it('returns a quiet skip when there is no client', async () => {
    stub.state.clientFail = 'NO_TOKEN'
    const r = (await invoke('annotations:syncAtStart')) as {
      docs: number
      pulled: number
      pushed: number
      skipped: string[]
    }
    expect(r.docs).toBe(0)
    expect(r.pulled).toBe(0)
    expect(r.skipped[0]).toContain('NO_TOKEN')
  })

  it('asks only about papers that already have local marks, once each', async () => {
    stub.state.annotations = [
      ann({ id: 'L1', docId: 'd1' }),
      ann({ id: 'L2', docId: 'd1' }),
      ann({ id: 'L3', docId: 'd2' })
    ]
    const asked: string[] = []
    const original = stub.client.listAnnotations
    stub.client.listAnnotations = async (id: string) => {
      asked.push(id)
      return original(id)
    }
    try {
      const r = (await invoke('annotations:syncAtStart')) as { docs: number }
      expect(r.docs).toBe(2)
      expect(asked).toEqual(['d1', 'd2'])
    } finally {
      stub.client.listAnnotations = original
    }
  })

  it('merges a new cloud mark into the file and counts it', async () => {
    stub.state.annotations = [ann({ id: 'L1', docId: 'd1' })]
    stub.state.cloudByDoc.set('d1', [cloud({ id: 'C1' })])
    const r = (await invoke('annotations:syncAtStart')) as { pulled: number }
    expect(r.pulled).toBe(1)
    const ids = stub.state.annotations.map((a) => a.id)
    expect(ids).toContain('L1')
    expect(ids).toContain('cloud-C1')
    expect(stub.state.annotations.find((a) => a.id === 'cloud-C1')?.remoteId).toBe('C1')
  })

  it('one broken paper does not stop the others', async () => {
    stub.state.annotations = [ann({ docId: 'd1' }), ann({ id: 'L2', docId: 'd2' })]
    stub.state.failDocs.add('d1')
    stub.state.cloudByDoc.set('d2', [cloud({ id: 'C2', document_id: 'd2' })])
    const r = (await invoke('annotations:syncAtStart')) as {
      docs: number
      pulled: number
      skipped: string[]
    }
    expect(r.docs).toBe(2)
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]).toContain('d1')
    expect(r.pulled).toBe(1)
    expect(stub.state.annotations.map((a) => a.id)).toContain('cloud-C2')
  })

  it('pushes a local mark with positions and records the remote id', async () => {
    stub.state.annotations = [
      ann({ id: 'L1', pos: [{ page: 3, x: 1, y: 2, w: 3, h: 4 }] })
    ]
    stub.state.hashByDoc.set('d1', 'sha1-hash')
    const r = (await invoke('annotations:syncAtStart')) as { pushed: number }
    expect(r.pushed).toBe(1)
    expect(stub.state.created).toHaveLength(1)
    expect(stub.state.created[0]).toMatchObject({
      document_id: 'd1',
      filehash: 'sha1-hash',
      type: 'highlight'
    })
    expect(stub.state.annotations.find((a) => a.id === 'L1')?.remoteId).toBe('R1')
  })

  it('does not push when the cloud has no filehash for the paper', async () => {
    stub.state.annotations = [
      ann({ id: 'L1', pos: [{ page: 3, x: 1, y: 2, w: 3, h: 4 }] })
    ]
    const r = (await invoke('annotations:syncAtStart')) as { pushed: number }
    expect(r.pushed).toBe(0)
    expect(stub.state.created).toEqual([])
  })
})

describe('reading position', () => {
  it('clamps the page to a positive whole number', async () => {
    await invoke('reading:set', 'd1', 0)
    await invoke('reading:set', 'd2', -4)
    await invoke('reading:set', 'd3', 7.9)
    expect(stub.state.reading).toEqual({ d1: 1, d2: 1, d3: 7 })
  })

  it('reading:load reports what is on disk', async () => {
    stub.state.reading = { d1: 12 }
    expect(await invoke('reading:load')).toEqual({ d1: 12 })
  })

  it('never overwrites a page another writer saved since the last set', async () => {
    await invoke('reading:set', 'd1', 3)
    // Another writer (a second window, a restore, a hand edit) lands between
    // two sets. loadReading() is the only place that can see it.
    stub.state.reading = { d1: 3, d2: 7 }
    await invoke('reading:set', 'd3', 5)
    expect(stub.state.reading).toEqual({ d1: 3, d2: 7, d3: 5 })
    expect(await invoke('reading:load')).toEqual({ d1: 3, d2: 7, d3: 5 })
  })
})
