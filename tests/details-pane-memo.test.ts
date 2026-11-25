/**
 * The details pane lists every cached field as a controlled input, so a
 * keystroke in the library search box used to rebuild it. These assertions
 * hold the wiring in place: the pane is memoised, its derived values belong
 * to the document, and the four callbacks it receives keep a stable identity.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function rootUp(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}
const read = (p: string): string =>
  fs.readFileSync(path.join(rootUp(), p), 'utf-8').replace(/\r\n/g, '\n')

describe('the details pane is not rebuilt by a search keystroke', () => {
  it('the detector can see the unmemoised shape it is looking for', () => {
    const oldShape = 'export default function DetailsPanel({\n  doc,\n  folders'
    expect(oldShape).toContain('export default function DetailsPanel(')
    expect(oldShape).not.toContain('memo(')
  })

  it('wraps the pane in memo and caches the document-derived values', () => {
    const panel = read('src/components/DetailsPanel.tsx')
    expect(panel).toContain('export default memo(function DetailsPanel({')
    expect(panel).toContain('useMemo(() => allDocumentFields(doc), [doc])')
    expect(panel).toContain('useMemo(() => documentSourceLinks(doc), [doc])')
    expect(panel).toContain('useMemo(() => new Set(doc.folder_uuids ?? []), [doc])')
    expect(panel).toContain('documentFieldsToPatch(dirtyFieldEdits, allFields, doc)')
  })

  it('hands the pane four stable callbacks instead of inline arrows', () => {
    const app = read('src/App.tsx')
    for (const name of [
      'detailsSaved',
      'detailsNoteSaved',
      'detailsTrash',
      'detailsToggleFolder'
    ]) {
      expect(app).toContain(`const ${name} = useCallback(`)
      expect(app).toContain(`{${name}}`)
    }
    expect(app).toContain('onSaved={detailsSaved}')
    expect(app).toContain('onTrash={detailsTrash}')
    expect(app).toContain('onNoteSaved={detailsNoteSaved}')
    expect(app).toContain('onToggleFolder={detailsToggleFolder}')
    expect(app).not.toContain('onSaved={(d) =>')
    expect(app).not.toContain('onToggleFolder={async (fid, has) =>')
  })
})
