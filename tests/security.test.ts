import { describe, expect, it } from 'vitest'
import {
  canServePdf,
  isPathWithin,
  isSafeExternalUrl,
  resolveInside,
  safeConfigPatch
} from '../shared/pathPolicy'

describe('isPathWithin', () => {
  it('accepts the root itself', () => {
    expect(isPathWithin('C:\\Library\\pdf', 'C:\\Library\\pdf', 'win32')).toBe(true)
  })

  it('accepts a file below the root', () => {
    expect(isPathWithin('C:\\Library\\pdf', 'C:\\Library\\pdf\\a.pdf', 'win32')).toBe(true)
  })

  it('accepts a nested directory below the root', () => {
    expect(isPathWithin('/home/me/pdfs', '/home/me/pdfs/2024/nested/a.pdf', 'posix')).toBe(true)
  })

  it('ignores case on Windows', () => {
    expect(isPathWithin('C:\\Library\\PDF', 'c:\\library\\pdf\\A.PDF', 'win32')).toBe(true)
  })

  it('keeps case significant on posix', () => {
    expect(isPathWithin('/home/me/pdfs', '/home/me/PDFS/a.pdf', 'posix')).toBe(false)
  })

  it('resolves dot segments before comparing', () => {
    expect(isPathWithin('C:\\Library\\pdf', 'C:\\Library\\pdf\\sub\\..\\a.pdf', 'win32')).toBe(true)
  })

  it('rejects a sibling whose name only starts with the root', () => {
    expect(isPathWithin('C:\\Library\\pdf', 'C:\\Library\\pdf-evil\\a.pdf', 'win32')).toBe(false)
  })

  it('rejects a parent traversal out of the root', () => {
    expect(isPathWithin('C:\\Library\\pdf', 'C:\\Library\\pdf\\..\\token.json', 'win32')).toBe(false)
  })

  it('rejects relative roots and candidates', () => {
    expect(isPathWithin('pdf', 'pdf/a.pdf', 'win32')).toBe(false)
    expect(isPathWithin('/home/me/pdfs', 'a.pdf', 'posix')).toBe(false)
  })

  it('rejects empty and non-string inputs', () => {
    expect(isPathWithin('', '/a', 'posix')).toBe(false)
    expect(isPathWithin('/a', '', 'posix')).toBe(false)
    expect(isPathWithin(3 as unknown as string, '/a', 'posix')).toBe(false)
  })
})

describe('resolveInside', () => {
  it('resolves an ordinary relative name inside the root', () => {
    expect(resolveInside('C:\\Export', 'pdf\\a.pdf', 'win32')).toBe('C:\\Export\\pdf\\a.pdf')
  })

  it('accepts a plain filename', () => {
    expect(resolveInside('/tmp/export', 'README.txt', 'posix')).toBe('/tmp/export/README.txt')
  })

  it('rejects a parent traversal', () => {
    expect(resolveInside('/tmp/export', '../token.json', 'posix')).toBeNull()
  })

  it('rejects a traversal hidden after a legitimate directory', () => {
    expect(resolveInside('/tmp/export', 'pdf/../../token.json', 'posix')).toBeNull()
  })

  it('rejects an absolute posix path', () => {
    expect(resolveInside('/tmp/export', '/etc/passwd', 'posix')).toBeNull()
  })

  it('rejects an absolute Windows path', () => {
    expect(resolveInside('C:\\Export', 'D:\\other\\a.pdf', 'win32')).toBeNull()
  })

  it('rejects a drive-relative Windows name', () => {
    expect(resolveInside('C:\\Export', 'C:secret.txt', 'win32')).toBeNull()
  })

  it('rejects a UNC path', () => {
    expect(resolveInside('C:\\Export', '\\\\server\\share\\a.pdf', 'win32')).toBeNull()
  })

  it('rejects NUL bytes, empty names and non-strings', () => {
    expect(resolveInside('/tmp/export', 'a\0.pdf', 'posix')).toBeNull()
    expect(resolveInside('/tmp/export', '', 'posix')).toBeNull()
    expect(resolveInside('/tmp/export', null as unknown as string, 'posix')).toBeNull()
  })
})

