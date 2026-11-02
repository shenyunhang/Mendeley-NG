import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import { setWin } from './window'
/**
 * `--demo` runs the app against the invented library `scripts/demo.mjs` wrote
 * and captures the screenshots the README shows.
 *
 * It exists because the alternative is to photograph somebody's real reading
 * list and publish it.  The data is synthetic, the user-data directory is the
 * one the script owns, and syncing is refused, so a run cannot reach the
 * network or touch the real library.
 */
export async function runDemo() {
  const log = (...a: unknown[]) => console.log('[demo]', ...a)
  const outDir = process.env.MENDELEY_DEMO_OUT || path.join(app.getPath('temp'), 'mendeley-ng-demo')
  fs.mkdirSync(outDir, { recursive: true })

  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  setWin(w)
  await w.loadFile(path.join(__dirname, '../renderer/index.html'))
  await new Promise((r) => setTimeout(r, 2500))

  const shot = async (name: string) => {
    await new Promise((r) => setTimeout(r, 400))
    // The capture comes back at the display's scale factor — 1.5 on the
    // machine these were first taken on — which is twice the pixels a README
    // will ever show.  Back to CSS pixels, so the repo carries what is needed.
    const img = (await w.webContents.capturePage()).resize({ width: 1440 })
    const p = path.join(outDir, name + '.png')
    fs.writeFileSync(p, img.toPNG())
    log('wrote', p, img.getSize().width + 'x' + img.getSize().height,
      (fs.statSync(p).size / 1024).toFixed(0) + ' KB')
  }

  const run = (js: string) => w.webContents.executeJavaScript(js)
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const clickButton = (where: string, re: string) =>
    run(
      `(()=>{const b=[...document.querySelectorAll("${where}")]`
      + `.find(x=>${re}.test(x.textContent||""));if(!b)return 0;b.click();return 1})()`
    )

  // The first paper, by name rather than by position: the order of the list
  // is not part of what this is photographing, and the seeded highlights and
  // the note are on that one paper.
  const pick = async (title: string) => {
    const r = await run(
      '(()=>{const rows=[...document.querySelectorAll("div.row")];'
      + 'const r=rows.find(x=>(' + JSON.stringify(title) + ').length'
      + '&&(x.textContent||"").includes(' + JSON.stringify(title) + '));'
      + 'if(!r)return JSON.stringify({rows:rows.length,found:0});'
      + 'r.click();return JSON.stringify({rows:rows.length,found:1})})()'
    )
    log('picked', title, r)
    return r
  }

  // A paper with no file on disk, so the right pane opens on the metadata
  // rather than on the reader: that is the half of the app the list hides.
  await pick('A Small Study of Very Large Tables')
  await wait(600)
  await shot('01-library-dark')

  // The first paper, by name rather than by position: the order of the list
  // is not part of what is being photographed, and the two seeded highlights
  // are on that one paper.
  await pick('Retrieval That Admits')
  await wait(2500)
  await shot('02-reader-dark')

  // Full-text search over the generated PDFs.  Building the index is the
  // app's job, not the script's, so it is driven through the same button the
  // reader would press.
  await clickButton('.toolbar button', '/^全文$/')
  await wait(600)
  await clickButton('button', '/^建索引/')
  for (let i = 0; i < 60; i++) {
    await wait(1000)
    const m = await run(
      '(()=>{const t=document.body.textContent||"";'
      + 'const m=t.match(/已索引\\s*(\\d+)\\s*\\/\\s*(\\d+)/);'
      + 'return m?(m[1]===m[2]&&m[2]!=="0"?"yes":"no"):"none"})()'
    )
    if (m === 'yes') break
  }
  await run(
    '(()=>{const i=document.querySelector(\'input[placeholder^="搜索"]\');if(!i)return 0;'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"retrieval");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()'
  )
  await wait(1200)
  await shot('03-fulltext-dark')

  // The light palette, back on the library: the theme is switched through the
  // DOM rather than the button, because a screenshot run has no business
  // rewriting the config it was given.
  await clickButton('button', '/^返回列表$/')
  await wait(600)
  await run('(()=>{document.documentElement.dataset.theme="light";return 1})()')
  await shot('04-library-light')

  log('done')
  app.quit()
}
