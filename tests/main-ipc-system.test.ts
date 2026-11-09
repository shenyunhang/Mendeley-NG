import { beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Behaviour cover for the main-process IPC boundary.
 *
 * Nothing here opens a window, starts Electron or touches the real library.
 * The stub sits on the input side: `electron` is replaced before any product
 * module is imported, and the handlers registered through `ipcMain.handle`
 * are captured so each channel can be called directly with fixed inputs.
 * A source-string assertion can only prove a line exists; these prove what a
 * channel actually answers, including the failure shapes the renderer has to
 * branch on.
 */
const stub = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const clipboardText = { value: '' }
  const calls = {
    openExternal: [] as string[],
    openPath: [] as string[],
    showItemInFolder: [] as string[]
  }
  const openExternalImpl: { fn: (url: string) => Promise<void> } = {
    fn: () => Promise.resolve()
  }
  return { handlers, clipboardText, calls, openExternalImpl }
})

vi.mock('electron', () => ({
  app: {
    // store.ts computes DEFAULT_PDF_DIR at module load; a fixed path keeps
    // that side effect away from the real userData directory.
    getPath: () => '/tmp/mendeley-ng-ipc-test',
    getVersion: () => '0.0.0'
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      stub.handlers.set(channel, fn)
    }
  },
  clipboard: {
    writeText: (t: string) => {
      stub.clipboardText.value = t
    },
    readText: () => stub.clipboardText.value
  },
  shell: {
    openExternal: (url: string) => {
      stub.calls.openExternal.push(url)
      return stub.openExternalImpl.fn(url)
    },
    openPath: (p: string) => {
      stub.calls.openPath.push(p)
      return ''
    },
    showItemInFolder: (p: string) => {
      stub.calls.showItemInFolder.push(p)
    }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined })
  },
  BrowserWindow: class {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) }
}))

type Handler = (...args: unknown[]) => unknown

/** Call a captured channel the way ipcRenderer.invoke would. */
function channel(name: string): Handler {
  const h = stub.handlers.get(name)
  if (!h) throw new Error('channel not registered: ' + name)
  return h
}

async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  return await channel(name)(null, ...args)
}

/** Await the body before removing the directory: an async test that returns a
 *  promise would otherwise have its files cleaned up while it is still
 *  asserting on them. */
async function withTmpDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendeley-ng-ipc-'))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

beforeAll(async () => {
  const { registerSystemIpc } = await import('../electron/main/ipc/system')
  registerSystemIpc()
})

describe('the harness', () => {
  it('captures the channels it is about to exercise', () => {
    // A "channel is missing" conclusion is worthless if the captor never
    // recorded anything, so prove it can see a registration first.
    expect(stub.handlers.size).toBeGreaterThan(10)
    for (const name of [
      'shell:openExternal',
      'export:pdfPlan',
      'export:leave',
      'clipboard:write',
      'clipboard:read',
      'pdf:reveal',
      'pdf:openExternal'
    ]) {
      expect(stub.handlers.has(name), name).toBe(true)
    }
  })
})

describe('shell:openExternal', () => {
  it('opens a web address and reports success only after the promise settles', async () => {
    stub.calls.openExternal.length = 0
    const settled: string[] = []
    stub.openExternalImpl.fn = async (url) => {
      settled.push(url)
    }
    const r = (await invoke('shell:openExternal', 'https://example.com/paper')) as {
      ok: boolean
      error?: string
    }
    expect(r).toEqual({ ok: true })
    expect(stub.calls.openExternal).toEqual(['https://example.com/paper'])
    expect(settled).toEqual(['https://example.com/paper'])
  })

  it('never hands a local or custom scheme to the OS shell', async () => {
    stub.calls.openExternal.length = 0
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'smb://host/share',
      'javascript:alert(1)',
      'mendeley://pdf/../token.json',
      'not a url'
    ]) {
      const r = (await invoke('shell:openExternal', url)) as { ok: boolean; error: string }
      expect(r.ok, url).toBe(false)
      expect(r.error).toBe('unsupported url scheme')
    }
    expect(stub.calls.openExternal).toEqual([])
  })

  it('turns a rejected open into an error result instead of a false success', async () => {
    stub.openExternalImpl.fn = () => Promise.reject(new Error('no handler for https'))
    const r = (await invoke('shell:openExternal', 'https://example.com')) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('no handler for https')
    stub.openExternalImpl.fn = () => Promise.resolve()
  })
})