describe('isSafeExternalUrl', () => {
  it('allows https', () => {
    expect(isSafeExternalUrl('https://example.com/page?q=1')).toBe(true)
  })

  it('allows http', () => {
    expect(isSafeExternalUrl('http://localhost:8080/')).toBe(true)
  })

  it.each(['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'smb://host/share', 'mailto:a@b.com', 'data:text/plain,hi', 'not a url', '', '   '])(
    'refuses %s',
    (url) => {
      expect(isSafeExternalUrl(url)).toBe(false)
    }
  )

  it('refuses non-strings', () => {
    expect(isSafeExternalUrl(undefined)).toBe(false)
    expect(isSafeExternalUrl(42)).toBe(false)
    expect(isSafeExternalUrl({ href: 'https://example.com' })).toBe(false)
  })
})

describe('canServePdf', () => {
  const roots = ['C:\\Library\\Downloaded']

  it('serves a PDF in the configured root', () => {
    expect(canServePdf({ candidate: 'C:\\Library\\Downloaded\\a.pdf', roots }, 'win32')).toBe(true)
  })

  it('serves a PDF in a subdirectory of the root', () => {
    expect(canServePdf({ candidate: 'C:\\Library\\Downloaded\\2024\\a.pdf', roots }, 'win32')).toBe(true)
  })

  it('serves a registered attachment outside the root', () => {
    expect(
      canServePdf(
        { candidate: 'D:\\Papers\\moved.pdf', roots, knownFiles: ['D:\\Papers\\moved.pdf'] },
        'win32'
      )
    ).toBe(true)
  })

  it('refuses an unregistered file outside the root', () => {
    expect(canServePdf({ candidate: 'C:\\Users\\me\\AppData\\token.json', roots }, 'win32')).toBe(false)
  })

  it('refuses a traversal that leaves the root', () => {
    expect(canServePdf({ candidate: 'C:\\Library\\Downloaded\\..\\token.json', roots }, 'win32')).toBe(false)
  })

  it('refuses a different file in the same directory as a registered one', () => {
    expect(
      canServePdf(
        { candidate: 'D:\\Papers\\secret.pdf', roots, knownFiles: ['D:\\Papers\\moved.pdf'] },
        'win32'
      )
    ).toBe(false)
  })

  it('refuses relative paths and NUL bytes', () => {
    expect(canServePdf({ candidate: 'a.pdf', roots }, 'win32')).toBe(false)
    expect(canServePdf({ candidate: 'C:\\Library\\Downloaded\\a\0.pdf', roots }, 'win32')).toBe(false)
  })

  it('ignores empty or missing roots and known files', () => {
    expect(canServePdf({ candidate: 'C:\\elsewhere\\a.pdf', roots: [undefined, ''] }, 'win32')).toBe(false)
    expect(canServePdf({ candidate: 'C:\\elsewhere\\a.pdf', roots: [] })).toBe(false)
  })
})

describe('safeConfigPatch', () => {
  it('keeps every declared key with a valid value', () => {
    const patch = safeConfigPatch({
      pdfDir: 'C:\\pdfs',
      fontSize: 17,
      theme: 'light',
      cols: ['title'],
      colWidths: { title: 300 },
      sort: { key: 'year', dir: -1 },
      views: [],
      dupeIgnores: [['a', 'b']],
      syncOnStart: false,
      window: { x: 0, y: 0, width: 800, height: 600 }
    })
    expect(Object.keys(patch).sort()).toEqual(
      [
        'cols', 'colWidths', 'dupeIgnores', 'fontSize', 'pdfDir', 'sort',
        'syncOnStart', 'theme', 'views', 'window'
      ].sort()
    )
  })

  it('drops keys that are not in the config shape', () => {
    expect(safeConfigPatch({ injected: 'yes', fontSize: 16 })).toEqual({ fontSize: 16 })
  })

  it('drops prototype-mutating keys even if a value is supplied', () => {
    const patch = safeConfigPatch({ __proto__: { pollute: true }, constructor: 1, prototype: 2 } as unknown)
    expect(patch).toEqual({})
    expect(({} as Record<string, unknown>).pollute).toBeUndefined()
  })

  it('drops a numeric field with a non-number or non-finite value', () => {
    expect(safeConfigPatch({ ftPages: '3' })).toEqual({})
    expect(safeConfigPatch({ fontSize: NaN })).toEqual({})
    expect(safeConfigPatch({ paneLeft: Infinity })).toEqual({})
  })

  it('drops a text field with a non-string value', () => {
    expect(safeConfigPatch({ pdfDir: 123 })).toEqual({})
    expect(safeConfigPatch({ exportDir: null })).toEqual({})
  })

  it('drops a theme that is not one of the two palettes', () => {
    expect(safeConfigPatch({ theme: 'solarized' })).toEqual({})
    expect(safeConfigPatch({ theme: 'dark' })).toEqual({ theme: 'dark' })
  })

  it('drops a flag that is not a boolean', () => {
    expect(safeConfigPatch({ syncOnStart: 'false' })).toEqual({})
  })

  it('drops arrays and objects given the wrong shape', () => {
    expect(safeConfigPatch({ cols: { title: true } })).toEqual({})
    expect(safeConfigPatch({ colWidths: [] })).toEqual({})
    expect(safeConfigPatch({ sort: null })).toEqual({})
  })

  it('skips undefined instead of persisting it', () => {
    expect(safeConfigPatch({ paneLeft: undefined, fontSize: 15 })).toEqual({ fontSize: 15 })
  })

  it('refuses non-object inputs without throwing', () => {
    expect(safeConfigPatch(null)).toEqual({})
    expect(safeConfigPatch([])).toEqual({})
    expect(safeConfigPatch('fontSize')).toEqual({})
    expect(safeConfigPatch(undefined)).toEqual({})
  })

  it('never carries functions, symbols or bigints into the file', () => {
    expect(safeConfigPatch({ savedSearches: [1], citeStyle: () => 'x', window: 10n })).toEqual({
      savedSearches: [1]
    })
  })
})
