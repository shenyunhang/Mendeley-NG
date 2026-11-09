import { shortDate } from '../../shared/shortDate'
import fs from 'node:fs'
import path from 'node:path'

import type { SmokeCtx } from './smoke-ctx'

export function shortDateRules(ctx: SmokeCtx) {
    const oldShortDate = (s?: string) => (s ? s.slice(0, 10) : '')
    const samples = [
      undefined,
      null,
      '',
      '2022-04-23T09:56:01.818Z',
      '2026-11-07T04:57:38.829Z',
      '2022-04-23',
      'abc',
      'x'.repeat(40)
    ]
    const drift = samples.filter((s) => shortDate(s) !== oldShortDate(s ?? undefined))
    ctx.expect(
      'the shared day rule answers the old column rule for every input',
      drift.length === 0 && shortDate('2022-04-23T09:56:01.818Z') === '2022-04-23',
      { drift, samples: samples.length }
    )
    ctx.expect(
      'an absent or empty created stays empty',
      shortDate(undefined) === '' && shortDate(null) === '' && shortDate('') === '',
      {}
    )
    const dateRoot = path.join(__dirname, '../..')
    const colSrc = fs.readFileSync(path.join(dateRoot, 'src/lib/columns.ts'), 'utf8')
    const panelSrc = fs.readFileSync(
      path.join(dateRoot, 'src/components/DetailsPanel.tsx'),
      'utf8'
    )
    const sharedSrc = fs.readFileSync(path.join(dateRoot, 'shared/shortDate.ts'), 'utf8')
    ctx.expect(
      'both callers import the same day rule instead of keeping a copy',
      /from '[^']*shared\/shortDate'/.test(colSrc) &&
        /from '[^']*shared\/shortDate'/.test(panelSrc) &&
        !colSrc.includes('const shortDate =') &&
        sharedSrc.includes('export function shortDate('),
      { shared: sharedSrc.length > 0 }
    )
    ctx.expect(
      'the details pane shows it read-only with the exact moment on hover',
      /<label>加入时间<\/label>/.test(panelSrc) &&
        /shortDate\(doc\.created\) \|\| '未知'/.test(panelSrc) &&
        /readOnly/.test(panelSrc) &&
        /title=\{doc\.created \?\? ''\}/.test(panelSrc),
      { panel: panelSrc.length > 0 }
    )
}