describe('export:pdfPlan', () => {
  it('skips missing files, adds up real bytes and never gives two papers one name', async () => {
    await withTmpDir(async (dir) => {
      const a = path.join(dir, 'one.pdf')
      const b = path.join(dir, 'two.pdf')
      const c = path.join(dir, 'three.pdf')
      fs.writeFileSync(a, '12345')
      fs.writeFileSync(b, '123')
      fs.writeFileSync(c, '1234567')
      // same basename in a different source directory
      const other = path.join(dir, 'nested')
      fs.mkdirSync(other)
      const dup = path.join(other, 'one.pdf')
      fs.writeFileSync(dup, '12')

      const r = (await invoke('export:pdfPlan', [
        a,
        path.join(dir, 'gone.pdf'),
        b,
        dup,
        c
      ])) as { copies: { from: string; to: string }[]; bytes: number }

      expect(r.bytes).toBe(5 + 3 + 2 + 7)
      expect(r.copies.map((x) => x.to)).toEqual([
        'pdf/one.pdf',
        'pdf/two.pdf',
        'pdf/one-2.pdf',
        'pdf/three.pdf'
      ])
    })
  })

  it('an empty plan costs nothing', async () => {
    expect(await invoke('export:pdfPlan', [])).toEqual({ copies: [], bytes: 0 })
  })
})

describe('export:leave', () => {
  it('writes the text files and copies the PDFs, reporting what landed', async () => {
    await withTmpDir(async (dir) => {
      const out = path.join(dir, 'out')
      const src = path.join(dir, 'paper.pdf')
      fs.writeFileSync(src, 'pdf bytes')

      const r = (await invoke(
        'export:leave',
        out,
        [{ name: 'library.bib', text: '@article{a}' }],
        [{ from: src, to: 'pdf/paper.pdf' }]
      )) as { dir: string; files: string[]; copied: number; failed: unknown[]; bytes: number }

      expect(r.files).toEqual(['library.bib'])
      expect(r.copied).toBe(1)
      expect(r.failed).toEqual([])
      expect(r.bytes).toBe(Buffer.byteLength('pdf bytes'))
      expect(fs.readFileSync(path.join(out, 'library.bib'), 'utf8')).toBe('@article{a}')
      expect(fs.readFileSync(path.join(out, 'pdf', 'paper.pdf'), 'utf8')).toBe('pdf bytes')
    })
  })

  it('refuses the whole batch when any renderer-supplied name escapes the folder', async () => {
    await withTmpDir(async (dir) => {
      const out = path.join(dir, 'out')
      const escaped = path.join(dir, 'escaped.txt')
      const r = (await invoke(
        'export:leave',
        out,
        [
          { name: 'fine.bib', text: 'ok' },
          { name: '../escaped.txt', text: 'no' }
        ],
        []
      )) as { error?: string; files?: string[] }

      expect(String(r.error)).toContain('不安全的导出文件名')
      expect(r.files).toBeUndefined()
      expect(fs.existsSync(escaped)).toBe(false)
      expect(fs.existsSync(path.join(out, 'fine.bib'))).toBe(false)
    })
  })

  it('refuses an escaping PDF destination as well', async () => {
    await withTmpDir(async (dir) => {
      const out = path.join(dir, 'out')
      const src = path.join(dir, 'paper.pdf')
      fs.writeFileSync(src, 'x')
      const r = (await invoke('export:leave', out, [], [
        { from: src, to: '../stolen.pdf' }
      ])) as { error?: string }
      expect(String(r.error)).toContain('不安全的 PDF 目标名')
      expect(fs.existsSync(path.join(dir, 'stolen.pdf'))).toBe(false)
    })
  })

  it('a second export to the same folder takes a free suffix instead of overwriting', async () => {
    await withTmpDir(async (dir) => {
      const out = path.join(dir, 'out')
      const a = path.join(dir, 'a.pdf')
      const b = path.join(dir, 'b.pdf')
      fs.writeFileSync(a, 'first')
      fs.writeFileSync(b, 'second')
      await invoke('export:leave', out, [], [{ from: a, to: 'pdf/paper.pdf' }])
      await invoke('export:leave', out, [], [{ from: b, to: 'pdf/paper.pdf' }])
      expect(fs.readFileSync(path.join(out, 'pdf', 'paper.pdf'), 'utf8')).toBe('first')
      expect(fs.readFileSync(path.join(out, 'pdf', 'paper-2.pdf'), 'utf8')).toBe('second')
    })
  })
})

describe('the small system channels', () => {
  it('copies through Electron clipboard rather than the DOM one', async () => {
    expect(await invoke('clipboard:write', 'hello')).toBe(true)
    expect(await invoke('clipboard:read')).toBe('hello')
    expect(await invoke('clipboard:write', undefined)).toBe(true)
    expect(await invoke('clipboard:read')).toBe('')
  })

  it('refuses an empty path before touching the shell', async () => {
    stub.calls.showItemInFolder.length = 0
    stub.calls.openPath.length = 0
    expect(await invoke('pdf:reveal', '')).toEqual({ ok: false, error: 'no path' })
    expect(await invoke('pdf:openExternal', '')).toEqual({ ok: false, error: 'no path' })
    expect(stub.calls.showItemInFolder).toEqual([])
    expect(stub.calls.openPath).toEqual([])
  })
})
