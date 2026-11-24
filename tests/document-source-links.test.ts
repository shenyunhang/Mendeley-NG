import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { documentSourceLinks } from '../src/lib/documentSourceLinks'
import type { Doc } from '../shared/types'
import { isSafeExternalUrl as viaPathPolicy } from '../shared/pathPolicy'
import { isSafeExternalUrl as viaExternalUrl } from '../shared/externalUrl'

const paper = (patch: Partial<Doc>): Doc => ({ id: 'paper-1', ...patch })

function repoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

const ROOT = repoRoot()
/** Source-string guards must survive a CRLF checkout on windows-latest. */
const read = (p: string): string =>
  fs.readFileSync(path.join(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')

describe('a paper shows every source field as its own link', () => {
  it('draws url, websites and both identifiers, one link each', () => {
    const links = documentSourceLinks(
      paper({
        url: 'https://example.org/paper',
        websites: ['https://arxiv.org/pdf/2511.20347'],
        identifiers: { doi: '10.1000/abc', arxiv: '2511.20347' }
      })
    )
    expect(links.map((l) => l.url)).toEqual([
      'https://example.org/paper',
      'https://arxiv.org/pdf/2511.20347',
      'https://doi.org/10.1000/abc',
      'https://arxiv.org/abs/2511.20347'
    ])
    expect(links.map((l) => l.label)).toEqual([
      'url',
      'websites[0]',
      'identifiers.doi',
      'identifiers.arxiv'
    ])
  })

  it('shows all the other fields when the editable url is empty', () => {
    const links = documentSourceLinks(
      paper({
        websites: ['https://arxiv.org/pdf/2511.20347'],
        identifiers: { arxiv: '2511.20347' }
      })
    )
    expect(links).toEqual([
      { url: 'https://arxiv.org/pdf/2511.20347', label: 'websites[0]', origin: 'websites' },
      { url: 'https://arxiv.org/abs/2511.20347', label: 'identifiers.arxiv', origin: 'arxiv' }
    ])
  })

  it('shows identifiers and the legacy top-level fields as separate links', () => {
    expect(
      documentSourceLinks(
        paper({
          doi: '10.1000/legacy',
          arxiv: '2001.00001',
          identifiers: { doi: '10.1000/new', arxiv: '2511.20347' }
        })
      )
    ).toEqual([
      { url: 'https://doi.org/10.1000/new', label: 'identifiers.doi', origin: 'doi' },
      { url: 'https://doi.org/10.1000/legacy', label: 'doi', origin: 'doi' },
      { url: 'https://arxiv.org/abs/2511.20347', label: 'identifiers.arxiv', origin: 'arxiv' },
      { url: 'https://arxiv.org/abs/2001.00001', label: 'arxiv', origin: 'arxiv' }
    ])
    expect(
      documentSourceLinks(paper({ doi: '10.1000/legacy', arxiv: '2001.00001' })).map((l) => l.label)
    ).toEqual(['doi', 'arxiv'])
  })

  it('shows every websites entry rather than only the first', () => {
    const links = documentSourceLinks(
      paper({
        websites: [
          'https://arxiv.org/pdf/2511.20347',
          'https://example.org/publisher',
          'https://qwen.ai/blog?id=sapo'
        ]
      })
    )
    expect(links.map((l) => l.label)).toEqual(['websites[0]', 'websites[1]', 'websites[2]'])
    expect(links.map((l) => l.url)).toEqual([
      'https://arxiv.org/pdf/2511.20347',
      'https://example.org/publisher',
      'https://qwen.ai/blog?id=sapo'
    ])
  })

  it('keeps a repeated address instead of collapsing it into one link', () => {
    expect(
      documentSourceLinks(
        paper({ websites: ['https://arxiv.org/abs/2511.20347'], identifiers: { arxiv: '2511.20347' } })
      )
    ).toEqual([
      { url: 'https://arxiv.org/abs/2511.20347', label: 'websites[0]', origin: 'websites' },
      { url: 'https://arxiv.org/abs/2511.20347', label: 'identifiers.arxiv', origin: 'arxiv' }
    ])
  })

  it('normalises resolver URLs, doi prefixes and arXiv prefixes instead of doubling them', () => {
    const cases: [Partial<Doc>, string][] = [
      [{ doi: 'https://doi.org/10.1000/a' }, 'https://doi.org/10.1000/a'],
      [{ doi: 'http://dx.doi.org/10.1000/b' }, 'https://doi.org/10.1000/b'],
      [{ doi: 'doi: 10.1000/c' }, 'https://doi.org/10.1000/c'],
      [{ arxiv: 'arXiv:2501.12948' }, 'https://arxiv.org/abs/2501.12948'],
      [{ arxiv: 'https://arxiv.org/abs/2501.12948v2' }, 'https://arxiv.org/abs/2501.12948v2'],
      [{ arxiv: 'https://arxiv.org/pdf/2501.12948' }, 'https://arxiv.org/abs/2501.12948']
    ]
    for (const [patch, url] of cases) {
      expect(documentSourceLinks(paper(patch)).map((l) => l.url)).toEqual([url])
    }
  })

  it('refuses non-web schemes, blank strings and non-string websites entries', () => {
    // The cache holds whatever Mendeley sent, so a hand-edited or stale
    // `websites` array can contain things that are not strings.
    const dirty = ['file:///tmp/secret.pdf', '', 'ftp://example.org/file', 42, null, 'https://example.org/ok']
    const links = documentSourceLinks(
      paper({ url: 'javascript:alert(1)', websites: dirty as unknown as string[] })
    )
    expect(links.map((l) => l.url)).toEqual(['https://example.org/ok'])
  })

  it('answers with nothing when the catalogue knows no source', () => {
    expect(documentSourceLinks(paper({ title: 'No source' }))).toEqual([])
  })

  it('shares the one external URL rule with the main process', () => {
    expect(viaPathPolicy).toBe(viaExternalUrl)
    expect(viaExternalUrl('https://example.org')).toBe(true)
    expect(viaExternalUrl('smb://example.org/share')).toBe(false)
  })
})

describe('the details pane draws the derived links', () => {
  const panel = () => read('src/components/DetailsPanel.tsx')
  const rule = () => read('src/lib/documentSourceLinks.ts')

  it('uses the pure rule and keeps the editable link field', () => {
    expect(panel()).toContain('documentSourceLinks(doc)')
    expect(panel()).toContain('<label>链接</label>')
    expect(panel()).toContain('className="source-links"')
    expect(panel()).toContain('title={link.url}')
    expect(panel()).toContain('void window.api.openExternal(link.url)')
  })

  it('gives every link a key of its own, since two can share one address', () => {
    expect(panel()).toContain('sourceLinks.map((link, index) =>')
    expect(panel()).toContain('key={`${link.origin}-${index}`}')
  })

  const descriptiveLabel = '来源 ${i + 1}'
  it('the detector really catches an old descriptive label', () => {
    expect('add(site, `来源 ${i + 1}`)').toContain(descriptiveLabel)
  })
  it('labels are the field names themselves', () => {
    expect(rule()).not.toContain(descriptiveLabel)
    expect(rule()).toContain("add(doc.url, 'url', 'url')")
    expect(rule()).toContain('websites[${i}]')
    expect(rule()).toContain("'identifiers.doi'")
    expect(rule()).toContain("'identifiers.arxiv'")
  })

  const dedupeSet = 'const seen = new Set<string>()'
  it('the detector really catches a de-duplication set', () => {
    expect('function f() { ' + dedupeSet + ' }').toContain(dedupeSet)
  })
  it('the rule has no de-duplication step', () => {
    expect(rule()).not.toContain(dedupeSet)
    expect(rule()).toContain('out.push({ url, label, origin })')
  })

  const eitherOr = 'doc.identifiers?.doi ?? doc.doi'
  it('the detector really catches an either-or identifier lookup', () => {
    expect('const doi = ' + eitherOr).toContain(eitherOr)
  })
  it('identifiers and top-level fields are not collapsed into one lookup', () => {
    expect(rule()).not.toContain(eitherOr)
    expect(rule()).toContain('const identifierDoi = doc.identifiers?.doi')
    expect(rule()).toContain('if (identifierDoi)')
    expect(rule()).toContain('if (doc.doi)')
  })

  const legacyDoiLink = "href={'https://doi.org/' + doc.doi}"
  it('the detector really catches the old doi-only link', () => {
    expect('const old = ' + legacyDoiLink).toContain(legacyDoiLink)
  })
  it('the old hand-built doi link at the bottom is gone', () => {
    expect(panel()).not.toContain(legacyDoiLink)
  })

  it('pathPolicy re-exports the rule instead of keeping a second copy', () => {
    expect(read('shared/pathPolicy.ts')).toContain("export { isSafeExternalUrl } from './externalUrl'")
  })

  it('the pure rule is listed in the node project whitelist', () => {
    expect(read('tsconfig.node.json')).toContain('src/lib/documentSourceLinks.ts')
  })
})
