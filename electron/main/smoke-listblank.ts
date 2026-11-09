import { isListBlank } from '../../src/lib/listBlank'
import fs from 'node:fs'
import path from 'node:path'

import type { SmokeCtx } from './smoke-ctx'

export function listBlankRules(ctx: SmokeCtx) {
    const row = { closest: (s: string) => (s === '.row' ? {} : null) }
    const card = { closest: (s: string) => (s === '.res-row' ? {} : null) }
    const plain = { closest: () => null }
    ctx.expect(
      'a click outside every row is blank in both lists',
      isListBlank(plain, 'row') &&
        isListBlank(plain, 'res-row') &&
        isListBlank(null, 'row') &&
        isListBlank(undefined, 'row'),
      { plain: isListBlank(plain, 'row') }
    )
    ctx.expect(
      'a click on a row or a card is not blank in its own list',
      !isListBlank(row, 'row') &&
        !isListBlank(card, 'res-row') &&
        isListBlank(row, 'res-row') &&
        isListBlank(card, 'row'),
      { rowInTable: isListBlank(row, 'row'), cardInCards: isListBlank(card, 'res-row') }
    )
    ctx.expect(
      'a target without closest is blank, not a row',
      isListBlank({}, 'row') && isListBlank({ closest: 1 }, 'row'),
      {}
    )

    const blankRoot = path.join(__dirname, '../..')
    const tableSrc = fs.readFileSync(
      path.join(blankRoot, 'src/components/DocTable.tsx'),
      'utf8'
    )
    const cardsSrc = fs.readFileSync(
      path.join(blankRoot, 'src/components/SearchResults.tsx'),
      'utf8'
    )
    const appSrc = fs.readFileSync(path.join(blankRoot, 'src/App.tsx'), 'utf8')
    const blankCalls = (t: string) => (t.match(/isListBlank\(/g) ?? []).length
    const oldWrap = '<div className="table-wrap" ref={parentRef}>'
    const wiredWrap = "if (isListBlank(e.target, 'row')) onClearSelection()"
    ctx.expect(
      'the wiring detector can really see a blank-click guard',
      blankCalls(oldWrap) === 0 && blankCalls(wiredWrap) === 1,
      { old: blankCalls(oldWrap), wired: blankCalls(wiredWrap) }
    )
    ctx.expect(
      'both lists share the rule and the app owns the clearing',
      blankCalls(tableSrc) === 1 &&
        blankCalls(cardsSrc) === 1 &&
        (appSrc.match(/onClearSelection=\{clearSelection\}/g) ?? []).length === 2 &&
        /if \(!selId && !pinned && multi\.length === 0\) return/.test(appSrc) &&
        appSrc.includes('lastIdx.current = null'),
      {
        inTable: blankCalls(tableSrc),
        inCards: blankCalls(cardsSrc),
        wired: (appSrc.match(/onClearSelection=\{clearSelection\}/g) ?? []).length
      }
    )
}
