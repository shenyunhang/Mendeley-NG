import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { findToken } from './mendeley'
import {
  dataDir,
  loadAnnotations,
  loadConfig,
  loadLibrary,
  loadNotes,
  saveAnnotations,
  saveConfig
} from './store'
import type { Doc } from '../../shared/types'
import { sync } from './library'
import {
  ftAdd,
  ftBuild,
  ftCancel,
  ftClear,
  ftPending,
  ftSearch,
  ftStatus,
  ftVoid
} from './fulltext'
import {
  ftDocs,
  indexAdded
} from './ftops'
import {
  bringUp,
  wantsSingleInstance
} from './instance'
import {
  attachWindowMemory,
  rememberBounds,
  savedBounds,
  setWin
} from './window'
/**
 * `--smoke` runs the whole stack headlessly and writes a screenshot, which is
 * the only way to confirm both the sync pipeline and the high-DPI rendering
 * from a command line.  It is a development aid, never used by the packaged app.
 */
export async function runSmoke() {
  const log = (...a: unknown[]) => console.log('[smoke]', ...a)
  const disp = screen.getPrimaryDisplay()
  log('display', disp.size.width + 'x' + disp.size.height, 'scaleFactor', disp.scaleFactor)

  log('token', !!findToken())
  try {
    if (process.argv.includes('--no-sync')) {
      const cached = loadLibrary()
      log('skip sync, cache', cached ? cached.docs.length + ' docs' : 'empty')
    } else if (process.argv.includes('--incr')) {
      const cached = loadLibrary()
      log('incremental from', cached?.syncedAt ?? '(no watermark)')
      const t0 = Date.now()
      const { docs, folders } = await sync(false)
      log(
        'incremental ok',
        docs.length,
        'docs',
        folders.length,
        'folders',
        Date.now() - t0,
        'ms'
      )
    } else {
    const t0 = Date.now()
    const { docs, folders } = await sync(true)
    log('sync ok', docs.length, 'docs', folders.length, 'folders', Date.now() - t0, 'ms')
    const withPdf = docs.filter((d) => d.localPdf).length
    log('pdf matched', withPdf + '/' + docs.length)
    const s = docs.find((d) => d.citation_key)
    log('sample', JSON.stringify({
      title: s?.title?.slice(0, 60), year: s?.year, key: s?.citation_key,
      folders: s?.folder_uuids?.length, pdf: !!s?.localPdf
    }))
    }
  } catch (e) {
    log('sync FAILED', String(e))
  }

  const w = new BrowserWindow({ width: 1500, height: 950, show: false, backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
  const errs: string[] = []
  // a smoke run that only prints is a smoke run nobody reads; anything that
  // has a right answer goes through here so the exit code says so
  const fails: string[] = []
  const expect = (name: string, ok: boolean, detail: unknown) => {
    log(ok ? 'PASS' : 'FAIL', name, detail)
    if (!ok) fails.push(`${name}: ${String(detail)}`)
  }
  // Commands that are not needed every time live under a menu on the bar now,
  // so reaching one is two clicks.  The menu closes when the pointer leaves,
  // which a dispatched click never does, so nothing here has to close it.
  const openMenu = (label: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll(".toolbar button")]`
      + `.find(x=>x.textContent.trim().startsWith(${JSON.stringify(label)}));`
      + `if(!b)return 0;b.click();return 1})()`
    )
  const clickMenu = (item: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll(".menu-pop .menu-item")]`
      + `.find(x=>x.textContent.trim()===${JSON.stringify(item)});`
      + `if(!b||b.disabled)return 0;b.click();return 1})()`
    )
  w.webContents.on('console-message', (_e, _l, msg) => { if (/error|Error/.test(msg)) errs.push(msg) })
  w.webContents.on('did-fail-load', (_e, code, desc) => errs.push('did-fail-load ' + code + ' ' + desc))
  setWin(w)
  await w.loadFile(path.join(__dirname, '../renderer/index.html'))
  await new Promise((r) => setTimeout(r, 2500))
  // The icon is what makes this a program rather than a window.  It is
  // checked here because a missing file fails silently: electron-builder
  // falls back to the Electron default and the installer still builds.
  const iconOk = (() => {
    const ico = path.join(app.getAppPath(), 'build', 'icon.ico')
    const png = path.join(app.getAppPath(), 'assets', 'icon.png')
    if (!fs.existsSync(ico) || !fs.existsSync(png)) return { ico: false, png: false }
    const b = fs.readFileSync(ico)
    // an ICO starts with a 6 byte directory: reserved, type 1, then a count
    return {
      ico: b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1 && b.readUInt16LE(4) >= 7,
      png: fs.statSync(png).size > 1000
    }
  })()
  log('icon', iconOk)
  expect('the app ships an icon', iconOk.ico && iconOk.png, iconOk)
  const info = await w.webContents.executeJavaScript(
    // typeof, not a call: a real prompt would block the run
    'JSON.stringify({dpr: devicePixelRatio, rows: document.querySelectorAll("table,.row,[data-row]").length,'
    + 'prompt: typeof window.prompt, confirm: typeof window.confirm, body: document.body.innerText.slice(0,300)})'
  )
  log('renderer', info)
  if (errs.length) log('renderer errors', errs.slice(0, 10).join(' | '))

  // A library refreshed only when somebody remembers to press 同步 is stale by
  // exactly the work done on the other machine, so the app pulls once by
  // itself on start-up.  The pull the main process does at boot happens before
  // the window exists and so reaches nobody, which means the only status line
  // the renderer can be showing here is the start-up one — and it is the one
  // place where silence is the design: an error banner on every launch that
  // happened to be offline is worse than a list a few hours behind.
  const startSync = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>{const wait=(m)=>new Promise(r=>setTimeout(r,m));'
      + 'let msg=null;'
      + 'for(let i=0;i<60;i++){'
      + 'const s=document.querySelector(".toolbar .status");'
      + 'if(s&&/^(增量同步|同步完成)/.test(s.textContent||"")){msg=s.textContent;break}'
      + 'await wait(500)}'
      + 'return JSON.stringify({msg:msg,err:!!document.querySelector(".err"),'
      + 'token:await window.api.hasToken(),'
      + 'cfg:(await window.api.getConfig()).syncOnStart})})()'
    )
  )
  log('start-up sync', startSync)
  expect(
    'the app pulls the library once by itself on start-up',
    typeof startSync.msg === 'string' && /^(增量同步|同步完成)/.test(startSync.msg),
    startSync
  )
  expect('and shows no banner while doing it', startSync.err === false, startSync)
  expect('and it is on unless switched off', startSync.cfg !== false, startSync)

  // The bar is one row and every label on it is on one line.  A button
  // squeezed narrow enough wraps its own text — "检查" over "更新" — which
  // is harder to read at a glance than a wide button, and it is what made the
  // bar look broken.  Both halves are measured rather than eyeballed: how many
  // rows the buttons sit on, and how many line boxes each label occupies.
  const barInfo = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const bar=document.querySelector(".toolbar");'
      + 'const bs=[...bar.querySelectorAll("button")].filter(b=>b.offsetParent!==null);'
      // compared by centre, not top: the bar centres its children, so buttons
      // of different heights sit at different tops on the same row
      + 'const rows=new Set(bs.map(b=>{const r=b.getBoundingClientRect();'
      + 'return Math.round(r.top+r.height/2)}));'
      + 'const two=[];'
      + 'for(const b of bs){const r=document.createRange();r.selectNodeContents(b);'
      // a label is two text nodes once it carries an arrow, and each node is
      // its own rectangle on the same line: what counts is how many lines
      + 'const lines=new Set([...r.getClientRects()].map(x=>Math.round(x.top)));'
      + 'if(lines.size>1)two.push(b.textContent.trim())}'
      + 'const wide=[...bar.children].map(c=>({t:(c.textContent||"").trim().slice(0,10),'
      + 'w:Math.round(c.getBoundingClientRect().width)}));'
      + 'return JSON.stringify({n:bs.length,rows:rows.size,two,wide,'
      + 'overflow:bar.scrollWidth-bar.clientWidth})})()'
    )
  )
  log('toolbar', barInfo)
  expect('the bar is one row of buttons', barInfo.rows === 1, barInfo)
  expect('no button wraps its own label', barInfo.two.length === 0, barInfo.two)
  // fitting matters as much as not wrapping: a bar that has to be scrolled to
  // reach the font size or the theme hides the two things at its far end
  expect('the bar fits without being scrolled', barInfo.overflow <= 0, barInfo.overflow)

  // A card has to open where it can be read.  The bar is one row because it
  // is allowed to scroll sideways, and a box that scrolls on one axis clips
  // on the other — `overflow-x: auto` turns `overflow-y` into `auto` too — so
  // a card placed under its button was cut off at the bar's bottom edge: the
  // menu opened and there was nothing there.  Nothing about the card said so,
  // which is why it took a reader to notice.
  //
  // What is checked is not the geometry but whether the card is the topmost
  // thing at its own middle, which is what "on top" means to a pointer.  A
  // clipped card still reports a rectangle; it just is not there.
  const popInfo = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>{const sleep=(m)=>new Promise(r=>setTimeout(r,m));'
      + 'const press=(t)=>{const b=[...document.querySelectorAll(".toolbar button")]'
      + '.find(x=>x.textContent.trim().startsWith(t));if(b){b.click();return 1}return 0};'
      + 'const look=(sel)=>{const c=document.querySelector(sel);if(!c)return {open:0};'
      + 'const bar=document.querySelector(".toolbar").getBoundingClientRect();'
      + 'const r=c.getBoundingClientRect();'
      + 'const hit=document.elementFromPoint(Math.round(r.left+r.width/2),'
      + 'Math.round(r.top+r.height/2));'
      + 'return {open:1,onTop:!!hit&&(hit===c||c.contains(hit)),'
      + 'hit:hit?(hit.className||hit.tagName):null,below:Math.round(r.bottom-bar.bottom),'
      + 'inWindow:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth}};'
      + 'const out={pressed:[]};'
      + 'out.pressed.push(press("更多"));await sleep(200);out.more=look(".menu-pop");'
      + 'press("更多");await sleep(200);'
      + 'out.pressed.push(press("筛选"));await sleep(200);out.filter=look(".col-picker");'
      + 'press("筛选");await sleep(200);'
      + 'out.pressed.push(press("列"));await sleep(200);out.cols=look(".col-picker");'
      + 'press("列");await sleep(200);'
      + 'return JSON.stringify(out)})()'
    )
  )
  log('cards that open below the bar', popInfo)
  expect(
    'the more menu opens clear of the bar',
    popInfo.more?.open === 1 && popInfo.more?.onTop === true,
    popInfo.more
  )
  expect(
    'the filter card opens clear of the bar',
    popInfo.filter?.open === 1 && popInfo.filter?.onTop === true,
    popInfo.filter
  )
  expect(
    'the column card opens clear of the bar',
    popInfo.cols?.open === 1 && popInfo.cols?.onTop === true,
    popInfo.cols
  )
  expect(
    'and none of them is cut off by the window',
    popInfo.more?.inWindow === true &&
      popInfo.filter?.inWindow === true &&
      popInfo.cols?.inWindow === true,
    popInfo
  )
  // and what was removed to make room is still reachable
  await openMenu('更多')
  await new Promise((r) => setTimeout(r, 300))
  const moreItems = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify([...document.querySelectorAll(".menu-pop .menu-item")]'
      + '.map(x=>x.textContent.trim()))'
    )
  )
  log('under 更多', moreItems)
  expect(
    'the commands that left the bar are still there',
    ['导入 token', '查重', '全部标注', '回收站', '保存搜索'].every((x) =>
      moreItems.includes(x)
    ),
    moreItems
  )

  // The filters answer the four questions the table can already show but
  // could not isolate: what have I not read, what have I no file for, what is
  // on the cloud but not on this disk, what belongs to no folder.  Read-only,
  // so they can be exercised here without writing to the cloud, unlike the
  // star toggle itself.  What is checked is that each switch leaves exactly
  // the number of papers it said it would, that two together narrow further
  // rather than widening, and that clearing puts everything back.
  const shown = async () =>
    Number(
      JSON.parse(
        await w.webContents.executeJavaScript(
          '(()=>{const b=[...document.querySelectorAll(".badge")]'
          + '.map(e=>e.textContent||"").find(t=>/\\d+\\s*\\/\\s*\\d+/.test(t))||"";'
          + 'const m=b.match(/(\\d+)/);return m?m[1]:0})()'
        )
      )
    )
  const filterCard = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        '(()=>{const c=document.querySelector(".filter-menu");'
        + 'if(!c)return JSON.stringify({open:0});'
        + 'return JSON.stringify({open:1,rows:[...c.querySelectorAll(".col-row")].map(r=>'
        + '({label:(r.querySelector("label")||{}).textContent||"",'
        + 'n:+((r.querySelector("span:last-child")||{}).textContent||0),'
        + 'on:!!(r.querySelector("input")||{}).checked}))})})()'
      )
    )
  const tickFilter = (label: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const c=document.querySelector(".filter-menu");if(!c)return 0;`
      + `const r=[...c.querySelectorAll(".col-row")]`
      + `.find(x=>((x.querySelector("label")||{}).textContent||"").includes(${JSON.stringify(label)}));`
      + `if(!r)return 0;const i=r.querySelector("input");if(!i)return 0;i.click();return 1})()`
    )
  const allBefore = await shown()
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
    + '.find(x=>x.textContent.trim().startsWith("筛选"));if(!b)return "no filter button";'
    + 'b.click();return "ok"})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  const card = await filterCard()
  log('filter card', card)
  expect('the filter card opens', card.open === 1, card)
  expect('it offers every question', card.rows?.length === 5, card.rows?.length)
  expect(
    'each switch says how many papers it would leave',
    card.rows?.every((r: { n: number }) => Number.isFinite(r.n) && r.n >= 0),
    card.rows
  )
  // the switch with the most papers behind it that is still not everything:
  // an empty switch proves nothing, because a list narrowed to nothing looks
  // the same whether the filter worked or broke
  const usable = (card.rows ?? []).filter(
    (r: { n: number }) => r.n > 0 && r.n < allBefore
  ) as { label: string; n: number }[]
  usable.sort((a, b) => b.n - a.n)
  const pick = usable[0]
  log('switch under test', pick)
  expect('there is a switch that leaves some but not all', !!pick, { allBefore, usable })
  const second = usable[1] ?? pick
  await tickFilter(pick.label)
  await new Promise((r) => setTimeout(r, 500))
  const afterStar = await shown()
  log('after one switch', { pick, afterStar })
  expect('a switch leaves exactly what it said', afterStar === pick.n, { pick, afterStar })
  await tickFilter(second.label)
  await new Promise((r) => setTimeout(r, 500))
  const afterBoth = await shown()
  log('after two switches', { afterStar, afterBoth, second })
  // two together narrow further: a list of ticked boxes is an AND, and OR
  // would make the switches useless for working through a pile
  expect('two switches together narrow rather than widen', afterBoth <= afterStar, {
    afterStar,
    afterBoth
  })
  expect('and no further than either alone', afterBoth <= second.n, { afterBoth, second })
  await w.webContents.executeJavaScript(
    '(()=>{const c=document.querySelector(".filter-menu");'
    + 'const b=[...c.querySelectorAll("button")].find(x=>x.textContent.trim()==="全部清除");'
    + 'if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 500))
  expect('clearing puts every paper back', (await shown()) === allBefore, allBefore)
  // the card closes on Esc like every other floating thing
  await w.webContents.executeJavaScript(
    'window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))'
  )
  await new Promise((r) => setTimeout(r, 300))
  expect('Esc closes the filter card', (await filterCard()).open === 0, 'still open')

  // Typing has to stay cheap, and it did not.  The sort called its key
  // function from inside the comparator, so a library of five thousand paid
  // for roughly twelve passes over itself per keystroke; the counts beside
  // the filter switches each built and discarded an array of every survivor;
  // and the result cards were built for all five thousand when twenty are
  // ever drawn.  A seven-letter word blocked the main thread for the better
  // part of a second.
  //
  // Measured as the time `dispatchEvent` takes to return, which is the whole
  // cost: React flushes a discrete event before handing control back, so the
  // filter, the sort, the counts and the cards have all been computed and
  // written to the DOM by then.  The line is drawn at 100ms, between the
  // ~27ms this costs now and the ~168ms it cost before — far enough from
  // both that neither a busy machine nor that particular regression reaches
  // it.  `npm run perf` prints the same figure for a whole set of actions.
  const keyCost: number[] = []
  for (let n = 1; n <= 7; n++) {
    keyCost.push(
      Number(
        await w.webContents.executeJavaScript(
          `(()=>{const i=document.querySelector(".toolbar input[placeholder^='搜索']");if(!i)return -1;`
          + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
          + `const t0=performance.now();`
          + `set.call(i,${JSON.stringify('network'.slice(0, n))});`
          + `i.dispatchEvent(new Event("input",{bubbles:true}));`
          + `return Math.round(performance.now()-t0)})()`
        )
      )
    )
    await new Promise((r) => setTimeout(r, 120))
  }
  log('ms per keystroke', keyCost)
  expect(
    'a keystroke stays cheap over the whole library',
    keyCost.every((x) => x >= 0) && Math.max(...keyCost) < 100,
    keyCost
  )
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".toolbar input[placeholder^=\'搜索\']");'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))

  // "save search" used to call window.prompt, which throws in Electron, so
  // the run opens the dialog and checks it is the in-app one.  It cancels
  // rather than saving, to keep the config untouched.
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".toolbar input[placeholder^=\'搜索\']");'
    + 'if(!i)return "no search box";'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"resnet");'
    + 'i.dispatchEvent(new Event("input",{bubbles:true}));return "ok"})()'
  )
  await new Promise((r) => setTimeout(r, 500))
  await openMenu('更多')
  await new Promise((r) => setTimeout(r, 300))
  log('click 保存搜索', await clickMenu('保存搜索'))
  await new Promise((r) => setTimeout(r, 300))
  log(
    'ask dialog',
    await w.webContents.executeJavaScript(
      'JSON.stringify({modal:!!document.querySelector(".modal"),'
      + 'head:(document.querySelector(".modal-head")||{}).textContent||null,'
      + 'value:(document.querySelector(".modal input")||{}).value||null})'
    )
  )
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".modal-acts button")]'
    + '.find(x=>x.textContent.trim()==="取消");if(b)b.click();'
    + 'const i=document.querySelector(".toolbar input[placeholder^=\'搜索\']");'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()'
  )

  // The rule under every row has to come from the palette.  It was written
  // as a literal in the component, a copy of the dark --row-line, so the
  // light theme drew a dark line across a light row and no stylesheet could
  // override it — an inline colour outranks any selector.
  const rowPaint = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const row=document.querySelector("div.row");'
      + 'if(!row)return JSON.stringify({ok:false});'
      + 'const dark=getComputedStyle(row).borderBottomColor;'
      + 'document.documentElement.dataset.theme="light";'
      + 'const light=getComputedStyle(row).borderBottomColor;'
      + 'delete document.documentElement.dataset.theme;'
      + 'const back=getComputedStyle(row).borderBottomColor;'
      + 'return JSON.stringify({ok:true,dark,light,back,inline:row.getAttribute("style")||""})})()'
    )
  )
  log('row rule across themes', rowPaint)
  expect(
    'the rule under a row follows the theme',
    rowPaint.ok === true && rowPaint.dark !== rowPaint.light && rowPaint.back === rowPaint.dark,
    rowPaint
  )
  expect(
    'the rule under a row is not written inline',
    rowPaint.ok === true && !/border/.test(rowPaint.inline),
    rowPaint
  )

  // Folders arrived in the order the catalogue holds them, which is stable
  // but arbitrary: a folder sat wherever it happened to land and finding one
  // meant reading down the column.  Only the top level is compared, because a
  // child is listed under its parent and so the whole column is not one
  // alphabetical run.
  const folderOrder = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const rows=[...document.querySelectorAll(".folder-row")]'
      + '.filter(e=>e.style.paddingLeft==="8px");'
      + 'const names=rows.map(e=>(e.querySelector(".name")||{}).textContent||"")'
      + '.filter(n=>n&&n!=="全部文献").slice(0,40);'
      // compared with the same collator the tree uses, so a difference in
      // how the two engines rank Chinese cannot be mistaken for a bug
      + 'const sorted=[...names].sort((a,b)=>a.localeCompare(b,"zh",{numeric:true,sensitivity:"base"}));'
      + 'return JSON.stringify({count:names.length,'
      + 'same:JSON.stringify(names)===JSON.stringify(sorted),first:names.slice(0,3)})})()'
    )
  )
  log('folder order', folderOrder)
  expect(
    'folders are listed by name',
    folderOrder.count > 1 && folderOrder.same === true,
    folderOrder
  )

  // Folders: putting a selection into one and taking it back out.  Nothing is
  // applied — writing folder membership to the real account is not a smoke
  // run's business — so what is proved here is the wiring: what travels with
  // the drag, that the import veil keeps out of its way, and that both
  // directions are on offer once a folder is being looked at.  It is the
  // wiring that was missing, not the API call.
  const clickAll = () =>
    w.webContents.executeJavaScript(
      '(()=>{const f=[...document.querySelectorAll(".folder-row")]'
      + '.find(e=>((e.querySelector(".name")||{}).textContent||"").includes("全部文献"));'
      + 'if(f)f.click();return 1})()'
    )
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  await clickAll()
  await wait(400)
  await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")];'
    + 'if(r.length<3)return 0;r[0].click();'
    + 'r[1].dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}));return 1})()'
  )
  await wait(400)
  const dragPayload = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const r=[...document.querySelectorAll("div.row")];if(r.length<3)return "{}";'
      + 'const fire=(el)=>{const dt=new DataTransfer();'
      + 'el.dispatchEvent(new DragEvent("dragstart",{bubbles:true,cancelable:true,dataTransfer:dt}));'
      + 'let ids=[];try{ids=JSON.parse(dt.getData("text/doc-ids")||"[]")}catch(e){ids=[]}'
      + 'return {n:ids.length,one:dt.getData("text/doc-id")||null,'
      + 'carries:[...dt.types].includes("text/doc-ids")}};'
      + 'const sel=fire(r[0]);const lone=fire(r[2]);'
      + 'return JSON.stringify({selected:sel.n,one:sel.one?1:0,carries:sel.carries,lone:lone.n})})()'
    )
  )
  log('drag payload', dragPayload)
  expect(
    'dragging a selected row carries the whole selection',
    dragPayload.selected === 2,
    dragPayload
  )
  expect('the single-document key is still written', dragPayload.one === 1, dragPayload)
  expect('the payload is typed so a drop target can tell', dragPayload.carries === true, dragPayload)
  expect('a row outside the selection travels alone', dragPayload.lone === 1, dragPayload)

  // The veil says "松手即导入 PDF".  Shown while the reader is dragging papers
  // out of the table, it says the opposite of what is about to happen, which
  // is how a supported gesture comes to look unsupported.
  const veil = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        'JSON.stringify({veil:document.querySelectorAll(".drop-veil").length,'
        + 'marked:(document.querySelector(".app")||{}).className.includes("dropping")})'
      )
    )
  await w.webContents.executeJavaScript(
    '(()=>{const dt=new DataTransfer();dt.setData("text/doc-ids",JSON.stringify(["a","b"]));'
    + 'document.querySelector(".app").dispatchEvent(new DragEvent("dragover",'
    + '{bubbles:true,cancelable:true,dataTransfer:dt}));return 1})()'
  )
  await wait(300)
  const veilDocs = await veil()
  log('veil while dragging papers', veilDocs)
  expect(
    'dragging papers out of the table does not offer to import PDFs',
    veilDocs.veil === 0 && veilDocs.marked === false,
    veilDocs
  )
  await w.webContents.executeJavaScript(
    '(()=>{const dt=new DataTransfer();'
    + 'dt.items.add(new File(["x"],"a.pdf",{type:"application/pdf"}));'
    + 'document.querySelector(".app").dispatchEvent(new DragEvent("dragover",'
    + '{bubbles:true,cancelable:true,dataTransfer:dt}));return 1})()'
  )
  await wait(300)
  const veilFiles = await veil()
  log('veil while dragging files', veilFiles)
  expect('dragging real files still offers to import PDFs', veilFiles.veil === 1, veilFiles)
  await w.webContents.executeJavaScript(
    '(()=>{document.querySelector(".app").dispatchEvent(new DragEvent("dragleave",'
    + '{bubbles:true,relatedTarget:null}));return 1})()'
  )
  await wait(300)
  expect('leaving the window puts the veil away', (await veil()).veil === 0, veilFiles)

  // "移出" is only a meaningful request while there is a somewhere to be moved
  // out of, so it is offered per folder rather than as a global command.  The
  // first folder that actually has papers in it is used, because a folder with
  // none has no row to right click.
  const folderNames: string[] = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify([...document.querySelectorAll(".folder-row")]'
      + '.map(e=>(e.querySelector(".name")||{}).textContent||""))'
    )
  )
  let outFolder = ''
  let outRows = 0
  for (const nm of folderNames.slice(0, 15)) {
    if (!nm || nm.includes('全部文献')) continue
    await w.webContents.executeJavaScript(
      '(()=>{const f=[...document.querySelectorAll(".folder-row")]'
      + '.find(e=>((e.querySelector(".name")||{}).textContent||"")==='
      + JSON.stringify(nm) + ');if(f)f.click();return 1})()'
    )
    await wait(400)
    const st = JSON.parse(
      await w.webContents.executeJavaScript(
        'JSON.stringify({rows:document.querySelectorAll("div.row").length,'
        + 'bar:[...document.querySelectorAll(".batch-bar button")].map(b=>b.textContent.trim())})'
      )
    )
    if (st.rows >= 1 && (st.bar ?? []).some((b: string) => b.startsWith('移出「'))) {
      outFolder = nm
      outRows = st.rows
      break
    }
  }
  log('folder with papers', { outFolder, outRows })
  expect('a folder offers to take the selection out of itself', !!outFolder, {
    outFolder,
    outRows
  })
  await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")];if(!r.length)return 0;'
    + 'r[0].dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:200,clientY:200}));'
    + 'return 1})()'
  )
  await wait(400)
  const outMenu = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify([...document.querySelectorAll(".row-menu .row-menu-item")]'
      + '.map(b=>({t:b.textContent.trim(),off:b.disabled})))'
    )
  )
  log('row menu in a folder', outMenu.length, outMenu.slice(0, 2))
  const outItem = (outMenu as { t: string }[]).find((m) => m.t.startsWith('移出「'))
  expect(
    'the row menu offers to take a paper out of the folder',
    !!outItem && outItem.t.includes(outFolder),
    { outItem, outFolder }
  )
  // back where the run started: the library as a whole, nothing selected
  await w.webContents.executeJavaScript(
    '(()=>{window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));'
    + 'const b=[...document.querySelectorAll(".batch-bar button")]'
    + '.find(x=>x.textContent.trim()==="取消选择");if(b)b.click();return 1})()'
  )
  await clickAll()
  await wait(400)

  // F2 is the key the rest of the desktop uses for "rename this", and a
  // folder is the only thing here that has a name to change.  Until now the
  // tree only offered it behind a pencil button hidden in a row until the row
  // is hovered, so the gesture the reader already knows from Explorer did
  // nothing.  What is checked is the wiring — the box opens on the folder
  // that is open, pre-filled with the name it already has — and not the API
  // call: giving a real folder a new name is not a smoke run's business.
  const f2Name = (folderNames as string[]).find((n) => n && !n.includes('全部文献')) ?? ''
  await w.webContents.executeJavaScript(
    '(()=>{const f=[...document.querySelectorAll(".folder-row")]'
    + '.find(e=>((e.querySelector(".name")||{}).textContent||"")==='
    + JSON.stringify(f2Name) + ');if(f)f.click();return 1})()'
  )
  await wait(400)
  // dispatched on whatever has the focus, because that is what the shortcut
  // is refused on: a press aimed at a text field belongs to the text field
  const f2Press = () =>
    w.webContents.executeJavaScript(
      '(()=>{const el=document.activeElement||document.body;'
      + 'el.dispatchEvent(new KeyboardEvent("keydown",{key:"F2",bubbles:true,cancelable:true}));'
      + 'return 1})()'
    )
  await f2Press()
  await wait(400)
  const f2Box = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({box:document.querySelectorAll(".folder-row .rename").length,'
      + 'value:(document.querySelector(".folder-row .rename")||{}).value||null})'
    )
  )
  log('F2 on a folder', { name: f2Name, ...f2Box })
  expect(
    'F2 opens the rename box on the folder that is open',
    f2Box.box === 1 && f2Box.value === f2Name,
    { f2Name, f2Box }
  )
  // Escape has to put it away without renaming: a box that can only be left
  // by committing turns the key into a trap
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".folder-row .rename");'
    + 'if(i)i.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));'
    + 'return 1})()'
  )
  await wait(300)
  const f2After = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({box:document.querySelectorAll(".folder-row .rename").length,'
      + 'name:((document.querySelector(".folder-row.sel .name")||{}).textContent||null)})'
    )
  )
  log('F2 dismissed', f2After)
  expect(
    'Escape leaves the box without renaming',
    f2After.box === 0 && f2After.name === f2Name,
    f2After
  )
  // A press meant for somewhere else must not rename a folder.  With the
  // whole library open there is no folder to name, and while the search box
  // holds the key the reader is typing rather than asking.
  await clickAll()
  await wait(300)
  await f2Press()
  await wait(300)
  const f2None = await w.webContents.executeJavaScript(
    'document.querySelectorAll(".folder-row .rename").length'
  )
  expect('F2 with no folder open does nothing', Number(f2None) === 0, f2None)
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".toolbar input");if(i)i.focus();return 1})()'
  )
  await f2Press()
  await wait(300)
  const f2Typing = await w.webContents.executeJavaScript(
    'document.querySelectorAll(".folder-row .rename").length'
  )
  expect('F2 while typing in the search box does nothing', Number(f2Typing) === 0, f2Typing)
  await w.webContents.executeJavaScript(
    '(()=>{const a=document.activeElement;if(a&&a.blur)a.blur();return 1})()'
  )
  await clickAll()
  await wait(300)

  // Column widths.  The drag is tracked on the window, which only starts
  // listening after the press has been rendered, so a press, a move and a
  // release are three separate steps with a wait between each.  A column that
  // already has a saved width is left alone, so the run can put the one it
  // used back exactly as it found it.
  const head0 = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({cells:document.querySelectorAll(".col-head [data-col]").length,'
      + 'grips:document.querySelectorAll(".col-head .col-grip").length})'
    )
  )
  log('column header', head0)
  expect(
    'every column header has a width handle',
    head0.cells > 3 && head0.grips === head0.cells,
    head0
  )
  const widthCfg0 = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>{const c=await window.api.getConfig();'
      + 'return JSON.stringify(c.colWidths||{})})()'
    )
  )
  const colKey: string = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const ks=[...document.querySelectorAll(".col-head [data-col]")]'
      + '.map(e=>e.getAttribute("data-col"));'
      + 'const want=["title","authors","source"].filter(k=>ks.includes(k));'
      + 'const free=ks.filter(k=>k!=="star"&&k!=="pdf"&&!' + JSON.stringify(Object.keys(widthCfg0))
      + '.includes(k));'
      + 'return JSON.stringify(want.find(k=>free.includes(k))||free[0]||ks[ks.length-1])})()'
    )
  )
  log('column to drag', { colKey, widthCfg0 })
  const cellInfo = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        '(()=>{const c=[...document.querySelectorAll(".col-head [data-col]")]'
        + '.find(e=>e.getAttribute("data-col")===' + JSON.stringify(colKey) + ');'
        + 'const wrap=document.querySelector(".table-wrap");'
        + 'return JSON.stringify({w:c?Math.round(c.getBoundingClientRect().width):null,'
        + 'scrollable:wrap?wrap.scrollWidth>wrap.clientWidth+1:false})})()'
      )
    )
  const pressCol = async (dx: number) => {
    const started = await w.webContents.executeJavaScript(
      '(()=>{const c=[...document.querySelectorAll(".col-head [data-col]")]'
      + '.find(e=>e.getAttribute("data-col")===' + JSON.stringify(colKey) + ');'
      + 'const g=c&&c.querySelector(".col-grip");if(!g)return 0;'
      + 'const r=g.getBoundingClientRect();'
      + 'window.__cd={x:r.x+3,y:r.y+r.height/2};'
      + 'g.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,'
      + 'clientX:window.__cd.x,clientY:window.__cd.y}));return 1})()'
    )
    if (!started) return 0
    await wait(200)
    await w.webContents.executeJavaScript(
      'window.dispatchEvent(new MouseEvent("mousemove",{bubbles:true,'
      + 'clientX:window.__cd.x+' + dx + ',clientY:window.__cd.y}))'
    )
    await wait(200)
    await w.webContents.executeJavaScript(
      'window.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}))'
    )
    await wait(200)
    return 1
  }
  const colW0 = await cellInfo()
  await pressCol(200)
  const colW1 = await cellInfo()
  log('column dragged', { colKey, colW0, colW1 })
  expect('dragging a column header widens the column', colW1.w > colW0.w + 100, { colW0, colW1 })
  // remembered after a wait, not during: a drag is a hundred frames and none
  // of them is worth a write
  await wait(700)
  const widthCfg1 = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>{const c=await window.api.getConfig();'
      + 'return JSON.stringify(c.colWidths||{})})()'
    )
  )
  log('colWidths after', widthCfg1)
  expect('the width is remembered once the drag stops', typeof widthCfg1[colKey] === 'number', widthCfg1)

  // Widening past the pane is what makes the table scroll sideways, and the
  // header is a second scroll box: if it does not follow, the labels and the
  // values are no longer above each other.
  await pressCol(900)
  const wideCell = await cellInfo()
  const headSync = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const wrap=document.querySelector(".table-wrap");'
      + 'const head=document.querySelector(".col-head");'
      + 'wrap.scrollLeft=60;wrap.dispatchEvent(new Event("scroll",{bubbles:true}));'
      + 'return JSON.stringify({set:wrap.scrollLeft,head:head.scrollLeft,'
      + 'scrollable:wrap.scrollWidth>wrap.clientWidth+1})})()'
    )
  )
  log('header follows the rows', { wideCell, headSync })
  expect('a column can be dragged wider than the pane', wideCell.scrollable === true, wideCell)
  expect(
    'the header follows the rows when the table is wider than the pane',
    headSync.set === 60 && headSync.head === 60,
    headSync
  )

  // back as it was found: the handle gives the column back to its default
  // track, and the run leaves no width of its own behind
  await w.webContents.executeJavaScript(
    '(()=>{const c=[...document.querySelectorAll(".col-head [data-col]")]'
    + '.find(e=>e.getAttribute("data-col")===' + JSON.stringify(colKey) + ');'
    + 'const g=c&&c.querySelector(".col-grip");if(!g)return 0;'
    + 'g.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));'
    + 'const wrap=document.querySelector(".table-wrap");if(wrap)wrap.scrollLeft=0;'
    + 'return 1})()'
  )
  await wait(700)
  const widthCfg2 = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>{const c=await window.api.getConfig();'
      + 'return JSON.stringify(c.colWidths||{})})()'
    )
  )
  log('colWidths restored', widthCfg2)
  expect('double clicking the handle hands the column back', widthCfg2[colKey] === undefined, widthCfg2)

  // The first-run guide is for an empty library on a machine with no token.
  // Somebody with a cached library and an expired token is not a first run,
  // and putting the guide in front of them would be worse than whatever the
  // token was for — so its absence is what is checked.
  const setupShown = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({setup:document.querySelectorAll(".setup").length,'
      + 'rows:document.querySelectorAll("div.row").length})'
    )
  )
  log('first run guide', setupShown)
  expect(
    'the guide stays out of the way once there is a library',
    setupShown.setup === 0 && setupShown.rows > 0,
    setupShown
  )

  // An empty table has to say why.  The usual case is a term that is in the
  // paper but not in its title or abstract, and the answer is in the same
  // toolbar — which is exactly the thing nobody was told.
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".toolbar input");'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"zzqqxxnotathing");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  const emptyInfo = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({rows:document.querySelectorAll("div.row").length,'
      + 'text:(document.querySelector(".empty")||{}).textContent||null,'
      + 'clear:[...document.querySelectorAll(".empty button")].map(b=>b.textContent)})'
    )
  )
  log('empty table', emptyInfo)
  expect(
    'an empty table names what was searched',
    /zzqqxxnotathing/.test(emptyInfo.text ?? ''),
    emptyInfo
  )
  expect(
    'an empty table points at full-text search',
    emptyInfo.rows === 0 && /书目字段/.test(emptyInfo.text ?? ''),
    emptyInfo
  )
  expect(
    'an empty table offers a way back',
    (emptyInfo.clear ?? []).some((t: string) => /清空/.test(t)),
    emptyInfo
  )
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".empty button")]'
    + '.find(x=>x.textContent.includes("清空"));if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  const restored = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({rows:document.querySelectorAll("div.row").length,'
      + 'q:(document.querySelector(".toolbar input")||{}).value||null})'
    )
  )
  log('after clearing', restored)
  // `!q` rather than `q === ''`: the value is read through `|| null`, which
  // turns an empty search box into null
  expect('clearing brings the library back', restored.rows > 0 && !restored.q, restored)

  // shift-click selection, checked without any of the batch actions that
  // would write to the library
  log(
    'shift-click',
    await w.webContents.executeJavaScript(
      '(()=>{const rows=[...document.querySelectorAll("div.row")];'
      + 'if(rows.length<4)return "few rows";rows[0].click();'
      + 'rows[3].dispatchEvent(new MouseEvent("click",{bubbles:true,shiftKey:true}));'
      + 'return rows.length})()'
    )
  )
  await new Promise((r) => setTimeout(r, 400))
  log(
    'batch bar',
    await w.webContents.executeJavaScript(
      'JSON.stringify({bar:(document.querySelector(".batch-bar span")||{}).textContent'
      + '||null,picked:document.querySelectorAll("div.row.multi").length})'
    )
  )
  await w.webContents.executeJavaScript(
    '(()=>{const c=[...document.querySelectorAll(".batch-bar button")]'
    + '.find(b=>b.textContent.trim()==="取消选择");if(c)c.click();return 1})()'
  )
  // Every undo step is the inverse of a call that wrote to the cloud, so the
  // run cannot exercise one without moving the user's library.  It can still
  // check the button is there and idle.
  const undoBtn = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
      + '.find(x=>x.textContent.trim().startsWith("撤销"));'
      + 'if(!b)return JSON.stringify({found:false});'
      + 'return JSON.stringify({found:true,disabled:b.disabled,title:b.title})})()'
    )
  )
  log('undo button', undoBtn)
  expect(
    'undo is offered and idle',
    undoBtn.found === true && undoBtn.disabled === true,
    undoBtn
  )

  // Column customisation and saved views.  Both live in the config, so the
  // run puts the layout and the view list back afterwards; a smoke run has no
  // business leaving the user's table rearranged.
  const cfg0 = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>JSON.stringify(await window.api.getConfig()))()'
    )
  )
  const headCols = () =>
    w.webContents.executeJavaScript(
      'JSON.stringify([...document.querySelectorAll(".col-head > div")].map(d=>d.dataset.col))'
    )
  const tickCol = (label: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const r=[...document.querySelectorAll(".col-row")]`
      + `.find(x=>x.textContent.includes("${label}"));if(!r)return 0;`
      + `r.querySelector("input").click();return 1})()`
    )
  const colsBefore = JSON.parse(await headCols())
  log('columns before', colsBefore)
  log(
    'click 列',
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
      + '.find(x=>x.textContent.trim()==="列");if(!b)return "missing";b.click();return "ok"})()'
    )
  )
  await new Promise((r) => setTimeout(r, 400))
  const pickerOpen = await w.webContents.executeJavaScript(
    'document.querySelectorAll(".col-picker").length'
  )
  expect('column picker opens', pickerOpen === 1, pickerOpen)
  log('untick 发表处', await tickCol('发表处'))
  await new Promise((r) => setTimeout(r, 400))
  const colsFewer = JSON.parse(await headCols())
  expect('unticking a column drops it', !colsFewer.includes('source'), colsFewer)
  log('tick 标签', await tickCol('标签'))
  await new Promise((r) => setTimeout(r, 400))
  const colsTags = JSON.parse(await headCols())
  expect('ticking a column adds it', colsTags.includes('tags'), colsTags)

  // save the layout as a view, apply a different one, then confirm the saved
  // one comes back
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".col-picker button")]'
    + '.find(x=>x.textContent.includes("保存为视图"));if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".modal input");if(!i)return 0;'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"smoke view");i.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'const b=[...document.querySelectorAll(".modal-acts button")]'
    + '.find(x=>x.textContent.trim()==="确定");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 500))
  const viewRows = await w.webContents.executeJavaScript(
    'JSON.stringify([...document.querySelectorAll(".col-views .ol-row .name")].map(n=>n.textContent))'
  )
  log('saved views', viewRows)
  expect('a saved view is listed', /smoke view/.test(viewRows), viewRows)
  log('restore default columns', await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".col-picker button")]'
    + '.find(x=>x.textContent.includes("恢复默认"));if(!b)return 0;b.click();return 1})()'
  ))
  await new Promise((r) => setTimeout(r, 400))
  const colsDefault = JSON.parse(await headCols())
  expect('resetting restores the default columns', !colsDefault.includes('tags'), colsDefault)
  // apply the saved view again, which is the point of having saved it
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".col-views .ol-row")]'
    + '.find(x=>x.textContent.includes("smoke view"));if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  const colsFromView = JSON.parse(await headCols())
  expect('applying a view restores its columns', colsFromView.includes('tags'), colsFromView)
  // back to the default layout, so the rest of the run sees the table it
  // expects, then close the picker and put the config back
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".col-picker button")]'
    + '.find(x=>x.textContent.includes("恢复默认"));if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".col-picker button")]'
    + '.find(x=>x.textContent.trim()==="✕");if(b)b.click();return 1})()'
  )
  await w.webContents.executeJavaScript(
    `(async()=>{await window.api.setConfig(${JSON.stringify({
      // only name the keys that were already there, so the run does not leave
      // a null behind for a setting the user never touched
      ...(cfg0.cols ? { cols: cfg0.cols } : {}),
      views: cfg0.views ?? []
    })});return 1})()`
  )
  await new Promise((r) => setTimeout(r, 300))

  // 添加时间 is part of the default layout now, and a layout that was never
  // customised follows the default instead of staying on the one it was first
  // written with.  The migration is checked by writing the previous default
  // into the config and reloading: the header has to come back with the new
  // column in it, and a layout somebody arranged has to be left alone.
  const headKeys = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        'JSON.stringify([...document.querySelectorAll(".col-head > div")]'
        + '.map(d=>d.dataset.col))'
      )
    )
  const OLD_DEFAULT = ['star', 'pdf', 'authors', 'title', 'year', 'source', 'citation_key']
  const atStart = await headKeys()
  const setColsAndReload = async (cols: string[] | null) => {
    // written straight to the config rather than through setConfig, which can
    // only merge: a layout the user never had would come back as a null
    const cfg = loadConfig()
    if (cols) cfg.cols = cols
    else delete cfg.cols
    saveConfig(cfg)
    await w.loadFile(path.join(__dirname, '../renderer/index.html'))
    await new Promise((r) => setTimeout(r, 2500))
  }
  await setColsAndReload(OLD_DEFAULT)
  const migrated = await headKeys()
  log('columns after migration', migrated)
  expect(
    'a layout that was never customised picks up 添加时间',
    migrated.includes('created') && migrated.length === OLD_DEFAULT.length + 1,
    migrated
  )
  // and one the reader arranged themselves is left exactly as it was
  const mine = ['star', 'title', 'created', 'year']
  await setColsAndReload(mine)
  const kept = await headKeys()
  log('columns after a custom layout', kept)
  expect(
    'a layout somebody arranged is left alone',
    JSON.stringify(kept) === JSON.stringify(['star', 'title', 'year', 'created']),
    { kept, mine }
  )
  // back to whatever the reader had, which for most is the default itself
  await setColsAndReload(cfg0.cols ?? null)
  const colsRestored = await headKeys()
  log('columns colsRestored', colsRestored)
  expect(
    'the run leaves the column layout as it found it',
    JSON.stringify(colsRestored) === JSON.stringify(atStart),
    { colsRestored, atStart }
  )
  const firstAdded = await w.webContents.executeJavaScript(
    '(()=>{const i=[...document.querySelectorAll(".col-head > div")]'
    + '.findIndex(d=>d.dataset.col==="created");if(i<0)return "none";'
    + 'const r=document.querySelector("div.row");if(!r)return "norow";'
    + 'return (r.children[i]?.textContent||"").trim()})()'
  )
  log('first 添加时间 cell', firstAdded)
  expect(
    '添加时间 reads as a date, not a timestamp',
    /^\d{4}-\d{2}-\d{2}$/.test(String(firstAdded)),
    firstAdded
  )

  // Reordering a column by dragging its header.  The header is also the sort
  // control, so the two things that are checked are that a drag does reorder,
  // and that the click which follows it is swallowed rather than sorting a
  // column the reader was in the middle of moving.
  const colsConfig = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        '(async()=>{const c=await window.api.getConfig();'
        + 'return JSON.stringify(c.cols||null)})()'
      )
    )
  const colsBeforeMove = await colsConfig()
  const k0 = await headKeys()
  // which column carries the sort arrow, by name and not by position: the
  // reorder moves the arrow with its column, so comparing positions would
  // report a sort that never happened
  const arrowKey = async () =>
    w.webContents.executeJavaScript(
      '(()=>{const cs=[...document.querySelectorAll(".col-head > div")]'
      + '.filter(d=>d.dataset.col);'
      + 'const a=cs.find(d=>/[▲▼]/.test(d.textContent||""));'
      + 'return a?a.dataset.col:"none"})()'
    )
  const sorted0 = await arrowKey()
  log('order before', k0, 'sorted by', sorted0)
  const pressMove = async (js: string) => {
    await w.webContents.executeJavaScript(js)
    await new Promise((r) => setTimeout(r, 250))
  }
  await pressMove(
    '(()=>{const cs=[...document.querySelectorAll(".col-head > div")]'
    + '.filter(d=>d.dataset.col);if(cs.length<4)return 0;'
    + 'const a=cs[2].getBoundingClientRect(),b=cs[3].getBoundingClientRect();'
    + 'window.__mv={el:cs[2],x:a.left+a.width/2,y:a.top+a.height/2,'
    + 'tx:b.left+b.width*0.8};'
    + 'window.__mv.el.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,'
    + 'clientX:window.__mv.x,clientY:window.__mv.y}));return 1})()'
  )
  await pressMove(
    '(()=>{const m=window.__mv;if(!m)return 0;'
    + 'window.dispatchEvent(new MouseEvent("mousemove",{bubbles:true,'
    + 'clientX:m.tx,clientY:m.y}));return 1})()'
  )
  // The move is coalesced into one per frame, and a frame in a window that is
  // not on screen is not on a schedule anybody can wait out with a fixed
  // sleep: ask repeatedly instead, and stop when it answers.
  const waitFor = async (js: string, ms: number) => {
    const t0 = Date.now()
    for (;;) {
      const v = await w.webContents.executeJavaScript(js)
      if (v === 'yes' || Date.now() - t0 > ms) return v
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  const midDrag = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({line:document.querySelectorAll(".col-drop").length,'
      + 'ghost:document.querySelectorAll(".col-moving").length})'
    )
  )
  const lineSeen = await waitFor(
    '(()=>document.querySelectorAll(".col-drop").length?"yes":"no")()',
    4000
  )
  log('mid drag', { ...midDrag, lineSeen })
  expect('a dragged header shows where it would land', lineSeen === 'yes', {
    ...midDrag,
    lineSeen
  })
  expect('the column in hand is the one that dims', midDrag.ghost === 1, midDrag)
  await pressMove('window.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}))')
  // the click a real browser fires after the mouse comes up: it must be
  // swallowed, or releasing over a header sorts the column just moved
  await pressMove(
    '(()=>{const m=window.__mv;if(!m)return 0;m.el.dispatchEvent('
    + 'new MouseEvent("click",{bubbles:true,clientX:m.tx,clientY:m.y}));return 1})()'
  )
  const k1 = await headKeys()
  log('order after', k1)
  expect(
    'dragging a header moves the column',
    k1[2] === k0[3] && k1[3] === k0[2] && k1.length === k0.length,
    { k0, k1 }
  )
  const cfgCols1 = await colsConfig()
  log('cols after', cfgCols1)
  expect(
    'the new order is remembered',
    JSON.stringify(cfgCols1) === JSON.stringify(k1),
    { cfgCols1, k1 }
  )
  const sorted1 = await arrowKey()
  log('sorted after', sorted1)
  expect(
    'releasing over a header does not sort the column just moved',
    sorted1 === sorted0,
    { sorted0, sorted1 }
  )

  // A press that does not travel is still a sort.
  await pressMove(
    '(()=>{const cs=[...document.querySelectorAll(".col-head > div")]'
    + '.filter(d=>d.dataset.col);if(!cs.length)return 0;'
    + 'const a=cs[2].getBoundingClientRect();'
    + 'window.__clk={el:cs[2],x:a.left+a.width/2,y:a.top+a.height/2};'
    + 'window.__clk.el.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,'
    + 'clientX:window.__clk.x,clientY:window.__clk.y}));return 1})()'
  )
  await pressMove('window.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}))')
  await pressMove(
    '(()=>{const m=window.__clk;if(!m)return 0;m.el.dispatchEvent('
    + 'new MouseEvent("click",{bubbles:true,clientX:m.x,clientY:m.y}));return 1})()'
  )
  const k2 = await headKeys()
  const arrow = await w.webContents.executeJavaScript(
    '(()=>{const cs=[...document.querySelectorAll(".col-head > div")]'
    + '.filter(d=>d.dataset.col);'
    + 'return /[▲▼]/.test(cs[2]?cs[2].textContent:"")?"yes":"no"})()'
  )
  log('after a plain click', { k2, arrow })
  expect(
    'a click that does not move still sorts',
    arrow === 'yes' && JSON.stringify(k2) === JSON.stringify(k1),
    { k1, k2, arrow }
  )

  await setColsAndReload(colsBeforeMove)
  const k3 = await headKeys()
  log('order restored', k3)
  expect('the run leaves the order as it found it', JSON.stringify(k3) === JSON.stringify(k0), {
    k0,
    k3
  })

  // How the list is sorted is something the reader chose, so it has to
  // survive a restart.  Pressing 标题 and coming back on Monday to
  // newest-first undoes the one press that matters, and it is the kind of
  // thing that reads as the app not listening.  Both halves are checked: the
  // press writes, and a fresh load reads it back.
  const sortCfg = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        '(async()=>{const c=await window.api.getConfig();'
        + 'return JSON.stringify(c.sort||null)})()'
      )
    )
  const setSortAndReload = async (s: { key: string; dir: 1 | -1 } | null) => {
    // straight to the config: setConfig can only merge, so clearing the sort
    // the way the reader never had one would leave the old value behind
    const cfg = loadConfig()
    if (s) cfg.sort = s
    else delete cfg.sort
    saveConfig(cfg)
    await w.loadFile(path.join(__dirname, '../renderer/index.html'))
    await new Promise((r) => setTimeout(r, 2500))
  }
  const pressHead = (col: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const c=[...document.querySelectorAll(".col-head > div")]`
      + `.find(d=>d.dataset.col===${JSON.stringify(col)});if(!c)return 0;`
      + `c.dispatchEvent(new MouseEvent("click",{bubbles:true}));return 1})()`
    )
  // what the reader had before the run started touching things: the press
  // further down writes, and the run has to put it back
  const sortState = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        '(()=>{const cs=[...document.querySelectorAll(".col-head > div")]'
        + '.filter(d=>d.dataset.col);'
        + 'const a=cs.find(d=>/[▲▼]/.test(d.textContent||""));'
        + 'return JSON.stringify(a?{col:a.dataset.col,'
        + 'dir:/▲/.test(a.textContent||"")?1:-1}:null)})()'
      )
    )
  const sort0: { key: string; dir: 1 | -1 } | null = cfg0.sort ?? null
  // What a press on a header means depends on what is already sorted: on the
  // key it is already sorted by it turns the direction, on any other key it
  // asks for that key's own direction.  What is already sorted is not
  // something to infer from the run so far — a column dragged past a header
  // can land a click on it, and the direction the press is then expected to
  // produce is a coin toss.  A known sort goes on first, so the press below is
  // always an asking-for and never a turning.
  await setSortAndReload({ key: 'year', dir: -1 })
  const want1 = 1
  expect('title is a column that can sort', (await pressHead('title')) === 1, 'title')
  await new Promise((r) => setTimeout(r, 400))
  const sort1 = await sortCfg()
  log('sort after one press', { had: sort0, want1, sort1 })
  expect(
    'a press on a header is remembered',
    sort1?.key === 'title' && sort1?.dir === want1,
    { sort1, want1 }
  )
  await pressHead('title')
  await new Promise((r) => setTimeout(r, 400))
  const sort2 = await sortCfg()
  log('sort after a second press', sort2)
  expect('pressing the same header again flips it', sort2?.dir === -want1, { sort2, want1 })
  await setSortAndReload(sort2)
  const arrowAfter = await arrowKey()
  log('arrow after a fresh load', arrowAfter)
  expect('the sort comes back after a restart', arrowAfter === 'title', arrowAfter)
  // a key that stopped being sortable must not come back as an arrow on
  // nothing: it falls back to the default instead
  await setSortAndReload({ key: 'nonsense', dir: 1 })
  expect('a sort key that no longer exists is dropped', (await arrowKey()) === 'year', 'nonsense')
  await setSortAndReload(sort0)
  const wantArrow = sort0 ? sort0.key : 'year'
  const wantDir = sort0 ? sort0.dir : -1
  const backState = await sortState()
  log('sort restored', { wanted: { wantArrow, wantDir }, got: backState })
  expect(
    'the run leaves the sort as it found it',
    backState?.col === wantArrow && backState?.dir === wantDir,
    { wantArrow, wantDir, backState }
  )

  // Sorting is a question about the list, not about one column, so it has to
  // be askable where there are no headers to press: with a word in the search
  // box the results come back as cards, and a card has nowhere to put an
  // arrow.  That gap is the whole reason the card exists.  What is checked is
  // not that the card opens but that pressing it moves the papers — a menu
  // that writes a config nobody reads would pass every check except this one.
  const toolbarBtn = (label: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll(".toolbar button")]`
      + `.find(x=>x.textContent.trim()===${JSON.stringify(label)});`
      + `if(!b)return 0;b.click();return 1})()`
    )
  const pickSort = (key: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const b=document.querySelector('.sort-pick[data-sort="${key}"]');`
      + `if(!b)return 0;b.click();return 1})()`
    )
  const sortCardKeys = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        '(()=>{const c=document.querySelector(".filter-menu");if(!c)return "[]";'
        + 'return JSON.stringify([...c.querySelectorAll(".sort-pick")]'
        + '.map(b=>b.dataset.sort))})()'
      )
    )
  /** The years the list is showing, in the order it is showing them.  Works
   *  for result cards and for full-text rows alike, which is the point: both
   *  are lists of papers and both have to answer to the same order. */
  const yearsShown = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        '(()=>{const es=[...document.querySelectorAll(".res-year")];'
        + 'const src=es.length?es:[...document.querySelectorAll(".ft-row .ft-meta")];'
        + 'return JSON.stringify(src.map(e=>'
        + 'parseInt((e.textContent||"").replace(/[^0-9]/g,"").slice(0,4),10))'
        + '.filter(n=>n>1900&&n<2100))})()'
      )
    )
  const monotonic = (ys: number[], dir: number) =>
    ys.length > 1 && ys.every((n, i) => (i === 0 ? true : dir < 0 ? ys[i - 1] >= n : ys[i - 1] <= n))
  // a value written through the property setter and announced with `input`,
  // which is what React listens for; typing one character at a time would
  // also work and would take twenty times as long
  const typeWord = (v: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const i=document.querySelector(".toolbar input");if(!i)return 0;`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
      + `set.call(i,${JSON.stringify(v)});`
      + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
  // The press below only asks for a key's own direction when the list is not
  // already sorted by that key; when it is, the press turns the direction
  // instead.  The default with no sort saved is the year, which is exactly the
  // key about to be pressed — so on a clean config the press would flip rather
  // than choose, and the direction read back would be the opposite of the one
  // being claimed.  A known key goes on first; the reload at the end of this
  // block puts back whatever the reader had.
  await setSortAndReload({ key: 'title', dir: 1 })
  expect('the toolbar offers a sort card', (await toolbarBtn('排序')) === 1, '排序')
  await new Promise((r) => setTimeout(r, 400))
  const sortKeys = await sortCardKeys()
  log('sort card keys', sortKeys)
  expect(
    'the card can sort by the year and by the date added',
    sortKeys.includes('year') && sortKeys.includes('created'),
    sortKeys
  )
  expect('the card can be asked for the year', (await pickSort('year')) === 1, 'year')
  await new Promise((r) => setTimeout(r, 400))
  const pickedYear = await sortCfg()
  log('sort after picking 年份', pickedYear)
  expect('picking a key on the card writes it', pickedYear?.key === 'year', pickedYear)
  // a year is asked for newest-first: being handed 1974 first is being handed
  // the answer to a question nobody asked
  expect('a year starts at the recent end', pickedYear?.dir === -1, pickedYear)
  await typeWord('the')
  await new Promise((r) => setTimeout(r, 1200))
  const yDesc = await yearsShown()
  log('years, as the search results are ordered', yDesc)
  expect('search results are ordered by the year that was picked', monotonic(yDesc, -1), yDesc)
  // The card stays open after a pick, so the second press is another press on
  // the row, not another press on the button — pressing the button would
  // close the card and the pick would quietly do nothing, leaving an
  // assertion that passes because nothing moved.
  //
  // Equal years satisfy both directions at once, so what proves the order
  // turned around is the ends, not the shape: the newest paper is first one
  // way and the oldest the other.
  expect('the card is still open for a second press', (await pickSort('year')) === 1, 'year')
  await new Promise((r) => setTimeout(r, 1200))
  const flipped = await sortCfg()
  const yAsc = await yearsShown()
  log('years after pressing it again', { flipped, yAsc })
  expect('pressing the same key again turns it around', monotonic(yAsc, 1), yAsc)
  expect(
    'turning it around really moves the papers',
    flipped?.dir === 1 && yAsc[0] < yDesc[0],
    { newest: yDesc[0], oldest: yAsc[0], flipped }
  )
  // The full-text list gets the same check further down, once the index
  // exists.  It cannot be done here: entering 全文 makes the main process
  // read the index, and the check further down plants an index from an older
  // version on disk *before* anything reads it — a read here wins and that
  // one then finds its file ignored.
  await setSortAndReload(sort0)

  // The file naming template.  Only its preview is exercised: actually
  // renaming moves files on disk, so the confirmation is answered with 取消
  // and the template is put back afterwards.
  const tpl0 = cfg0.pdfNameTemplate
  log(
    'click 命名',
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".pane-head button")]'
      + '.find(x=>x.textContent.trim()==="命名");if(!b)return "missing";b.click();return "ok"})()'
    )
  )
  await new Promise((r) => setTimeout(r, 400))
  const tplDlg = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({modal:!!document.querySelector(".modal"),'
      + 'value:(document.querySelector(".modal input")||{}).value||null})'
    )
  )
  log('name template dialog', tplDlg)
  expect(
    'naming template dialog opens on the default',
    /\{authors\}/.test(tplDlg.value ?? ''),
    tplDlg
  )
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".modal input");if(!i)return 0;'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"{year} - {title}");i.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'const b=[...document.querySelectorAll(".modal-acts button")]'
    + '.find(x=>x.textContent.trim()==="确定");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 800))
  // the naming dialog hands over to the confirmation; refusing it is what
  // keeps the run from moving files on the reader's disk.  It has to be
  // dismissed either way, or the veil stops everything that follows.
  const tplConfirm = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({modal:!!document.querySelector(".confirm-modal"),'
      + 'text:(document.querySelector(".confirm-modal")||{}).textContent||null})'
    )
  )
  log('naming asks before renaming', tplConfirm)
  expect('renaming files on disk asks first', tplConfirm.modal === true, tplConfirm)
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".modal-acts button")]'
    + '.find(x=>x.textContent.trim()==="取消");if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  await w.webContents.executeJavaScript(
    `(async()=>{await window.api.setConfig({`
    + `pdfNameTemplate:${JSON.stringify(tpl0 ?? '{authors} - {year} - {title}')}});return 1})()`
  )

  // Export used to be a browser download, which always landed in the downloads
  // folder and came out as "library (1).bib" the second time.  A save dialog
  // cannot be driven headlessly, so it is stubbed: what is asserted is that
  // the text reaches whatever path the dialog returns, that the dialog is
  // asked for a .bib with a sensible starting name, that the folder is
  // remembered for next time, and that cancelling stays silent.
  const exportDir = path.join(dataDir(), 'smoke-export')
  fs.rmSync(exportDir, { recursive: true, force: true })
  fs.mkdirSync(exportDir, { recursive: true })
  const savedTo = path.join(exportDir, 'smoke.bib')
  let cancelNext = false
  const askLog: { defaultPath?: string; ext?: string }[] = []
  const realSaveDialog = dialog.showSaveDialog
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async (
    _w: unknown,
    o: { defaultPath?: string; filters?: { extensions: string[] }[] }
  ) => {
    askLog.push({ defaultPath: o?.defaultPath, ext: o?.filters?.[0]?.extensions?.[0] })
    return cancelNext ? { canceled: true, filePath: '' } : { canceled: false, filePath: savedTo }
  }
  const clickExport = async () => {
    await openMenu('导出')
    await new Promise((r) => setTimeout(r, 300))
    return clickMenu('BibTeX')
  }
  expect('an export button is reachable', (await clickExport()) === 1, 'button')
  // the round trip is two processes long; wait for the file rather than
  // guessing how long the dialog and the write take
  let wrote = ''
  for (let i = 0; i < 60 && !wrote; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (fs.existsSync(savedTo)) wrote = fs.readFileSync(savedTo, 'utf8')
  }
  expect('the export reaches the chosen path', wrote.length > 0, savedTo)
  expect('what lands in the file is BibTeX', /@\w+\{/.test(wrote), wrote.slice(0, 80))
  expect('the dialog is asked for a bib file', askLog[0]?.ext === 'bib', askLog[0])
  expect(
    'the dialog starts from a named file',
    /library\.bib$/.test(askLog[0]?.defaultPath ?? ''),
    askLog[0]?.defaultPath
  )
  expect(
    'the folder is remembered for next time',
    loadConfig().exportDir === exportDir,
    loadConfig().exportDir
  )
  cancelNext = true
  await clickExport()
  await new Promise((r) => setTimeout(r, 900))
  const afterCancel = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({err:!!document.querySelector(".err"),'
      + 'msg:(document.querySelector(".pdf-msg")||{}).textContent||null})'
    )
  )
  // cancelling is the reader changing their mind, not a failure: a banner here
  // would make the button feel like it broke
  expect('cancelling the export says nothing', afterCancel.err === false, afterCancel)
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = realSaveDialog
  fs.rmSync(exportDir, { recursive: true, force: true })
  saveConfig({ ...loadConfig(), exportDir: undefined })

  const shot = async (name: string) => {
    const p = path.join(app.getPath('temp'), 'mendeley-ng-' + name + '.png')
    const img = await w.webContents.capturePage()
    fs.writeFileSync(p, img.toPNG())
    log('screenshot ->', p, img.getSize().width + 'x' + img.getSize().height)
  }
  await shot('smoke')

  // a screenshot of the light palette, set through the DOM rather than the
  // button so the run does not leave the user's config switched over
  await w.webContents.executeJavaScript(
    '(()=>{document.documentElement.dataset.theme="light";return document.documentElement.dataset.theme})()'
  )
  await new Promise((r) => setTimeout(r, 300))
  await shot('smoke-light')
  await w.webContents.executeJavaScript(
    '(()=>{delete document.documentElement.dataset.theme;return "reset"})()'
  )

  // click the first row and give pdf.js time to paint, so the run also proves
  // the reader works and that the canvas is backed at device resolution
  const clicked = await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")].filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));'
    + 'if(!r.length)return "no row with pdf";r[0].click();return r[0].innerText.replace(/\\n/g," | ").slice(0,80)})()'
  )
  log('clicked row:', clicked)
  await new Promise((r) => setTimeout(r, 5000))
  const pdfInfo = await w.webContents.executeJavaScript(
    '(()=>{const c=document.querySelector("canvas");return JSON.stringify({canvases:document.querySelectorAll("canvas").length,bufW:c&&c.width,bufH:c&&c.height,cssW:c&&c.style.width,dpr:devicePixelRatio})})()'
  )
  log('pdf', pdfInfo)
  log(
    'right pane',
    await w.webContents.executeJavaScript(
      '(()=>{const p=document.querySelector(".pane-right");return JSON.stringify((p?p.innerText:"(no pane)").slice(0,300))})()'
    )
  )
  await shot('smoke-pdf')

  // Turning pages from the keyboard.  What is proved is not only that the
  // keys work, but that they belong to the reader while it has focus: the
  // same keys walk the table's selection, and one press moving both the page
  // and the selected paper would be worse than either alone.
  const paneKey = (key: string, shift = false) =>
    w.webContents.executeJavaScript(
      `(()=>{const p=document.querySelector(".pdf-pane");if(!p)return 0;`
      + `p.dispatchEvent(new KeyboardEvent("keydown",{key:${JSON.stringify(key)},`
      + `shiftKey:${shift},bubbles:true,cancelable:true}));return 1})()`
    )
  const pageNow = async () =>
    Number(
      await w.webContents.executeJavaScript(
        '(()=>{const i=document.querySelector(".pdf-bar input");return i?i.value:null})()'
      )
    )
  const selText = () =>
    w.webContents.executeJavaScript(
      '(()=>{const r=document.querySelector("div.row.sel");'
      + 'return r?r.innerText.replace(/\\n/g," ").slice(0,60):null})()'
    )
  // a paper in the middle of the list, so that a key the table also handles
  // has somewhere to move to and staying put means something
  await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")]'
    + '.filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));'
    + 'if(!r.length)return 0;r[Math.min(r.length-1,Math.floor(r.length/2))].click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 5000))
  const paneFocusable = await w.webContents.executeJavaScript(
    '(()=>{const p=document.querySelector(".pdf-pane");return p?p.tabIndex:-1})()'
  )
  expect('the reader can hold focus for the keys', paneFocusable === 0, paneFocusable)
  const numPages = Number(
    await w.webContents.executeJavaScript(
      '(()=>{const s=(document.querySelector(".pdf-bar span")||{}).textContent||"";'
      + 'const m=s.match(/(\\d+)/);return m?m[1]:0})()'
    )
  )
  log('pages in the open paper', numPages)
  expect('the paper has more than one page to turn', numPages >= 2, numPages)
  const selBefore = await selText()
  // start from page one: a paper that is reopened opens where it was left,
  // and a run that starts on the last page has nowhere to turn to
  await paneKey('Home')
  await new Promise((r) => setTimeout(r, 800))
  const at0 = await pageNow()
  await paneKey('PageDown')
  await new Promise((r) => setTimeout(r, 600))
  const at1 = await pageNow()
  log('PageDown', { at0, at1 })
  expect('PageDown turns a page', at1 === at0 + 1, { at0, at1 })
  await paneKey(' ')
  await new Promise((r) => setTimeout(r, 600))
  const at2 = await pageNow()
  log('space', { at1, at2 })
  expect('space turns a page', at2 === at1 + 1, { at1, at2 })
  await paneKey('PageUp')
  await new Promise((r) => setTimeout(r, 600))
  const at3 = await pageNow()
  log('PageUp', { at2, at3 })
  expect('PageUp goes back', at3 === at2 - 1, { at2, at3 })
  await paneKey('End')
  await new Promise((r) => setTimeout(r, 800))
  const atEnd = await pageNow()
  log('End', atEnd)
  expect('End goes to the last page', atEnd === numPages, { atEnd, numPages })
  await paneKey('Home')
  await new Promise((r) => setTimeout(r, 800))
  const atHome = await pageNow()
  const selAfter = await selText()
  log('Home', { atHome, selBefore, selAfter })
  expect('Home goes to the first page', atHome === 1, atHome)
  // the table must not also have walked: Home and End are its own keys for
  // jumping to the first and last paper
  expect('a key the reader claims does not move the table too', selAfter === selBefore, {
    selBefore,
    selAfter
  })
  // back to the top of the list and to a paper that was already open: what
  // follows looks at the rows near the top, and a run that leaves the table
  // scrolled into the middle quietly changes which rows those are
  await w.webContents.executeJavaScript(
    '(()=>{const s=document.querySelector(".table-wrap");if(s)s.scrollTop=0;'
    + 'const r=[...document.querySelectorAll("div.row")]'
    + '.filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));if(r.length)r[0].click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 1500))

  // Reading position.  A library this size is never read in one sitting, so
  // reopening a paper has to land where it was left rather than on page one.
  // Checked by leaving a paper on page 3, opening another, and coming back.
  const readPos = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>{'
      + 'const rows=[...document.querySelectorAll("div.row")]'
      + '.filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));'
      + 'if(rows.length<2)return JSON.stringify({skip:"need two rows with a pdf"});'
      + 'const wait=(ms)=>new Promise(r=>setTimeout(r,ms));'
      + 'const setP=(n)=>{const i=document.querySelector(".pdf-bar input");if(!i)return;'
      + 'const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
      + 's.call(i,String(n));i.dispatchEvent(new Event("input",{bubbles:true}));};'
      + 'rows[0].click();await wait(3000);'
      + 'setP(3);await wait(1500);'
      + 'const at=document.querySelector(".pdf-bar input").value;'
      + 'const bar=()=>document.querySelector(".pdf-bar input").value;'
      + 'rows[1].click();await wait(3500);'
      + 'const other=bar();'
      + 'rows[0].click();await wait(4500);'
      + 'return JSON.stringify({at,other,back:bar(),'
      + 'msg:(document.querySelector(".pdf-msg")||{}).textContent||null})})()'
    )
  )
  log('reading position', readPos)
  expect(
    'the reader reopens where it was left',
    readPos.at !== '1' && readPos.back === readPos.at,
    readPos
  )
  expect('reopening says why it is not on page one', /上次读到/.test(readPos.msg ?? ''), readPos)

  // A formatted citation is what a reference manager is actually for, so the
  // run copies one and reads it back.  Both the clipboard and the style are
  // restored: a smoke test has no business eating what the user had copied or
  // leaving their citation style switched over.
  const clipBefore = await w.webContents.executeJavaScript('window.api.readClipboard()')
  const styleBefore = await w.webContents.executeJavaScript(
    '(document.querySelector(".cite-box select")||{}).value||"author-year"'
  )
  const clickCite = () =>
    w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
      + '.find(x=>x.textContent.trim()==="复制引文");if(!b||b.disabled)return 0;b.click();return 1})()'
    )
  const setStyle = (v: string) =>
    w.webContents.executeJavaScript(
      '(()=>{const s=document.querySelector(".cite-box select");if(!s)return 0;'
      + 'const set=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,"value").set;'
      + `set.call(s,"${v}");s.dispatchEvent(new Event("change",{bubbles:true}));return 1})()`
    )
  // The clipboard write is an IPC round trip, and under load a fixed wait
  // loses the race — the check then fails for a reason that has nothing to
  // do with citations.  Empty it first, then wait for it to fill.
  const copyCiteAndRead = async () => {
    await w.webContents.executeJavaScript('window.api.copyText("")')
    await clickCite()
    for (let i = 0; i < 20; i++) {
      const v = await w.webContents.executeJavaScript('window.api.readClipboard()')
      if (String(v ?? '').length) return v
      await new Promise((r) => setTimeout(r, 150))
    }
    return ''
  }
  const cited = await copyCiteAndRead()
  log('citation', JSON.stringify(cited))
  expect('copying a citation reaches the clipboard', /\(20\d\d\)|\(n\.d\.\)/.test(cited), cited)
  log('cite style -> numeric', await setStyle('numeric'))
  await new Promise((r) => setTimeout(r, 400))
  const citedNumeric = await copyCiteAndRead()
  log('citation numeric', JSON.stringify(citedNumeric))
  expect('the cite style changes what is copied', citedNumeric === '[1]', {
    cited,
    citedNumeric
  })
  log('cite style restored', await setStyle(styleBefore))
  await w.webContents.executeJavaScript(
    `window.api.copyText(${JSON.stringify(String(clipBefore ?? ''))})`
  )

  // The row menu.  Right clicking has to (a) open it where the pointer is,
  // (b) act on the row under the pointer, and (c) close on the next click —
  // a menu that survives its own action is the usual way these go wrong.
  const menuInfo = async () =>
    w.webContents.executeJavaScript(
      '(()=>{const m=document.querySelector(".row-menu");if(!m)return JSON.stringify({open:0});'
      + 'const r=m.getBoundingClientRect();'
      + 'return JSON.stringify({open:1,head:(document.querySelector(".row-menu-head")||{}).textContent||null,'
      + 'items:[...document.querySelectorAll(".row-menu-item")].map(b=>b.textContent),'
      + 'seps:document.querySelectorAll(".row-menu-sep").length,'
      + 'inWindow:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})})()'
    )
  await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")].filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));'
    + 'if(!r.length)return 0;const b=r[0].getBoundingClientRect();'
    + 'r[0].dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,'
    + 'clientX:Math.round(b.left+40),clientY:Math.round(b.top+8)}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 500))
  const mi = JSON.parse(await menuInfo())
  log('row menu', JSON.stringify(mi))
  expect('a right click opens the row menu', mi.open === 1, mi)
  // `|| []` rather than a bare read: a menu that did not open answers with no
  // list at all, and reading `.length` off that throws, which ends the run
  // before the config is put back — one red line turning into a dozen more on
  // every later run, because the next run starts from what this one left.
  expect('the row menu offers actions and separators', (mi.items || []).length >= 4 && mi.seps >= 1, mi)
  expect('the row menu stays inside the window', mi.inWindow === true, mi)
  expect(
    'the row menu can hand the file to the OS',
    (mi.items || []).includes('在文件夹中显示') && (mi.items || []).includes('用系统程序打开'),
    mi
  )
  // the two shell actions are only offered where there is a file to hand over:
  // an entry that does nothing on click is worse than no entry at all
  await w.webContents.executeJavaScript(
    '(()=>{document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))
  await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")].filter(e=>e.querySelector(".pdf-dot.no-pdf"));'
    + 'if(!r.length)return 0;const b=r[0].getBoundingClientRect();'
    + 'r[0].dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,'
    + 'clientX:Math.round(b.left+40),clientY:Math.round(b.top+8)}));return 1})()'
  )
  // asked for rather than waited out: the reader is a PDF being painted in the
  // background, and a fixed sleep that is enough on an idle machine is not
  // enough while one is being decoded
  await waitFor('(()=>document.querySelectorAll(".row-menu-item").length?"yes":"no")()', 4000)
  const noPdf = await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".row-menu-item")];'
    + 'return JSON.stringify({n:b.length,reveal:(b.find(x=>x.textContent.trim()==="在文件夹中显示")||{}).disabled})})()'
  )
  log('row menu on a row without a pdf', noPdf)
  expect('the shell actions are disabled when there is no file', /"reveal":true/.test(noPdf), noPdf)
  // the handlers themselves are exercised with an empty path, which is the one
  // call that cannot open anything on the user's desktop
  const shellApi = await w.webContents.executeJavaScript(
    '(async()=>JSON.stringify([await window.api.revealPdf(""),await window.api.openPdfExternally("")]))()'
  )
  log('shell api with no path', shellApi)
  expect('the shell handlers answer', /"error":"no path"/.test(shellApi), shellApi)
  // close this menu, then reopen it on a row that has a file, because the next
  // check clicks an item in whatever menu happens to be open
  await w.webContents.executeJavaScript(
    '(()=>{document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))
  await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")].filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));'
    + 'if(!r.length)return 0;const b=r[0].getBoundingClientRect();'
    + 'r[0].dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,'
    + 'clientX:Math.round(b.left+40),clientY:Math.round(b.top+8)}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  // "复制标题" is the one item that is safe to actually run: it touches the
  // clipboard and nothing else, so a smoke run can prove the wiring without
  // editing the library.  The clipboard is emptied first, so a value left over
  // from earlier in the run cannot make the check pass on its own.
  // The menu is opened again rather than reused: it closes on any click
  // outside it, and which menu is still standing at this point has been
  // watched to depend on how busy the renderer is with the PDF it is
  // painting.  Waited for, because the same load decides how long it takes.
  await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")]'
    + '.filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));'
    + 'if(!r.length)return 0;const b=r[0].getBoundingClientRect();'
    + 'r[0].dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,'
    + 'clientX:Math.round(b.left+40),clientY:Math.round(b.top+8)}));return 1})()'
  )
  await waitFor(
    '(()=>[...document.querySelectorAll(".row-menu-item")]'
    + '.some(x=>x.textContent.trim()==="复制标题")?"yes":"no")()',
    4000
  )
  await w.webContents.executeJavaScript('window.api.copyText("")')
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".row-menu-item")]'
    + '.find(x=>x.textContent.trim()==="复制标题");if(!b)return 0;b.click();return 1})()'
  )
  // The write goes through an IPC round trip, and under load a fixed sleep
  // — 600, then 900 — has been watched losing the race, which fails this
  // check for a reason that has nothing to do with the menu.  Asked until it
  // answers instead.
  let titleCopied = ''
  for (let i = 0; i < 25 && !titleCopied; i++) {
    await new Promise((r) => setTimeout(r, 200))
    titleCopied = await w.webContents.executeJavaScript('window.api.readClipboard()')
  }
  log('copied title', JSON.stringify(titleCopied))
  expect(
    'a row menu item runs',
    String(titleCopied || '').length > 3 && titleCopied !== clipBefore,
    { titleCopied, clipBefore }
  )
  expect('the menu closes after an item is chosen', (JSON.parse(await menuInfo())).open === 0, mi)
  await w.webContents.executeJavaScript(
    `window.api.copyText(${JSON.stringify(String(clipBefore ?? ''))})`
  )

  // Keyboard navigation.  Two things have to hold: the arrows walk the list
  // when the table has the keyboard, and they do not hijack the search box,
  // where ↑↓ belong to the text being typed.
  const selTitle = () =>
    w.webContents.executeJavaScript(
      '(()=>{const r=document.querySelector("div.row.sel");'
      + 'return r?r.innerText.replace(/\\n/g," | ").slice(0,60):null})()'
    )
  const press = (key: string, where: 'body' | 'search') =>
    w.webContents.executeJavaScript(
      `(()=>{const t=${where === 'search' ? 'document.querySelector(\'input[placeholder^="搜索"]\')' : 'document.body'};`
      + `if(!t)return 0;if(t.focus)t.focus();`
      + `t.dispatchEvent(new KeyboardEvent("keydown",{key:"${key}",bubbles:true,cancelable:true}));return 1})()`
    )
  const navFrom = await selTitle()
  log('press ArrowDown', await press('ArrowDown', 'body'))
  await new Promise((r) => setTimeout(r, 500))
  const navDown = await selTitle()
  log('press ArrowUp', await press('ArrowUp', 'body'))
  await new Promise((r) => setTimeout(r, 500))
  const navBack = await selTitle()
  log('keyboard nav', JSON.stringify({ navFrom, navDown, navBack }))
  expect('ArrowDown moves the selection', !!navDown && navDown !== navFrom, {
    navFrom,
    navDown
  })
  expect('ArrowUp comes back', navBack === navFrom, { navFrom, navBack })
  await press('ArrowDown', 'search')
  await new Promise((r) => setTimeout(r, 500))
  const navInSearch = await selTitle()
  expect('arrows inside the search box do not move the selection', navInSearch === navFrom, {
    navFrom,
    navInSearch
  })
  // blur again so the rest of the run does not type into the library search
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(\'input[placeholder^="搜索"]\');if(i)i.blur();return 1})()'
  )

  // Continuous scrolling is a remembered setting, not a per-document one, so
  // it lives in the config.  A run interrupted part-way leaves it switched
  // on, and the click further down then switches it off instead of on — every
  // check after it measures a reader that is not in the mode it is testing,
  // and fails for a reason that has nothing to do with the reader.  So it is
  // cleared before the reader is measured, not only restored afterwards.
  await w.webContents.executeJavaScript(
    '(async()=>{await window.api.setConfig({pdfContinuous:false});'
    + 'const b=[...document.querySelectorAll(".pdf-bar button")]'
    + '.find(x=>x.textContent.trim().startsWith("连续"));'
    + 'if(b&&document.querySelector(".pdf-cont"))b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 600))

  // zoom is the one thing a screenshot cannot prove: check that "fit width"
  // really fills the pane and that "fit page" then fits the height too
  const measure = () =>
    w.webContents.executeJavaScript(
      '(()=>{const sc=document.querySelector(".pdf-scroll"),c=document.querySelector("canvas");'
      + 'const b=sc.getBoundingClientRect(),r=c.getBoundingClientRect();'
      + 'const pct=document.querySelector(".pdf-bar span[style*=\'min-width\']");'
      + 'return JSON.stringify({pane:Math.round(b.width)+"x"+Math.round(b.height),'
      + 'page:Math.round(r.width)+"x"+Math.round(r.height),zoom:pct?pct.textContent:"?"})})()'
    )
  const clickBar = (label: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll(".pdf-bar button")]`
      // startsWith, because the annotations button carries a count
      + `.find(x=>x.textContent.trim().startsWith("${label}"));if(!b)return "missing";b.click();return "ok"})()`
    )
  log('fit-width', await measure())
  log('click 整页', await clickBar('整页'))
  await new Promise((r) => setTimeout(r, 1200))
  log('fit-page', await measure())
  log('click 适宽', await clickBar('适宽'))
  await new Promise((r) => setTimeout(r, 1200))
  log('back to fit-width', await measure())

  // the outline is the only way to navigate a long paper, so prove that it
  // loads and that clicking a section actually moves the page
  log('click 目录', await clickBar('目录'))
  await new Promise((r) => setTimeout(r, 400))
  const olInfo = await w.webContents.executeJavaScript(
    'JSON.stringify({rows:[...document.querySelectorAll(".ol-row")].length,'
    + 'first:(document.querySelector(".ol-row")||{}).textContent||null})'
  )
  log('outline', olInfo)
  const jumped = await w.webContents.executeJavaScript(
    '(()=>{const rows=[...document.querySelectorAll(".ol-row")];'
    + 'if(rows.length<2)return "too few rows";'
    // several sections of a short paper land on page 1, so aim at the last
    // one, which is the only entry guaranteed to be further in
    + 'const i=document.querySelector(".pdf-bar input");const before=i.value;'
    + 'rows[rows.length-1].click();return before})()'
  )
  await new Promise((r) => setTimeout(r, 1200))
  const nowPage = await w.webContents.executeJavaScript(
    'document.querySelector(".pdf-bar input").value'
  )
  log('outline jump', 'from', jumped, '->', nowPage)

  // page turns should hit the prefetch cache: go forward one, then back, and
  // see whether the second visit was served from a warmed bitmap
  // the outline left us on the last page, so going forward is a no-op: step
  // back onto a warmed page, then forward again onto one
  const src = () =>
    w.webContents.executeJavaScript(
      'JSON.stringify({src:document.documentElement.dataset.renderSrc,'
      + 'last:document.documentElement.dataset.pfLast,'
      + 'size:document.documentElement.dataset.pfSize,'
      + 'keys:document.documentElement.dataset.pfKeys,'
      + 'warm:document.documentElement.dataset.pfWarm,'
      + 'page:document.querySelector(".pdf-bar input").value})'
    )
  const turn = async (label: string) => {
    await w.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll(".pdf-bar button")]`
      + `.find(x=>x.textContent.trim()==="${label}");if(b&&!b.disabled)b.click();return 1})()`
    )
    // a warmed neighbour is rendered off the main path and never blocks the
    // visible page, so allow real time for it before asking what was served
    await new Promise((r) => setTimeout(r, 1500))
    return src()
  }
  // Measured from a page the run chose, not from wherever the outline left
  // the reader.  Plenty of real PDFs have no outline at all — the library
  // currently open has one with none — and then the jump below never
  // happens, the reader stays on whatever page the previous check happened
  // to leave it on, and the cache is blamed for a position nobody asked for.
  // Page one is typed into the box the way a reader would type it.
  const gotoPage = (n: number) =>
    w.webContents.executeJavaScript(
      `(()=>{const i=document.querySelector(".pdf-bar input");if(!i)return 0;`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
      + `set.call(i,"${n}");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
  await gotoPage(1)
  await new Promise((r) => setTimeout(r, 1500))
  log('render src (current page)', await src())
  // forward onto a fresh page, then back onto the one that was just left:
  // the step back has a bitmap waiting for it, and must not re-render
  await turn('→')
  const backOne = JSON.parse(await turn('←'))
  expect('prefetch serves a step back', backOne.src === 'cache', backOne)
  // and forward again onto the page that was just left behind
  const fwdAgain = JSON.parse(await turn('→'))
  expect('prefetch serves a step forward', fwdAgain.src === 'cache', fwdAgain)

  // Ctrl + wheel is the zoom gesture, and it is the one thing a reader tries
  // before looking for the buttons.  A plain wheel over the page must leave
  // the zoom alone, or every scroll past a paper would resize it.
  const zoomPct = () =>
    w.webContents.executeJavaScript(
      '(()=>{const s=[...document.querySelectorAll(".pdf-bar span")]'
      + '.map(x=>(x.textContent||"").trim()).find(t=>/^\\d+%$/.test(t));return s||null})()'
    )
  const wheel = (ctrl: boolean, dy: number) =>
    w.webContents.executeJavaScript(
      `(()=>{const p=document.querySelector(".pdf-pane");if(!p)return 0;`
      + `const c=p.querySelector("canvas");const r=(c||p).getBoundingClientRect();`
      + `p.dispatchEvent(new WheelEvent("wheel",{deltaY:${dy},ctrlKey:${ctrl},`
      + `bubbles:true,cancelable:true,clientX:Math.round(r.left+r.width/2),`
      + `clientY:Math.round(r.top+r.height/2)}));return 1})()`
    )
  const pctOf = (s: string | null) => (s ? parseInt(s, 10) : NaN)
  const z0 = await zoomPct()
  await wheel(false, -120)
  await new Promise((r) => setTimeout(r, 500))
  const z1 = await zoomPct()
  await wheel(true, -120)
  await new Promise((r) => setTimeout(r, 700))
  const z2 = await zoomPct()
  log('zoom', { z0, plain: z1, ctrl: z2 })
  expect('a plain wheel leaves the zoom alone', z1 === z0, { z0, plain: z1 })
  expect('ctrl + wheel zooms the page in', pctOf(z2) > pctOf(z0), { z0, ctrl: z2 })
  await wheel(true, 120)
  await new Promise((r) => setTimeout(r, 700))
  const z3 = await zoomPct()
  expect('ctrl + wheel zooms back out', pctOf(z3) < pctOf(z2), { ctrl: z2, back: z3 })

  // Continuous scrolling lays every page out in one column.  Only the pages
  // in view get a canvas painted into them, so the run checks both that the
  // column exists and that scrolling it paints more and moves the page box.
  // The mode is switched back off at the end: it is stored in the config, and
  // a smoke run has no business leaving the user's reader rearranged.
  const contInfo = () =>
    w.webContents.executeJavaScript(
      '(()=>{const e=document.querySelector(".pdf-cont");'
      + 'return JSON.stringify({pages:document.querySelectorAll(".pg-wrap").length,'
      + 'painted:[...document.querySelectorAll(".pg-wrap canvas")].filter(c=>c.width>0).length,'
      + 'page:document.querySelector(".pdf-bar input").value,'
      + 'top:e?Math.round(e.scrollTop):-1})})()'
    )
  const contScroll = (where: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const e=document.querySelector(".pdf-cont");if(!e)return 0;`
      + `e.scrollTop=${where};e.dispatchEvent(new Event("scroll"));return 1})()`
    )
  log('click 连续', await clickBar('连续'))
  await new Promise((r) => setTimeout(r, 3000))
  await contScroll('0')
  await new Promise((r) => setTimeout(r, 2500))
  const cTop = JSON.parse(await contInfo())
  log('continuous at top', cTop)
  await contScroll('e.scrollHeight')
  await new Promise((r) => setTimeout(r, 3000))
  const cBottom = JSON.parse(await contInfo())
  log('continuous at bottom', cBottom)
  // compared against the page count the reader itself reports, rather than
  // against a number: which paper is open is whatever was selected last, and
  // that is not this run's business to know.  Four was right for one paper
  // and wrong the moment a different one was selected.
  const cTotal = await w.webContents.executeJavaScript(
    '(()=>{const s=[...document.querySelectorAll(".pdf-bar span")]'
    + '.map(x=>(x.textContent||"").trim()).find(t=>/^\\/\\s*\\d+$/.test(t));'
    + 'return s?parseInt(s.replace(/\\D/g,""),10):-1})()'
  )
  log('continuous page count', { pages: cTop.pages, reported: cTotal })
  expect(
    'continuous lays out every page',
    cTotal > 1 && cTop.pages === cTotal,
    { cTop, cTotal }
  )
  expect('continuous paints pages in view', cTop.painted > 0, cTop)
  expect('continuous paints further down', cBottom.painted > 0, cBottom)
  expect('scrolling the column moves the page box', cBottom.page !== cTop.page, {
    top: cTop.page,
    bottom: cBottom.page
  })
  log('click 连续 again', await clickBar('连续'))
  await new Promise((r) => setTimeout(r, 1200))

  // In-reader find.  The query is taken from the page's own text layer rather
  // than guessed, so the assertion holds for whichever paper happens to be
  // first in the library, and asks for a real hit instead of a null result.
  log('click 查找', await clickBar('查找'))
  await new Promise((r) => setTimeout(r, 300))
  const query = await w.webContents.executeJavaScript(
    '(()=>{const sp=[...document.querySelectorAll(".tx-layer span.tx")]'
    + '.map(s=>(s.textContent||"").trim()).filter(t=>t.length>=4);return sp[0]||""})()'
  )
  log('find query', JSON.stringify(query))
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".pdf-find input");if(!i)return 0;'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + `set.call(i,${JSON.stringify(query)});i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
  )
  // the scan walks every page and only finishes when it reaches the last one
  await new Promise((r) => setTimeout(r, 4000))
  const findInfo = await w.webContents.executeJavaScript(
    '(()=>{const d=document.documentElement.dataset;'
    + 'const marks=[...document.querySelectorAll(".find-hit")];'
    + 'const cur=document.querySelector(".find-hit.cur");'
    + 'return JSON.stringify({hits:d.findHits,page:d.findPage,marks:marks.length,'
    + 'current:!!cur,count:(document.querySelector(".find-count")||{}).textContent||null,'
    + 'box:marks[0]?{w:Math.round(marks[0].getBoundingClientRect().width),'
    + 'h:Math.round(marks[0].getBoundingClientRect().height)}:null})})()'
  )
  log('find', findInfo)
  const fi = JSON.parse(findInfo)
  expect('find reports hits', Number(fi.hits) > 0, fi)
  expect('find draws a mark for them', fi.marks > 0, fi)
  expect('find marks the current hit', fi.current === true, fi)
  expect('a find mark has real size', !!fi.box && fi.box.w > 0 && fi.box.h > 0, fi)
  // "1 / 102" says which and how many only to somebody who already knows the
  // convention.  Spelled out, it answers the question the count exists for:
  // is this the first of three or the first of a hundred?
  expect(
    'the count says which match this is and how many there are',
    /第\s*\d+\s*个匹配/.test(String(fi.count ?? '')) &&
      /共\s*\d+\s*个/.test(String(fi.count ?? '')),
    fi
  )
  // The matches are on the page, so the count belongs over the page, in the
  // corner the eye goes to.  Checked geometrically rather than by reading the
  // stylesheet, because what matters is where it lands, not what it says.
  const findBox = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const f=document.querySelector(".pdf-find");'
      + 'const p=document.querySelector(".pdf-body");if(!f||!p)return "{}";'
      + 'const a=f.getBoundingClientRect(),b=p.getBoundingClientRect();'
      + 'return JSON.stringify({pos:getComputedStyle(f).position,'
      + 'fromRight:Math.round(b.right-a.right),fromTop:Math.round(a.top-b.top),'
      + 'inside:a.top>=b.top-1&&a.right<=b.right+1})})()'
    )
  )
  log('find bar placement', findBox)
  expect(
    'the find bar floats over the top right of the page',
    findBox.pos === 'absolute' && findBox.inside === true && findBox.fromRight < 40,
    findBox
  )
  expect(
    'and it is at the top of it, not halfway down',
    typeof findBox.fromTop === 'number' && findBox.fromTop >= 0 && findBox.fromTop < 40,
    findBox
  )
  // A squeezed control does not clip its label, it stands it up: Chinese wraps
  // between any two characters, so the width a flex item shrinks to is one
  // character wide and as many rows deep as the label has characters.  The
  // yardstick is the ← button, which is one character to begin with and so is
  // the one thing in the bar that cannot be stood on end whatever the width.
  const barRows = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const b=document.querySelector(".pdf-bar");if(!b)return "{}";'
      + 'const k=[...b.children].map(c=>c.offsetHeight);'
      + 'return JSON.stringify({n:k.length,first:k[0],tallest:Math.max(...k),'
      + 'scroll:b.scrollWidth,client:b.clientWidth})})()'
    )
  )
  log('pdf bar rows', barRows)
  expect(
    'the reader bar keeps every control on one line',
    barRows.n > 5 && barRows.tallest <= barRows.first + 2,
    barRows
  )
  // stepping has to move the caret, and on a multi-hit query it also has to
  // wrap around rather than dead-end at the last one
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pdf-find button")]'
    + '.find(x=>x.textContent.trim()==="↓");if(b&&!b.disabled)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 1200))
  const stepped = await w.webContents.executeJavaScript(
    'JSON.stringify({hits:document.documentElement.dataset.findHits,'
    + 'page:document.documentElement.dataset.findPage,'
    + 'count:(document.querySelector(".find-count")||{}).textContent||null})'
  )
  log('find step', stepped)
  if (Number(fi.hits) > 1) {
    expect('stepping moves the find caret', stepped !== findInfo, { fi, stepped })
  }
  // leaving the reader in find mode would leave an orange box on the user's
  // paper the next time they open it
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pdf-find button")]'
    + '.find(x=>x.textContent.trim()==="×");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))

  // The selection layer is what turns a rubber band into a real highlight, so
  // the run makes a synthetic selection and checks that it produces sane
  // rectangles.  The annotation file is restored afterwards; leaving a stray
  // highlight on a real paper would be a nasty side effect of a smoke test.
  // snapshot at the file level, because the restore below is the only thing
  // standing between a smoke run and the user's real highlights
  const annPath = path.join(app.getPath('userData'), 'library', 'annotations.json')
  const annBackup = fs.existsSync(annPath) ? fs.readFileSync(annPath) : null
  // same for where the reader left each paper: the run opens real PDFs, which
  // is enough to overwrite the position of whichever one it happened to open
  const readPath = path.join(app.getPath('userData'), 'library', 'reading.json')
  const readBackup = fs.existsSync(readPath) ? fs.readFileSync(readPath) : null
  const beforeCount = await w.webContents.executeJavaScript(
    '(async()=>{const a=await window.api.loadAnnotations();window.__before=a;return a.length})()'
  )
  if (annBackup && beforeCount === 0 && JSON.parse(annBackup.toString() || '[]').length) {
    log('WARNING: store holds annotations but the renderer saw none')
  }
  const layerInfo = await w.webContents.executeJavaScript(
    '(()=>{const sp=[...document.querySelectorAll(".tx-layer span.tx")];'
    + 'if(sp.length<10)return JSON.stringify({spans:sp.length});'
    + 'const a=sp[20],b=sp[26];const r=document.createRange();'
    + 'r.setStart(a.firstChild||a,0);r.setEnd(b.firstChild||b,Math.min(3,(b.textContent||"").length));'
    + 'const s=getSelection();s.removeAllRanges();s.addRange(r);'
    + 'const rr=r.getBoundingClientRect();const box=document.querySelector(".tx-layer").getBoundingClientRect();'
    + 'return JSON.stringify({spans:sp.length,sel:{w:Math.round(rr.width),h:Math.round(rr.height)},'
    + 'box:{w:Math.round(box.width),h:Math.round(box.height)}})})()'
  )
  log('text layer', layerInfo)
  const addSinceBefore = () =>
    w.webContents.executeJavaScript(
      '(async()=>{const a=await window.api.loadAnnotations();const before=window.__before;'
      + 'const added=a.filter(x=>!before.some(y=>y.id===x.id));'
      + 'return JSON.stringify({added:added.length,rects:added[0]?added[0].rects:null,'
      + 'pos:added[0]?added[0].pos:null})})()'
    )
  const mouseUpOnPage = () =>
    w.webContents.executeJavaScript(
      '(()=>{const el=document.querySelector(".pdf-scroll").firstElementChild;'
      + 'const b=el.getBoundingClientRect();'
      + 'el.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,clientX:b.left+5,clientY:b.top+5}));return 1})()'
    )
  /** The selection a highlight is made from.  It has to be repeatable: turning
   *  a selection into a highlight clears it, so anything that checks what
   *  happens afterwards needs to be able to make another one. */
  const selectSomeText = () =>
    w.webContents.executeJavaScript(
      '(()=>{const sp=[...document.querySelectorAll(".tx-layer span.tx")];'
      + 'if(sp.length<10)return 0;const a=sp[20],b=sp[26];'
      + 'const r=document.createRange();'
      + 'r.setStart(a.firstChild||a,0);r.setEnd(b.firstChild||b,Math.min(3,(b.textContent||"").length));'
      + 'const s=getSelection();s.removeAllRanges();s.addRange(r);return 1})()'
    )
  // Highlighting is opt-in, so the same selection made while it is off has to
  // leave the page alone: picking words in order to copy them cannot also be
  // a request to mark the paper.
  await mouseUpOnPage()
  await new Promise((r) => setTimeout(r, 1200))
  const offMade = JSON.parse(await addSinceBefore())
  log('selection with highlighting off', offMade)
  expect('a selection made with highlighting off adds nothing', offMade.added === 0, offMade)
  log('click 高亮', await clickBar('高亮'))
  await new Promise((r) => setTimeout(r, 250))
  // the selection is still there — nothing consumed it — so the same mouseup
  // now has to produce the highlight
  await mouseUpOnPage()
  await new Promise((r) => setTimeout(r, 1500))
  const made = JSON.parse(await addSinceBefore())
  log('selection highlight', 'before', beforeCount, made)

  // A highlight made while the mode was on still needs a way back: the mode
  // can have been left on, and picking words is what somebody does to copy
  // them.  The offer has to be there and has to work, not just be drawn.
  const hlUndo = await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pdf-bar button")]'
    + '.find(x=>x.textContent.trim()==="撤销");if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 1200))
  const undone = JSON.parse(await addSinceBefore())
  log('undo the highlight', { hlUndo, undone })
  expect('a highlight offers to be taken back', hlUndo === 1, { hlUndo })
  expect('taking it back removes it', undone.added === made.added - 1, { made, undone })
  // the selection was consumed by the highlight, so it has to be made again
  // before the same mouseup can put one back for the sidebar to list
  await selectSomeText()
  await mouseUpOnPage()
  await new Promise((r) => setTimeout(r, 1500))
  log('highlight again for the sidebar', await addSinceBefore())

  // the annotation sidebar has to list a highlight that was just made, so it
  // is checked here rather than before, and the restore happens after
  log('click 标注', await clickBar('标注'))
  await new Promise((r) => setTimeout(r, 400))
  log(
    'annotation sidebar',
    await w.webContents.executeJavaScript(
      'JSON.stringify({rows:[...document.querySelectorAll(".ol-row")].length,'
      + 'first:(document.querySelector(".ol-row")||{}).textContent||null,'
      + 'dots:document.querySelectorAll(".ann-dot").length})'
    )
  )
  // The cross-document annotation list.  It runs here, after a highlight has
  // been made, so there is something to list; and it only reads, because
  // deleting one of the user's real annotations is not a smoke run's business.
  await openMenu('更多')
  await new Promise((r) => setTimeout(r, 300))
  log('click 全部标注', await clickMenu('全部标注'))
  await new Promise((r) => setTimeout(r, 700))
  const notesInfo = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        'JSON.stringify({rows:document.querySelectorAll(".notes-row").length,'
        + 'groups:document.querySelectorAll(".notes-group").length,'
        + 'dots:document.querySelectorAll(".notes-row .ann-dot").length,'
        + 'doc:(document.querySelector(".notes-doc")||{}).textContent||null,'
        + 'open:document.querySelectorAll(".notes-list").length})'
      )
    )
  const n0 = await notesInfo()
  log('notes view', n0)
  expect('the annotation list spans documents', n0.rows > 0 && n0.groups > 0, n0)
  expect('every listed annotation carries its colour', n0.dots === n0.rows, n0)
  // filtering has to actually narrow the list, and an empty result has to be
  // an empty list rather than a crash
  const firstText = await w.webContents.executeJavaScript(
    '(()=>{const t=document.querySelector(".notes-text");return t?t.textContent.trim().slice(0,20):""})()'
  )
  const setNotesFilter = (v: string) =>
    w.webContents.executeJavaScript(
      '(()=>{const i=document.querySelector(".notes-bar input");if(!i)return 0;'
      + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
      + `set.call(i,${JSON.stringify(v)});i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
  await setNotesFilter('zzzz-no-such-annotation-zzzz')
  await new Promise((r) => setTimeout(r, 400))
  const nNone = await notesInfo()
  log('notes filtered to nothing', nNone)
  expect('filtering the annotation list can empty it', nNone.rows === 0, nNone)
  await setNotesFilter(firstText)
  await new Promise((r) => setTimeout(r, 400))
  const nHit = await notesInfo()
  log('notes filtered to a hit', nHit)
  expect('filtering the annotation list finds a known annotation', nHit.rows > 0, {
    firstText,
    nHit
  })
  await setNotesFilter('')
  await new Promise((r) => setTimeout(r, 400))
  // An annotation is the one thing here with no way back: there is no trash
  // for it and the cloud copy goes with it.  Deleting one has to ask, the
  // question has to say that, and saying no has to leave it alone.
  const annBefore = await w.webContents.executeJavaScript(
    '(async()=>(await window.api.loadAnnotations()).length)()'
  )
  const clickedDel = await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".notes-row button")]'
    + '.find(x=>x.textContent.trim()==="删除");if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 600))
  const delAsk = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({modal:!!document.querySelector(".confirm-modal"),'
      + 'text:(document.querySelector(".confirm-modal")||{}).textContent||null,'
      + 'focus:(document.activeElement||{}).textContent||null})'
    )
  )
  log('deleting an annotation', { clickedDel, delAsk })
  expect('deleting an annotation asks first', clickedDel === 1 && delAsk.modal === true, delAsk)
  expect(
    'the confirmation says there is no way back',
    /不可恢复/.test(delAsk.text ?? ''),
    delAsk
  )
  // the cursor starts on the safe answer, so a stray Enter does not delete
  expect('the safe button is the one focused', (delAsk.focus ?? '') === '取消', delAsk)
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".modal-acts button")]'
    + '.find(x=>x.textContent.trim()==="取消");if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 700))
  const annAfter = await w.webContents.executeJavaScript(
    '(async()=>(await window.api.loadAnnotations()).length)()'
  )
  log('annotations after cancelling', { annBefore, annAfter })
  expect('cancelling leaves the annotation alone', annBefore === annAfter, {
    annBefore,
    annAfter
  })
  // clicking one has to leave the list and open that paper at that page
  await w.webContents.executeJavaScript(
    '(()=>{const r=document.querySelector(".notes-row");if(!r)return 0;r.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 900))
  const nAfter = await notesInfo()
  log('after clicking an annotation', nAfter)
  expect('clicking an annotation opens its paper', nAfter.open === 0, nAfter)

  await w.webContents.executeJavaScript(
    '(async()=>await window.api.saveAnnotations(window.__before))()'
  )

  // document notes are local only, so a write / read / clear round trip here
  // touches nothing but notes.json and leaves it empty again
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pane-right button")]'
    + '.find(x=>x.textContent.trim()==="详情");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))
  // What a reference list actually prints.  The panel used to offer seven
  // fields, and the volume, the issue, the pages, the publisher, the link and
  // the keywords were not among them — so finding the volume of a paper meant
  // opening its PDF, which is the thing a details panel exists to save.
  //
  // The type is the one that must not be a text box: the API takes a fixed
  // vocabulary and rejects anything outside it, so offering a free field here
  // would hand the reader a way to write a value the cloud will refuse.  What
  // is checked is therefore not only that the field is there but that what it
  // offers is that vocabulary.
  const detFields = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const fs=[...document.querySelectorAll(".details .field")];'
      + 'const lab=f=>{const l=f.querySelector("label");return l?(l.textContent||"").trim():""};'
      + 'const at=n=>fs.find(f=>lab(f)===n);'
      + 'const kind=n=>{const f=at(n);if(!f)return null;'
      + 'const s=f.querySelector("select");'
      + 'return {has:!!(f.querySelector("input")||s),select:!!s,'
      + 'opts:s?[...s.options].map(o=>o.value):null}};'
      + 'return JSON.stringify({labels:fs.map(lab),type:kind("类型"),'
      + 'volume:!!at("卷"),issue:!!at("期"),pages:!!at("页码"),'
      + 'publisher:!!at("出版社 / 机构"),keywords:!!at("关键词（逗号分隔）"),'
      + 'url:!!at("链接")})})()'
    )
  )
  log('details fields', detFields)
  expect(
    'the panel carries the rest of the citation',
    detFields.volume &&
      detFields.issue &&
      detFields.pages &&
      detFields.publisher &&
      detFields.keywords &&
      detFields.url,
    detFields
  )
  expect(
    'the type is chosen from the vocabulary the API accepts',
    !!detFields.type?.select &&
      ['journal', 'thesis', 'generic'].every((t) => (detFields.type?.opts ?? []).includes(t)) &&
      (detFields.type?.opts ?? []).length === 14,
    detFields.type
  )
  const setNote = (v: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const t=document.querySelector("textarea.note-box");if(!t)return "no notes box";`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;`
      + `set.call(t,${JSON.stringify(v)});t.dispatchEvent(new Event("input",{bubbles:true}));`
      + `t.dispatchEvent(new FocusEvent("focusout",{bubbles:true}));return "ok"})()`
    )
  log('notes write', await setNote('smoke test note'))
  await new Promise((r) => setTimeout(r, 400))
  log(
    'notes read back',
    await w.webContents.executeJavaScript(
      '(async()=>{const n=await window.api.loadNotes();'
      + 'return JSON.stringify({keys:Object.keys(n).length,sample:Object.values(n)[0]||null})})()'
    )
  )
  // The list search has to reach a note the moment it is written, or the
  // thing the user typed about a paper is the one thing they cannot find
  // the paper by.  The filter is cleared afterwards.
  const noteSearch = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>{const i=document.querySelector(".toolbar input");'
      + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
      + 'set.call(i,"smoke test note");i.dispatchEvent(new Event("input",{bubbles:true}));'
      + 'await new Promise(r=>setTimeout(r,500));'
      // a search swaps the table for a card list; both are the same answer to
      // "was this document found?"
      + 'const rows=document.querySelectorAll("div.row, div.res-row").length;'
      + 'set.call(i,"");i.dispatchEvent(new Event("input",{bubbles:true}));'
      + 'await new Promise(r=>setTimeout(r,300));'
      + 'return JSON.stringify({rows})})()'
    )
  )
  log('note is searchable', noteSearch)
  expect('a note makes its document findable', noteSearch.rows > 0, noteSearch)

  await setNote('')
  await new Promise((r) => setTimeout(r, 400))
  log(
    'notes cleared',
    await w.webContents.executeJavaScript(
      '(async()=>{const n=await window.api.loadNotes();'
      + 'return JSON.stringify({keys:Object.keys(n).length})})()'
    )
  )
  // A paper with no file on disk used to be a single line saying so.  There
  // is always something to do about it — download it, or bring your own —
  // and which one applies depends on whether the cloud has a copy.
  //
  // This runs after everything that measures the reader, because it has to
  // select a paper that has no PDF in order to look at the empty pane.
  await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")]'
    + '.filter(e=>e.querySelector(".pdf-dot.no-pdf"));'
    + 'if(!r.length)return 0;r[0].click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pane-right .pane-head button")]'
    + '.find(x=>x.textContent.trim()==="PDF");if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  const noPdfPane = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({text:(document.querySelector(".pane-right .empty")||{}).textContent||null})'
    )
  )
  log('paper with no pdf', noPdfPane)
  expect(
    'a paper with no file says how to get one',
    /本地 PDF/.test(noPdfPane.text ?? '') && /下载|拖进窗口/.test(noPdfPane.text ?? ''),
    noPdfPane
  )

  // Full-text search, over the throwaway index the launcher keeps in
  // .ft-smoke/ so that neither the real index nor four minutes of PDF reading
  // are involved.  It runs last because it takes over the middle pane.
  //
  // The index on disk starts out written by an older version of the app, on
  // purpose: an update that changes how the index is stored cannot read it,
  // and "还没有索引" is not what happened — the reader already paid for that
  // build.  Written before anything asks for a status, because the entry
  // table is read once and kept.
  fs.writeFileSync(
    path.join(process.env.MENDELEY_FT_DIR || dataDir(), 'fulltext.json'),
    JSON.stringify({ version: 1, pages: 3, entries: {} })
  )
  log(
    'click 全文',
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
      + '.find(x=>x.textContent.trim()==="全文");if(!b)return "missing";b.click();return "ok"})()'
    )
  )
  await new Promise((r) => setTimeout(r, 600))
  const ftStat0 = JSON.parse(
    await w.webContents.executeJavaScript('(async()=>JSON.stringify(await window.api.ftStatus()))()')
  )
  log('ft status', ftStat0)
  expect('full text starts unindexed', ftStat0.indexed === 0 && ftStat0.total > 0, ftStat0)
  expect(
    'an index from an older version is not silently dropped',
    ftStat0.legacy === true,
    ftStat0
  )
  const ftLegacy = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({text:(document.querySelector(".pane-mid .empty")||{}).textContent||null})'
    )
  )
  log('ft with an index from an older version', ftLegacy)
  expect(
    'the panel says the build has to be done again',
    /重建/.test(ftLegacy.text ?? ''),
    ftLegacy
  )
  // Cleared so the rest of the run starts from an index that really is empty.
  // The panel reads the status out of React state, so leaving the pane and
  // coming back is what makes it ask for a fresh one — clearing it in the
  // main process alone leaves the old words on screen.
  await w.webContents.executeJavaScript('(async()=>await window.api.ftClear())()')
  await new Promise((r) => setTimeout(r, 200))
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pane-head button")]'
    + '.find(x=>x.textContent.trim()==="返回列表");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
    + '.find(x=>x.textContent.trim()==="全文");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 600))
  // "0 / 5648" and a button called 建索引 in the header is a riddle: the
  // panel has to say that reading every paper is what stands between the
  // search and any results, and how long that takes.
  const ftEmpty = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({text:(document.querySelector(".pane-mid .empty")||{}).textContent||null,'
      + 'btns:[...document.querySelectorAll(".pane-mid .empty button")]'
      + '.map(b=>b.textContent)})'
    )
  )
  log('ft before building', ftEmpty)
  expect(
    'an unindexed library offers to build the index',
    /还没有索引/.test(ftEmpty.text ?? '') &&
      (ftEmpty.btns ?? []).some((t: string) => /建索引/.test(t)),
    ftEmpty
  )
  // The word is typed *before* the index exists, which is the order it
  // happens in: search, get nothing back, press 建索引, wait.  A search is
  // only run when the words change, so unless the index finishing is what
  // runs it again, the answer left on screen is the one from before the
  // build — "正文里没找到" over a library that has since been read whole.
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".toolbar input");'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"the");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 1000))
  const ftBefore = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({rows:document.querySelectorAll(".ft-row").length,'
      + 'empty:(document.querySelector(".pane-mid .empty")||{}).textContent||null})'
    )
  )
  log('ft searched before the index exists', ftBefore)
  expect(
    'a search made before the index exists comes back empty',
    ftBefore.rows === 0,
    ftBefore
  )
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pane-head button")]'
    + '.find(x=>x.textContent.trim()==="建索引");if(!b)return 0;b.click();return 1})()'
  )
  // small list, but still a real read of real PDFs, so poll rather than guess.
  // Polled fast on purpose: the whole complaint being fixed is that the build
  // looked frozen, so what matters is not only that it finishes but that it
  // says which file it is on while it runs.
  let ftStat1 = ftStat0
  const seenDone = new Set<number>()
  let sawCurrent = ''
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 200))
    ftStat1 = JSON.parse(
      await w.webContents.executeJavaScript(
        '(async()=>JSON.stringify(await window.api.ftStatus()))()'
      )
    )
    seenDone.add(ftStat1.done)
    if (ftStat1.current) sawCurrent = ftStat1.current
    if (!ftStat1.building) break
  }
  log('ft after build', ftStat1, { steps: [...seenDone], current: sawCurrent })
  expect('indexing reads the PDFs', ftStat1.indexed > 0, ftStat1)
  expect('progress counted every document', ftStat1.done === ftStat1.total, ftStat1)
  expect('progress names the file being read', sawCurrent.length > 0, sawCurrent)
  // The same run, judged from the other side: a build that read thousands of
  // papers is working, so it must not come back saying pdf.js could not
  // start.  That claim is only made when a run reads nothing at all — one
  // corrupt file out of five thousand is not a broken install.
  expect('a run that read papers does not blame the install', ftStat1.reader == null, ftStat1)
  // Stopping has to be safe to press at any time, including after the run has
  // already finished: what was read stays readable.
  const ftCancelStat = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>JSON.stringify(await window.api.ftCancel()))()'
    )
  )
  log('ft cancel', ftCancelStat)
  expect(
    'stopping keeps what was already read',
    ftCancelStat.indexed === ftStat1.indexed && !ftCancelStat.building,
    { ftCancelStat, ftStat1 }
  )
  // No word is typed here.  The one typed above is still in the box; if rows
  // appear now it is because the finished index was what ran the search
  // again, which is the whole of what is being checked.
  await new Promise((r) => setTimeout(r, 1200))
  const ftRows = await w.webContents.executeJavaScript(
    'JSON.stringify({rows:document.querySelectorAll(".ft-row").length,'
    + 'hits:document.querySelectorAll(".ft-hit").length,'
    + 'pages:[...document.querySelectorAll(".ft-hit .pg")].slice(0,3).map(p=>p.textContent),'
    + 'snip:(document.querySelector(".ft-snip")||{}).textContent||null})'
  )
  log('ft results', ftRows)
  const ftOut = JSON.parse(ftRows)
  expect(
    'the search runs again once the index exists',
    ftOut.rows > 0 && ftOut.hits > 0,
    ftOut
  )
  expect('a hit carries a page number', /^p\d+$/.test(ftOut.pages[0] ?? ''), ftOut.pages)

  // Seventy-eight rows on screen is not proof that the text was read, only
  // that some string matched somewhere.  An index that wrote the same paper
  // into twenty slots, or one that kept the offsets of a table it no longer
  // matches, would both report themselves complete and both show a full page
  // of rows.  So the index is checked against what it claims to have read:
  // one entry per document, none of them empty or a copy of another, every
  // one pointing at a file that is still there, and every hit landing inside
  // the stretch of text belonging to the paper it is shown under.
  const ftDir = process.env.MENDELEY_FT_DIR || dataDir()
  const mt = JSON.parse(
    fs.readFileSync(path.join(ftDir, 'fulltext.json'), 'utf8')
  ) as {
    entries: Record<
      string,
      { start: number; len: number; bounds: number[]; size: number; file?: string }
    >
  }
  const body = fs.readFileSync(path.join(ftDir, 'fulltext.dat'), 'utf8')
  const es = Object.entries(mt.entries)
  const heads = new Set(es.map(([, e]) => body.slice(e.start, e.start + 200)))
  const files = es.filter(([, e]) => e.file).map(([, e]) => {
    try {
      return fs.statSync(e.file as string).size === e.size
    } catch {
      return false
    }
  })
  const lens = es.map(([, e]) => e.len).sort((a, b) => a - b)
  const hits = ftSearch('the')
  // the word has to be findable in the stretch of text the entry claims for
  // that paper, which is the one thing a scrambled offset table cannot fake
  const inDoc = hits.filter((h) => {
    const e = mt.entries[h.docId]
    return !!e && body.slice(e.start, e.start + e.len).toLowerCase().includes('the')
  })
  const paged = hits.filter((h) => {
    const e = mt.entries[h.docId]
    return !!e && h.page >= 1 && h.page <= Math.max(1, e.bounds.length)
  })
  const ftAudit = {
    entries: es.length,
    uniqueHeads: heads.size,
    empty: es.filter(([, e]) => e.len <= 0).length,
    shortest: lens[0] ?? 0,
    median: lens[Math.floor(lens.length / 2)] ?? 0,
    longest: lens[lens.length - 1] ?? 0,
    filesChecked: files.length,
    filesMatching: files.filter(Boolean).length,
    hits: hits.length,
    hitsInTheirOwnText: inDoc.length,
    hitsPaged: paged.length,
    chars: body.length
  }
  log('ft index audited', ftAudit)
  expect(
    'every indexed document is there exactly once',
    ftAudit.entries > 0 && ftAudit.uniqueHeads === ftAudit.entries && ftAudit.empty === 0,
    ftAudit
  )
  expect('an indexed document has real text in it', ftAudit.shortest > 100, ftAudit)
  expect(
    'every entry still points at its own file',
    ftAudit.filesChecked > 0 && ftAudit.filesMatching === ftAudit.filesChecked,
    ftAudit
  )
  expect(
    'the word is in the text of the paper each hit is shown under',
    ftAudit.hits > 0 && ftAudit.hitsInTheirOwnText === ftAudit.hits,
    ftAudit
  )
  expect('every hit names a page that paper has', ftAudit.hitsPaged === ftAudit.hits, ftAudit)
  // what was read, so that the numbers above can be checked against the PDFs
  log(
    'ft sample',
    es.slice(0, 3).map(([id, e]) => ({
      id,
      file: e.file,
      len: e.len,
      head: body.slice(e.start, e.start + 120).replace(/\s+/g, ' ')
    }))
  )
  // opening a hit has to land on the page the hit named
  const wantPage = Number((ftOut.pages[0] ?? 'p1').slice(1))
  await w.webContents.executeJavaScript(
    '(()=>{const r=document.querySelector(".ft-hit");if(r)r.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 1500))
  const landed = await w.webContents.executeJavaScript(
    'document.querySelector(".pdf-bar input").value'
  )
  log('ft open at page', { want: wantPage, got: landed })
  expect('opening a hit jumps to its page', Number(landed) === wantPage, { want: wantPage, got: landed })

  // The word the list was searched for has to be found again inside the
  // paper.  A hit in the list is a claim about the paper, and the paper is
  // where that claim has to be checkable: without the marks, finding the word
  // again in a thirty-page PDF is exactly the work the search was meant to
  // save.
  //
  // What is checked is not only that something is marked but that the whole
  // file was walked.  Marks on the page landed on alone would prove nothing —
  // the list already said which page to look at — so the scan has to have
  // reached pages the reader is not on, which shows up as hits on more than
  // one page.
  let marked = { hits: 0, pages: 0, onScreen: 0, box: 0 }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    marked = JSON.parse(
      await w.webContents.executeJavaScript(
        'JSON.stringify({hits:Number(document.documentElement.dataset.findHits||0),'
        + 'pages:Number(document.documentElement.dataset.findPages||0),'
        + 'onScreen:document.querySelectorAll(".find-hit").length,'
        + 'box:document.querySelectorAll(".pdf-find").length})'
      )
    )
    if (marked.hits > 0) break
  }
  log('ft term marked in the paper', marked)
  expect(
    'opening a hit marks the word in the paper',
    marked.hits > 0 && marked.onScreen > 0,
    marked
  )
  expect('the whole paper was walked, not only the page landed on', marked.pages > 1, marked)
  // An orange box on the page with nothing saying which word it belongs to is
  // worse than no box, so the marks come with the find bar that names them.
  expect('the marks come with a box saying which word they belong to', marked.box === 1, marked)
  // And they must not cost the reader the page: the hit named one, and the
  // scan coming across an earlier occurrence is not a reason to be moved to
  // it.  Read after the scan has finished, which is the only moment it could
  // have moved anything.
  const stillAt = await w.webContents.executeJavaScript(
    'document.querySelector(".pdf-bar input").value'
  )
  log('page after the scan', { want: wantPage, got: stillAt })
  expect(
    'marking the word leaves the reader on the hit they opened',
    Number(stillAt) === wantPage,
    { want: wantPage, got: stillAt }
  )
  // Shutting the box has to take its marks with it, otherwise the page keeps
  // a highlight nothing accounts for.
  await w.webContents.executeJavaScript(
    '(()=>{const b=document.querySelector(\'.pdf-find button[title^="关闭"]\');'
    + 'if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 500))
  const afterClose = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({hits:Number(document.documentElement.dataset.findHits||0),'
      + 'onScreen:document.querySelectorAll(".find-hit").length,'
      + 'box:document.querySelectorAll(".pdf-find").length})'
    )
  )
  log('after closing the find box', afterClose)
  expect(
    'shutting the box takes its marks with it',
    afterClose.box === 0 && afterClose.onScreen === 0 && afterClose.hits === 0,
    afterClose
  )
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pane-head button")]'
    + '.find(x=>x.textContent.trim()==="返回列表");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))

  // A hit is not necessarily a row in the catalogue.  Full-text search
  // answers from the whole corpus, so the paper it finds is very often one
  // the catalogue query does not list: the word is in that paper's text and
  // not in its title.  The right-hand pane resolved the selection against the
  // filtered list alone, so clicking such a hit selected a paper the pane
  // could not find, and the pane went back to asking to be given one — the
  // click appeared to do nothing.
  //
  // Reproduced by narrowing the catalogue to nothing and then opening a hit:
  // whatever paper the hit belongs to, it is not in the list.  The word in
  // the full-text box is left alone, so the hits are still there.
  const setInput = (sel: string, v: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const i=document.querySelector(${JSON.stringify(sel)});if(!i)return 0;`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
      + `set.call(i,${JSON.stringify(v)});`
      + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
  await setInput('.toolbar input', 'zzzzqqq')
  await new Promise((r) => setTimeout(r, 800))
  const narrowRows = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({rows:document.querySelectorAll("div.row").length,'
      + 'q:document.querySelector(".toolbar input").value})'
    )
  )
  log('catalogue narrowed', narrowRows)
  expect('the word narrows the catalogue to nothing', narrowRows.rows === 0, narrowRows)
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
    + '.find(x=>x.textContent.trim()==="全文");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 1500))
  const away = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({hits:document.querySelectorAll(".ft-hit").length,'
      + 'word:document.querySelector(".toolbar input").value})'
    )
  )
  log('hits while the catalogue lists nothing', away)
  expect('the hits survive a catalogue that lists nothing', away.hits > 0, away)
  await w.webContents.executeJavaScript(
    '(()=>{const r=document.querySelector(".ft-hit");if(r)r.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 2000))
  const awayPane = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({empty:(document.querySelector(".pane-right .empty")||{}).textContent||null,'
      + 'pdf:!!document.querySelector(".pdf-bar input"),'
      + 'det:!!document.querySelector(".pane-right .det, .pane-right .details, .pane-right table")})'
    )
  )
  log('pane after opening a hit the catalogue does not list', awayPane)
  expect(
    'opening a hit fills the pane even when the catalogue does not list it',
    awayPane.empty === null && (awayPane.pdf === true || awayPane.det === true),
    awayPane
  )
  // Full-text results are a list of papers too, and a control labelled 排序
  // has to mean the same thing whichever list it is looking at.  Ordered by
  // year, because the order the index happens to hold — the order the papers
  // were read in — is the one order that cannot come out right by accident.
  const ftYears = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        'JSON.stringify([...document.querySelectorAll(".ft-row .ft-meta")]'
        + '.map(e=>parseInt((e.textContent||"").replace(/[^0-9]/g,"").slice(0,4),10))'
        + '.filter(n=>n>1900&&n<2100))'
      )
    )
  const openSort = async () => {
    const n = await w.webContents.executeJavaScript(
      'document.querySelectorAll(".sort-pick").length'
    )
    // pressing the button while the card is up would close it, and the press
    // on a row that followed would quietly do nothing
    if (Number(n) > 0) return
    await toolbarBtn('排序')
    await new Promise((r) => setTimeout(r, 350))
  }
  await openSort()
  // a press on the key the list is already sorted by turns the direction
  // instead of asking for it, and the default with nothing saved is the year —
  // so the year goes on by way of another key first, otherwise the first list
  // read here would be the oldest-first one and the two would swap places
  await pickSort('title')
  await new Promise((r) => setTimeout(r, 400))
  await pickSort('year')
  await new Promise((r) => setTimeout(r, 800))
  const ftNewest = await ftYears()
  log('full-text results, newest first', ftNewest)
  expect('the full-text list has rows to order', ftNewest.length > 1, ftNewest)
  await pickSort('year')
  await new Promise((r) => setTimeout(r, 800))
  const ftOldest = await ftYears()
  log('full-text results, oldest first', ftOldest)
  expect(
    'full-text results answer to the same order',
    ftOldest.length > 1 && ftOldest[0] < ftNewest[0],
    { newest: ftNewest[0], oldest: ftOldest[0] }
  )
  // The sort is put back the way the run found it, and without a reload:
  // the checks that follow read the full-text panel, which a reload would
  // close.  One press picks the key at its own direction; a second one flips
  // it, which is what it takes when the direction wanted is the other one.
  const wantSort = sort0 ?? { key: 'year', dir: -1 }
  await pickSort(wantSort.key)
  await new Promise((r) => setTimeout(r, 400))
  if ((await sortCfg())?.dir !== wantSort.dir) {
    await pickSort(wantSort.key)
    await new Promise((r) => setTimeout(r, 400))
  }
  log('sort put back', await sortCfg())
  await w.webContents.executeJavaScript(
    '(()=>{const b=document.querySelector(\'.filter-menu button[title="关闭"]\');'
    + 'if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))

  // back to the catalogue, and the word put back the way the run found it
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pane-head button")]'
    + '.find(x=>x.textContent.trim()==="返回列表");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  await setInput('.toolbar input', '')
  await new Promise((r) => setTimeout(r, 600))

  // Continuous scrolling keeps its own record of what it has painted, and
  // that record is what a scroll does not repaint everything it passes over.
  // The record is keyed by page, scale and pixel ratio, and for a long time
  // by nothing else — so another paper opened at the same zoom found every
  // page already down as painted, returned before touching a canvas, and put
  // a black column in front of the reader.  The pages were laid out at their
  // full height and the scroll bar was the right length; there was simply no
  // paper on any of them.  A search makes it the ordinary way to read, since
  // opening one hit after another is exactly switching papers with the zoom
  // held still.
  //
  // What is measured is ink, not existence: the column that failed had all of
  // its canvases, at their old size, and only reading the pixels tells the
  // difference between "painted" and "believes it painted".
  const contInk = () =>
    w.webContents.executeJavaScript(
      '(()=>{const e=document.querySelector(".pdf-cont");'
      + 'const wraps=[...document.querySelectorAll(".pg-wrap")];'
      + 'let ink=0;'
      + 'for(const c of wraps.map(w=>w.querySelector("canvas")).filter(Boolean)){'
      + 'try{if(!c.width||!c.height)continue;'
      + 'const d=c.getContext("2d").getImageData(0,0,'
      + 'Math.min(c.width,80),Math.min(c.height,80)).data;'
      + 'let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;'
      + 'if(n>16)ink++}catch(x){/* a canvas that will not give up its pixels */}}'
      + 'return JSON.stringify({cont:!!e,wraps:wraps.length,ink:ink,'
      + 'scrollH:e?Math.round(e.scrollHeight):-1})})()'
    )
  const backToList = async () => {
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".pane-head button")]'
      + '.find(x=>x.textContent.trim()==="返回列表");if(b)b.click();return 1})()'
    )
    await new Promise((r) => setTimeout(r, 500))
  }
  const openRowWithPdf = (which: number) =>
    w.webContents.executeJavaScript(
      `(()=>{const r=[...document.querySelectorAll("div.row")]`
      + `.filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));`
      + `if(r.length<2)return "too few rows with a pdf";`
      + `const t=r[Math.min(${which},r.length-1)];t.click();`
      + `return t.innerText.replace(/\\n/g," | ").slice(0,60)})()`
    )
  await openRowWithPdf(0)
  await new Promise((r) => setTimeout(r, 4000))
  log('click 连续 (switching papers)', await clickBar('连续'))
  await new Promise((r) => setTimeout(r, 3000))
  const inkFirst = JSON.parse(await contInk())
  log('continuous on the first paper', inkFirst)
  expect('continuous puts ink on the paper it was turned on for', inkFirst.ink > 0, inkFirst)
  await backToList()
  log('switching to another paper', await openRowWithPdf(1))
  await new Promise((r) => setTimeout(r, 5000))
  const inkSecond = JSON.parse(await contInk())
  log('continuous on the next paper', inkSecond)
  expect(
    'continuous puts ink on the paper it was switched to',
    inkSecond.cont && inkSecond.wraps > 0 && inkSecond.ink > 0,
    inkSecond
  )
  // the mode is put back: it lives in the config, and a smoke run has no
  // business leaving the reader rearranged
  log('click 连续 (back off)', await clickBar('连续'))
  await new Promise((r) => setTimeout(r, 1000))
  await backToList()

  // A run that finishes having read nothing is not a library that has never
  // been indexed, and it must not be reported in the same words.  Both leave
  // `indexed` at zero; only one of them has an answer to "why".  Six papers
  // whose PDF is no longer where the library thinks it is is the ordinary
  // shape of it: the directory was moved, a disk was renamed, the files were
  // tidied away.  Every one of them fails the stat, so the run ends having
  // counted six papers and read none — and what used to greet that was
  // "还没有索引", inviting the reader to spend the same minutes again.
  const staleDir = path.join(app.getPath('temp'), `mendeley-ng-ft-gone-${Date.now()}`)
  const staleDocs = ftDocs()
    .filter((d) => d.localPdf)
    .slice(0, 6)
    .map((d) => ({ ...d, localPdf: path.join(staleDir, `${d.id}.pdf`) }))
  let staleInfo: {
    ok: boolean
    indexed?: number
    done?: number
    skipped?: number
    why?: string
    said?: string | null
    reasons?: string[]
  } = { ok: false }
  if (staleDocs.length >= 3) {
    ftClear()
    const staleStat = await ftBuild(staleDocs, () => undefined, true)
    staleInfo = {
      ok: true,
      indexed: staleStat.indexed,
      done: staleStat.done,
      skipped: staleStat.skipped.length,
      why: staleStat.skipped[0]?.why ?? ''
    }
    // the panel asks for a status when it is opened, so leaving the pane and
    // coming back is what makes it pick up a run that ended this way
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
      + '.find(x=>x.textContent.trim()==="全文");if(b)b.click();return 1})()'
    )
    await new Promise((r) => setTimeout(r, 700))
    const stalePanel = JSON.parse(
      await w.webContents.executeJavaScript(
        'JSON.stringify({text:(document.querySelector(".pane-mid .empty")||{}).textContent||null,'
        + 'reasons:[...document.querySelectorAll(".ft-skipped .ft-skip")].map(s=>s.textContent)})'
      )
    )
    staleInfo.said = stalePanel.text
    staleInfo.reasons = stalePanel.reasons
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".pane-head button")]'
      + '.find(x=>x.textContent.trim()==="返回列表");if(b)b.click();return 1})()'
    )
    await new Promise((r) => setTimeout(r, 400))
  }
  log('a run that read nothing', staleInfo)
  expect(
    'a run that read nothing is finished rather than unstarted',
    staleInfo.ok === true &&
      staleInfo.indexed === 0 &&
      (staleInfo.done ?? 0) > 0 &&
      (staleInfo.skipped ?? 0) > 0,
    staleInfo
  )
  expect(
    'a paper whose file is gone is skipped with a reason',
    staleInfo.why === '文件不在原处',
    staleInfo
  )
  expect(
    'the panel reports the run that finished, not an unindexed library',
    /读完了，但一篇正文都没读出来/.test(staleInfo.said ?? '') &&
      !/还没有索引/.test(staleInfo.said ?? ''),
    staleInfo
  )
  expect(
    'the reason reaches the screen',
    (staleInfo.reasons ?? []).some((t) => /文件不在原处/.test(t)),
    staleInfo.reasons
  )
  ftClear()
  fs.rmSync(staleDir, { recursive: true, force: true })

  // pdf.js reads every PDF in a worker thread that has to be copied next to
  // the bundled main process.  `dist` used to skip that step, so the packaged
  // app had no worker at all and every document failed with "Setting up fake
  // worker failed" — reported as thousands of rows of "PDF 打不开" over files
  // that open fine in a reader.  A smoke run is built with `npm run build`,
  // which does copy it, so reading a PDF here can never catch this: only
  // looking for the file, and at the command that was meant to put it there,
  // can.  The indexer now also says what the reader actually said rather than
  // blaming each paper, and that is asserted further down.
  const rootDir = app.getAppPath()
  let workerInfo: { ok: boolean; bytes?: number; big?: boolean; script?: string } = {
    ok: false
  }
  try {
    const st = fs.statSync(path.join(rootDir, 'out', 'main', 'pdf.worker.mjs'))
    const pkg = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> }
    workerInfo = {
      ok: true,
      bytes: st.size,
      // the real worker is about a megabyte; a stub would read fine here
      big: st.size > 100_000,
      script: pkg.scripts?.dist ?? ''
    }
  } catch {
    /* not laid out the way this run expects */
  }
  log('pdf.js worker', workerInfo)
  expect(
    "the build carries pdf.js's worker",
    workerInfo.ok === true && workerInfo.big === true,
    workerInfo
  )
  expect(
    'packaging is told to copy it',
    /copy-worker/.test(workerInfo.script ?? ''),
    workerInfo
  )

  // An interrupted run is the ordinary case, not the exception: reading 5245
  // papers takes minutes and nobody leaves the app open for all of it.  What
  // an unfinished batch leaves is text past the end of what the entry table
  // describes, and appending to that used to record the next papers at
  // offsets behind their own text.  The table then stopped being sorted by
  // offset, the lookup behind every hit went astray, and an index that
  // reported itself complete returned nothing.  The gap is written here by
  // hand, because waiting for a real six-minute build to be interrupted is
  // not something a smoke run can do.
  const ftDat = path.join(ftDir, 'fulltext.dat')
  const ftJson = path.join(ftDir, 'fulltext.json')
  const allPdf = ftDocs().filter((d) => d.localPdf)
  let resumed: {
    ok: boolean
    contiguous?: boolean
    covers?: boolean
    bytesMatch?: boolean
    hits?: number
  } = { ok: false }
  if (allPdf.length >= 20) {
    ftClear()
    await ftBuild(allPdf.slice(0, 10), () => undefined, true)
    fs.appendFileSync(ftDat, Buffer.alloc(20_000, 0x20))
    const stat2 = await ftBuild(allPdf.slice(10, 20), () => undefined, false)
    const body = fs.readFileSync(ftDat, 'utf8')
    const mt = JSON.parse(fs.readFileSync(ftJson, 'utf8'))
    const sorted = Object.entries(mt.entries as Record<string, { start: number; len: number }>)
      .sort((a, b) => a[1].start - b[1].start)
    let covered = 0
    let contiguous = true
    for (const [, e] of sorted) {
      if (e.start !== covered) contiguous = false
      covered = e.start + e.len
    }
    resumed = {
      ok: true,
      contiguous,
      // the whole file has to be accounted for by the table: anything past
      // the end is text no paper can be found in
      covers: covered === body.length,
      bytesMatch: fs.statSync(ftDat).size === mt.bytes,
      hits: ['the', 'of', 'and', 'in'].reduce((n, w) => n + ftSearch(w).length, 0)
    }
    log('index resumed after an interrupted run', { ...resumed, stat: stat2.indexed })
  }
  expect('an interrupted run leaves an index that still works', resumed.ok === true, resumed)
  expect('the entry table stays contiguous', resumed.contiguous === true, resumed)
  expect('nothing in the text file is unaccounted for', resumed.covers === true, resumed)
  expect('the byte anchor matches the file', resumed.bytesMatch === true, resumed)
  expect('a resumed index still finds things', (resumed.hits ?? 0) > 0, resumed)
  // the next check wants an empty index, and this one leaves twenty papers
  ftClear()

  // Batch metadata editing.  The dialog is checked without applying it:
  // PATCHing real documents is not something a smoke run should do, so what
  // is proved here is that the dialog opens for the selection, offers the
  // fields, and will not run until a value has been given.
  await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")];'
    + 'if(r.length<2)return 0;r[0].click();'
    + 'r[1].dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 500))
  const multiInfo = await w.webContents.executeJavaScript(
    'JSON.stringify({bar:document.querySelectorAll(".batch-bar").length,'
    + 'text:(document.querySelector(".batch-bar span")||{}).textContent||null})'
  )
  log('multi select', multiInfo)
  expect('ctrl-click builds a multi-selection', /已选 2 条/.test(multiInfo), multiInfo)
  // Batch download.  What is checked is the offer and not the download:
  // actually pulling files from the cloud writes them into the library and
  // needs a token, and neither is this run's to do.  What has to be right is
  // the number on the button, because a batch that quietly fetched three of
  // the two hundred it was handed did something other than what it said.
  //
  // The number is counted against the selected rows' own PDF dots rather than
  // against itself: a button that agreed with its own arithmetic would prove
  // nothing at all.
  const dlOffer = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const bs=[...document.querySelectorAll(".batch-bar button")]'
      + '.filter(b=>(b.textContent||"").trim().startsWith("下载 PDF"));'
      + 'return JSON.stringify({btn:bs.length?bs[0].textContent.trim():null,'
      + 'disabled:bs.length?bs[0].disabled:null,'
      + 'selected:document.querySelectorAll("div.row.multi").length,'
      + 'cloudOnly:[...document.querySelectorAll("div.row.multi .pdf-dot")]'
      + '.filter(d=>(d.getAttribute("title")||"")==="云端有文件").length})})()'
    )
  )
  log('batch download offer', dlOffer)
  expect('the batch bar offers to download the missing PDFs', dlOffer.btn !== null, dlOffer)
  const offered = /（(\d+)）/.exec(dlOffer.btn ?? '')
  expect(
    'the offer names how many of the selection it would fetch',
    dlOffer.cloudOnly === 0
      ? dlOffer.disabled === true && offered === null
      : offered !== null && Number(offered[1]) === dlOffer.cloudOnly,
    dlOffer
  )
  log(
    'click 改字段',
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".batch-bar button")]'
      + '.find(x=>x.textContent.includes("改字段"));if(!b)return "missing";b.click();return "ok"})()'
    )
  )
  await new Promise((r) => setTimeout(r, 400))
  const beInfo = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        '(()=>{const m=document.querySelector(".batch-edit");if(!m)return JSON.stringify({open:0});'
        + 'const b=[...m.querySelectorAll("button")].find(x=>x.textContent.includes("应用到"));'
        + 'return JSON.stringify({open:1,ops:[...m.querySelectorAll("select")][0]'
        + '?[...m.querySelectorAll("select")][0].options.length:0,'
        + 'apply:b?b.textContent.trim():null,disabled:b?b.disabled:null})})()'
      )
    )
  const be0 = await beInfo()
  log('batch edit', be0)
  expect('the batch edit dialog opens', be0.open === 1, be0)
  expect('it offers every field', be0.ops >= 5, be0)
  expect('it names the batch size', /应用到 2 条/.test(String(be0.apply)), be0)
  expect('it will not run without a value', be0.disabled === true, be0)
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".batch-edit input");if(!i)return 0;'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"smoke-tag");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))
  const be1 = await beInfo()
  log('batch edit with a value', be1)
  expect('it runs once a value is given', be1.disabled === false, be1)
  // cancel rather than apply, then drop the selection: nothing was written
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".batch-edit button")]'
    + '.find(x=>x.textContent.trim()==="取消");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))
  expect('cancelling closes the dialog', (await beInfo()).open === 0, be1)

  // Duplicates the reader has already judged.  Two papers sharing a title are
  // very often two papers — a submission and its rebuttal, a paper and its
  // extended version — and a list that reports the same handful every time
  // it is opened teaches the reader to stop opening it.  So a group can be
  // put aside, and putting it aside must be reversible: a convenience that
  // only goes one way is how a decision gets lost.
  //
  // The library is real, so whether there is any group at all is not this
  // run's to decide; what is checked is that the group count and the
  // "not a duplicate" count move together, and that restoring puts back
  // exactly what was put aside.
  const dupeInfo = () =>
    w.webContents.executeJavaScript(
      'JSON.stringify({open:document.querySelectorAll(".dupe-group").length,'
      + 'gone:document.querySelectorAll(".dupe-group.dupe-gone").length,'
      + 'aside:(document.querySelector(\'.pane-head button[title*="不是重复"]\')||{}).textContent||null,'
      + 'empty:(document.querySelector(".pane-mid .empty")||{}).textContent||null,'
      + 'said:(document.querySelector(".pane-head span[style]")||{}).textContent||null})'
    )
  await openMenu('更多')
  await new Promise((r) => setTimeout(r, 300))
  log('click 查重', await clickMenu('查重'))
  await new Promise((r) => setTimeout(r, 4000))
  const dBefore = JSON.parse(await dupeInfo())
  log('duplicates', dBefore)
  if (!dBefore.open) {
    log('no duplicate groups in this library; the ignore path cannot be walked')
    expect(
      'a library with no duplicates says so',
      /没有发现重复/.test(dBefore.empty ?? ''),
      dBefore
    )
  } else {
    const pressAside = () =>
      w.webContents.executeJavaScript(
        '(()=>{const g=document.querySelector(".dupe-group:not(.dupe-gone)");'
        + 'if(!g)return 0;const b=[...g.querySelectorAll(".dupe-head button")]'
        + '.find(x=>x.textContent.trim()==="不是重复");if(!b)return 0;b.click();return 1})()'
      )
    const pressBack = () =>
      w.webContents.executeJavaScript(
        '(()=>{const g=document.querySelector(".dupe-group.dupe-gone");'
        + 'if(!g)return 0;const b=[...g.querySelectorAll(".dupe-head button")]'
        + '.find(x=>x.textContent.trim().indexOf("撤销")===0);if(!b)return 0;b.click();return 1})()'
      )
    expect('a group can be put aside', (await pressAside()) === 1, dBefore)
    await new Promise((r) => setTimeout(r, 500))
    const dAside = JSON.parse(await dupeInfo())
    log('after putting one aside', dAside)
    expect(
      'putting a group aside takes it off the list',
      dAside.open === dBefore.open - 1 && /1 组/.test(dAside.aside ?? ''),
      { before: dBefore.open, after: dAside }
    )
    // and it comes back: dimmed, and only because it was asked for
    await w.webContents.executeJavaScript(
      '(()=>{const b=document.querySelector(\'.pane-head button[title*="不是重复"]\');'
      + 'if(!b)return 0;b.click();return 1})()'
    )
    await new Promise((r) => setTimeout(r, 400))
    const dShown = JSON.parse(await dupeInfo())
    log('the aside group, asked for', dShown)
    expect(
      'a group put aside is still there, only dimmed',
      dShown.open === dBefore.open && dShown.gone === 1,
      dShown
    )
    // the decision is written through: a dismissal that came back on Monday
    // would be the same list the reader stopped opening
    const ignoreCfg = JSON.parse(
      await w.webContents.executeJavaScript(
        '(async()=>{const c=await window.api.getConfig();'
        + 'return JSON.stringify(c.dupeIgnores||null)})()'
      )
    )
    log('the ignore list as saved', ignoreCfg)
    expect(
      'the decision is remembered rather than just hidden',
      Array.isArray(ignoreCfg) && ignoreCfg.length === 1 && ignoreCfg[0].length > 1,
      ignoreCfg
    )
    expect('a group put aside can be brought back', (await pressBack()) === 1, dShown)
    await new Promise((r) => setTimeout(r, 500))
    const dBack = JSON.parse(await dupeInfo())
    log('after undoing it', dBack)
    expect(
      'undoing puts the group back and the count with it',
      dBack.open === dBefore.open && dBack.gone === 0,
      { before: dBefore.open, back: dBack }
    )
    const clearedCfg = JSON.parse(
      await w.webContents.executeJavaScript(
        '(async()=>{const c=await window.api.getConfig();'
        + 'return JSON.stringify(c.dupeIgnores||null)})()'
      )
    )
    expect('undoing clears what was remembered', !clearedCfg || clearedCfg.length === 0, clearedCfg)
  }
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pane-head button")]'
    + '.find(x=>x.textContent.trim()==="返回库");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".batch-bar button")]'
    + '.find(x=>x.textContent.trim()==="取消选择");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))

  // Ctrl+A is what everybody presses first when they want the whole result,
  // and it used to do nothing at all; Esc is what they press to get out of a
  // multi-selection, and it used to need the mouse.  What is checked is not
  // just that they work but that they mean the right thing: "all" is what the
  // list is showing, not the whole library, and inside the search box Ctrl+A
  // still has to mean the text that was typed.
  const counts = async () =>
    JSON.parse(
      await w.webContents.executeJavaScript(
        // the count of what is on screen over the size of the library; there
        // is more than one badge in the chrome, so the one that reads as a
        // fraction is the one asked for
        '(()=>{const b=[...document.querySelectorAll(".badge")]'
        + '.map(e=>e.textContent||"").find(t=>/\\d+\\s*\\/\\s*\\d+/.test(t))||"";'
        + 'const m=b.match(/(\\d+)\\s*\\/\\s*(\\d+)/);'
        + 'const t=(document.querySelector(".batch-bar span")||{}).textContent||"";'
        + 'const n=t.match(/(\\d+)/);'
        + 'return JSON.stringify({shown:m?+m[1]:0,all:m?+m[2]:0,'
        + 'bar:!!document.querySelector(".batch-bar"),n:n?+n[1]:0,'
        // a search swaps the table for a card list, and both are rows: what is
        // being counted is how many are selected, not which shape they are
        + 'sel:document.querySelectorAll("div.row.sel, div.res-row.sel").length})})()'
      )
    )
  const typeQuery = (q: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const i=document.querySelector("input");if(!i)return 0;`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
      + `set.call(i,${JSON.stringify(q)});`
      + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
  const keyOn = (target: string, key: string, ctrl: boolean) =>
    w.webContents.executeJavaScript(
      `(()=>{const el=${target};if(!el)return 0;`
      + `el.dispatchEvent(new KeyboardEvent("keydown",{key:${JSON.stringify(key)},`
      + `ctrlKey:${ctrl},bubbles:true,cancelable:true}));return 1})()`
    )
  await w.webContents.executeJavaScript(
    '(()=>{const f=[...document.querySelectorAll(".folder-row")]'
    + '.find(e=>((e.querySelector(".name")||{}).textContent||"").includes("全部文献"));'
    + 'if(f)f.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 500))
  // words out of the first rows, tried until one narrows the list to more
  // than one paper but not the whole library: with everything on screen there
  // is no way to tell "all that is shown" from "all there is", and a single
  // hit is not a multi-selection, so the bar being looked for would not
  // appear.
  //
  // The word also has to land in a field other than the title and the
  // authors, because naming that field is most of what the cards are for: a
  // word that only ever matches an author gives cards with no field on them,
  // and the card then looks like it matched and declined to say where.  Which
  // word that is depends entirely on which paper happens to be first — the
  // library is synced live, so it is not the same paper twice — and a check
  // that passes or fails on which paper that is, is not checking anything.
  const words: string[] = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify((()=>{const rs=[...document.querySelectorAll("div.row")].slice(0,5);'
      + 'if(!rs.length)return [];'
      + 'const w=rs.flatMap(r=>(r.innerText||"").match(/[A-Za-z]{4,}/g)||[]);'
      + 'return [...new Set(w)].slice(0,16)})())'
    )
  )
  const namedFields = () =>
    w.webContents
      .executeJavaScript('document.querySelectorAll(".res-row .res-label").length')
      .then(Number)
  let narrowed = await counts()
  let usedWord = ''
  let named = 0
  for (const word of words) {
    await typeQuery(word.toLowerCase())
    await new Promise((r) => setTimeout(r, 700))
    narrowed = await counts()
    usedWord = word
    named = await namedFields()
    if (narrowed.shown >= 2 && narrowed.shown < narrowed.all && named > 0) break
  }
  log('word used', { usedWord, named })
  log('after narrowing', narrowed)
  expect(
    'the list can be narrowed to some of the library',
    narrowed.shown >= 2 && narrowed.shown < narrowed.all,
    { words, narrowed }
  )

  // A table can say that a paper matched.  It cannot say why, and "why" is
  // the reason anybody reads a list of results: the same rows come back for a
  // word in the title and for a word that appears once in the abstract, and
  // telling those apart means opening them one at a time.  So a search swaps
  // the table for cards that show the matched field and a snippet around the
  // match, with the match marked.
  const resCards = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({cards:document.querySelectorAll(".res-row").length,'
      + 'rows:document.querySelectorAll("div.row").length,'
      + 'marks:document.querySelectorAll(".res-row mark").length,'
      + 'sameWord:[...document.querySelectorAll(".res-row mark")]'
      + '.every(m=>(m.textContent||"").toLowerCase()==='
      + JSON.stringify(usedWord.toLowerCase()) + '),'
      + 'sample:(document.querySelector(".res-row mark")||{}).textContent||null,'
      + 'labels:[...document.querySelectorAll(".res-row .res-label")]'
      + '.slice(0,4).map(e=>e.textContent),'
      // a card with nothing marked on it is a card that matched and then
      // declined to say where: the usual cause is the match sitting in a part
      // of a field the card does not draw, such as the fourth author
      + 'explained:[...document.querySelectorAll(".res-row")]'
      + '.filter(c=>c.querySelector("mark")).length,'
      + 'titles:[...document.querySelectorAll(".res-row .res-title")]'
      + '.slice(0,2).map(e=>(e.textContent||"").slice(0,60))})'
    )
  )
  log('search results', { word: usedWord, ...resCards })
  expect(
    'a search swaps the table for results that say why',
    resCards.cards > 0 && resCards.rows === 0,
    resCards
  )
  expect(
    'what matched is marked, and what is marked is the word',
    resCards.marks > 0 && resCards.sameWord === true,
    resCards
  )
  expect(
    'a result names the field the match was found in',
    (resCards.labels ?? []).length > 0,
    resCards
  )
  // every card, not merely some: a reader who has to work out which ones the
  // search actually found will not trust the ones that did say
  expect(
    'every result says where it matched',
    resCards.explained === resCards.cards,
    resCards
  )
  expect(
    'the title is still on the card',
    (resCards.titles ?? []).length > 0 &&
      (resCards.titles as string[]).every((t) => t.trim().length > 0),
    resCards
  )
  // opened after narrowing, so that what Esc is asked to leave alone is a row
  // that is actually on screen
  await w.webContents.executeJavaScript(
    '(()=>{const r=document.querySelector("div.row, div.res-row");'
    + 'if(!r)return 0;r.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))
  await keyOn('window', 'a', true)
  await new Promise((r) => setTimeout(r, 400))
  const selected = await counts()
  log('after ctrl+A', selected)
  expect('ctrl+A selects everything on screen', selected.n === narrowed.shown, {
    selected,
    narrowed
  })
  expect('and not the whole library', selected.n < selected.all, selected)
  // the same key inside the search box is a request about the text
  await keyOn('document.querySelector("input")', 'a', true)
  await new Promise((r) => setTimeout(r, 400))
  const inField = await counts()
  log('ctrl+A in the search box', inField)
  expect('inside a text field ctrl+A still means the text', inField.n === narrowed.shown, inField)
  await keyOn('window', 'Escape', false)
  await new Promise((r) => setTimeout(r, 400))
  const escaped = await counts()
  log('after Esc', escaped)
  expect('Esc drops the multi-selection', escaped.bar === false && escaped.n === 0, escaped)
  expect('and leaves the open row alone', escaped.sel === 1, escaped)
  await keyOn('window', 'Escape', false)
  await typeQuery('')
  await new Promise((r) => setTimeout(r, 800))
  // The cards are a way of reading a search, not a replacement for the table:
  // a query is what decides, so emptying the box has to hand the table back,
  // columns and all.  A reader who searched once and then lost their columns
  // would have no way to say what went missing.
  const backToTable = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({rows:document.querySelectorAll("div.row").length,'
      + 'cards:document.querySelectorAll(".res-row").length,'
      + 'heads:document.querySelectorAll(".col-head [data-col]").length})'
    )
  )
  log('after clearing the search', backToTable)
  expect(
    'clearing the search hands the table back',
    backToTable.rows > 0 && backToTable.cards === 0 && backToTable.heads > 3,
    backToTable
  )

  // Settings.  Everything the app remembers used to live in four corners of
  // the toolbar; this checks that the panel gathers them and that changing the
  // full-text page budget reaches the config, which is where it has to land for
  // the index to be rebuilt against it.  The value is put back afterwards.
  const cfgBefore = await w.webContents.executeJavaScript(
    '(async()=>{const c=await window.api.getConfig();'
    + 'return JSON.stringify({ftPages:c.ftPages??null,theme:c.theme??null,fontSize:c.fontSize??null})})()'
  )
  log('config before settings', cfgBefore)
  log(
    'click 设置',
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
      + '.find(x=>x.textContent.trim()==="设置");if(!b)return "missing";b.click();return "ok"})()'
    )
  )
  await new Promise((r) => setTimeout(r, 500))
  const setInfo = await w.webContents.executeJavaScript(
    '(()=>{const m=document.querySelector(".settings");if(!m)return JSON.stringify({open:0});'
    + 'const inp=[...m.querySelectorAll("input")].find(i=>i.type!=="checkbox");'
    + 'return JSON.stringify({open:1,secs:[...m.querySelectorAll(".set-sec")].map(s=>s.textContent),'
    + 'pages:inp?inp.value:null,dir:(m.querySelector(".set-path")||{}).textContent||null,'
    + 'mark:(()=>{const i=m.querySelector(".about-logo");return i?(i.src||"").slice(0,40):null})(),'
    + 'version:m.textContent.includes("Mendeley NG")})})()'
  )
  log('settings', setInfo)
  const si = JSON.parse(setInfo)
  // Vite inlines an asset under 4 KiB and links to it above that, so the mark
  // comes back either as a data URL or as a file named after the logo; both
  // are the mark, and neither should be a stale raster of an older one
  expect(
    'the about section carries the mark',
    typeof si.mark === 'string' &&
      (si.mark.startsWith('data:image/svg') || /logo[^/]*\.svg/.test(si.mark)),
    si.mark
  )
  expect('the settings panel opens', si.open === 1, si)
  expect(
    'it gathers every section in one place',
    si.secs.includes('外观') && si.secs.includes('文件') && si.secs.includes('全文检索'),
    si
  )
  expect('it shows the version', si.version === true, si)

  // The start-up pull is the one thing this app does without being asked, so
  // it has to be switchable off, and the switch has to land in the config a
  // later launch reads — a box that only changed the panel would come back on
  // next time and the reader would have no way to tell why.
  expect('settings has a section for it', si.secs.includes('同步'), si.secs)
  const syncBox = '打开软件时自动同步一次'
  const findSyncBox =
    '(()=>{const m=document.querySelector(".settings");if(!m)return JSON.stringify({found:0});'
    + 'const l=[...m.querySelectorAll("label")].find(x=>x.textContent.includes('
    + JSON.stringify(syncBox) + '));'
    + 'if(!l)return JSON.stringify({found:0});'
    + 'const i=l.querySelector("input[type=checkbox]");'
    + 'return JSON.stringify({found:1,on:i?!!i.checked:null})})()'
  // 0 rather than a throw when the row is not there: a missing switch is a
  // failure to report, not a reason to end the run before the rest of the
  // settings are put back
  const pressSyncBox =
    '(()=>{const m=document.querySelector(".settings");if(!m)return 0;'
    + 'const l=[...m.querySelectorAll("label")].find(x=>x.textContent.includes('
    + JSON.stringify(syncBox) + '));'
    + 'if(!l)return 0;const i=l.querySelector("input[type=checkbox]");'
    + 'if(!i)return 0;i.click();return 1})()'
  const boxOn = JSON.parse(await w.webContents.executeJavaScript(findSyncBox))
  log('auto-sync box', boxOn)
  expect(
    'the switch is there and starts on',
    boxOn.found === 1 && boxOn.on === true,
    boxOn
  )
  await w.webContents.executeJavaScript(pressSyncBox)
  await new Promise((r) => setTimeout(r, 400))
  const cfgOff = JSON.parse(
    await w.webContents.executeJavaScript('(async()=>JSON.stringify(await window.api.getConfig()))()')
  )
  log('config after switching it off', cfgOff.syncOnStart)
  expect('switching it off reaches the config', cfgOff.syncOnStart === false, cfgOff.syncOnStart)
  const boxOff = JSON.parse(await w.webContents.executeJavaScript(findSyncBox))
  expect('and the box on screen goes with it', boxOff.on === false, boxOff)
  // put back: both the config and the panel, so the next run starts from on
  await w.webContents.executeJavaScript(pressSyncBox)
  await new Promise((r) => setTimeout(r, 400))
  const cfgOn = JSON.parse(
    await w.webContents.executeJavaScript('(async()=>JSON.stringify(await window.api.getConfig()))()')
  )
  log('config after switching it back', cfgOn.syncOnStart)
  expect('switching it back on reaches the config too', cfgOn.syncOnStart === true, cfgOn.syncOnStart)

  // "已是最新版本" without a number answers a question nobody asked — newest
  // compared to what?  A reader who was told a build is fixed needs the two
  // numbers side by side to know whether what they are running is the fixed
  // one, so every update line names the version that is running and, when
  // there is one, the version on offer.  Checked by pressing the button and
  // reading both the state the main process sent and the line on screen.
  const appVersion = app.getVersion()
  await w.webContents.executeJavaScript(
    '(()=>{window.__upd=[];window.__offUpd=window.api.onUpdateState('
    + '(s)=>{window.__upd.push(s)});return 1})()'
  )
  const updLineBefore = await w.webContents.executeJavaScript(
    'JSON.stringify({line:(document.querySelector(".about-upd .upd-line")||{}).textContent||null,'
    + 'btn:(document.querySelector(".about-upd button")||{}).textContent||null})'
  )
  const updBefore = JSON.parse(updLineBefore)
  log('update line at rest', { appVersion, ...updBefore })
  expect(
    'the updater names the version that is running',
    /Mendeley NG/.test(String(updBefore.line ?? '')) === false &&
      String(updBefore.line ?? '').includes(appVersion),
    { appVersion, updBefore }
  )
  expect('it offers to go and look', /检查更新/.test(String(updBefore.btn ?? '')), updBefore)
  await w.webContents.executeJavaScript(
    '(()=>{const b=document.querySelector(".about-upd button");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 800))
  const updAfter = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({line:(document.querySelector(".about-upd .upd-line")||{}).textContent||null,'
      + 'states:(window.__upd||[]).map(s=>({phase:s.phase,current:s.current,version:s.version}))})'
    )
  )
  log('update line after checking', updAfter)
  // whichever way the check went, the answer has to say which version it is
  // an answer about
  expect(
    'an answer from the updater still names this version',
    String(updAfter.line ?? '').includes(appVersion),
    { appVersion, updAfter }
  )
  // and the state itself carries it, so no phase has to be trusted to put it
  // in its own wording
  expect(
    'every state the updater sends carries the version it is about',
    (updAfter.states ?? []).length > 0 &&
      (updAfter.states as { current?: string }[]).every((s) => s.current === appVersion),
    updAfter.states
  )
  await w.webContents.executeJavaScript(
    '(()=>{if(window.__offUpd)window.__offUpd();return 1})()'
  )
  await w.webContents.executeJavaScript(
    '(()=>{const m=document.querySelector(".settings");'
    + 'const inp=[...m.querySelectorAll("input")].find(i=>i.type!=="checkbox");if(!inp)return 0;'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(inp,"5");inp.dispatchEvent(new Event("input",{bubbles:true}));'
    // Enter rather than a blur event: React maps onBlur to focusout, and a
    // synthetic blur would be swallowed
    + 'inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 700))
  const cfgAfter = await w.webContents.executeJavaScript(
    '(async()=>{const c=await window.api.getConfig();return JSON.stringify({ftPages:c.ftPages??null})})()'
  )
  log('config after changing the page budget', cfgAfter)
  expect('the page budget reaches the config', /"ftPages":5/.test(cfgAfter), cfgAfter)
  // put it back the way it was, so the next run starts from the same place
  await w.webContents.executeJavaScript(
    `window.api.setConfig({ftPages:${JSON.parse(cfgBefore).ftPages ?? 3}})`
  )
  await new Promise((r) => setTimeout(r, 400))
  // Esc is the way out of anything floating over the library, and the
  // settings sheet covers the whole window, which is exactly when having to
  // go and find the button is most annoying.
  await w.webContents.executeJavaScript(
    'window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'
  )
  await new Promise((r) => setTimeout(r, 400))
  const escSettings = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({settings:document.querySelectorAll(".settings").length,'
      + 'cols:document.querySelectorAll(".col-picker").length})'
    )
  )
  log('esc over the settings', escSettings)
  expect('esc closes the settings sheet', escSettings.settings === 0, escSettings)
  // the same key over the column card: it is a floating card like the sheet,
  // so it has to answer to the same key
  log(
    'click 列',
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
      + '.find(x=>x.textContent.trim()==="列");if(!b)return "missing";b.click();return "ok"})()'
    )
  )
  await new Promise((r) => setTimeout(r, 300))
  const colsOpened = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({cols:document.querySelectorAll(".col-picker").length})'
    )
  )
  log('column card opened', colsOpened)
  // a card that never opened would make the assertion below pass for the
  // wrong reason, so the opening is checked first
  expect('the column card opens', colsOpened.cols === 1, colsOpened)
  await w.webContents.executeJavaScript(
    'window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'
  )
  await new Promise((r) => setTimeout(r, 300))
  const escCols = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({settings:document.querySelectorAll(".settings").length,'
      + 'cols:document.querySelectorAll(".col-picker").length})'
    )
  )
  log('esc over the column card', escCols)
  expect('esc closes the column card', escCols.cols === 0, escCols)

  // Draggable pane edges.  The widths are remembered, so the run puts them
  // back afterwards; everything else here is measured geometry.
  const cfgPanes = await w.webContents.executeJavaScript(
    '(async()=>{const c=await window.api.getConfig();'
    + 'return JSON.stringify({l:c.paneLeft??null,r:c.paneRight??null})})()'
  )
  log('config panes before', cfgPanes)
  const paneW = () =>
    w.webContents.executeJavaScript(
      'JSON.stringify({bars:document.querySelectorAll(".splitter").length,'
      + 'win:Math.round(document.querySelector(".body").getBoundingClientRect().width),'
      + 'left:Math.round(document.querySelector(".pane-left").getBoundingClientRect().width),'
      + 'right:Math.round(document.querySelector(".pane-right").getBoundingClientRect().width)})'
    )
  const drag = async (which: number, dx: number) => {
    await w.webContents.executeJavaScript(
      `(()=>{const s=document.querySelectorAll(".splitter")[${which}];if(!s)return 0;`
      + 'const b=s.getBoundingClientRect();'
      + 's.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,'
      + 'clientX:Math.round(b.left+3),clientY:Math.round(b.top+200)}));return 1})()'
    )
    // the drag is tracked on window from a listener that only exists once the
    // mousedown has rendered, so a real gap is needed, as with a real drag
    await new Promise((r) => setTimeout(r, 250))
    await w.webContents.executeJavaScript(
      `(()=>{const s=document.querySelectorAll(".splitter")[${which}];`
      + `const x=Math.round(s.getBoundingClientRect().left+3+${dx});`
      + 'window.dispatchEvent(new MouseEvent("mousemove",{bubbles:true,clientX:x,clientY:400}));'
      + 'return 1})()'
    )
    await new Promise((r) => setTimeout(r, 150))
    await w.webContents.executeJavaScript(
      'window.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}))'
    )
    // the write is debounced until the drag has settled, so give it room
    await new Promise((r) => setTimeout(r, 700))
  }
  // Both edges are reset first.  Otherwise the run starts from whatever the
  // last run left behind, and a reader pane already near its maximum has no
  // room left to grow into, which makes the check below fail for no reason.
  await w.webContents.executeJavaScript(
    '(()=>{const s=document.querySelectorAll(".splitter");'
    + 's.forEach(b=>b.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));return s.length})()'
  )
  await new Promise((r) => setTimeout(r, 900))
  const p0 = JSON.parse(await paneW())
  log('panes at the defaults', p0)
  expect('both pane edges are draggable', p0.bars === 2, p0)
  expect('the defaults are the ones the stylesheet says', p0.left === 240, p0)
  await drag(0, 90)
  const p1 = JSON.parse(await paneW())
  log('panes after dragging the tree edge', p1)
  expect('dragging widens the folder pane', p1.left >= p0.left + 60, { p0, p1 })
  await drag(1, -100)
  const p2 = JSON.parse(await paneW())
  log('panes after dragging the reader edge', p2)
  expect('dragging widens the reader pane', p2.right >= p1.right + 40, { p1, p2 })
  expect(
    'neither drag can squeeze the list away',
    p2.win - p2.left - p2.right >= 250,
    p2
  )
  const cfgPanes1 = await w.webContents.executeJavaScript(
    '(async()=>{const c=await window.api.getConfig();'
    + 'return JSON.stringify({l:c.paneLeft??null,r:c.paneRight??null})})()'
  )
  log('config panes after', cfgPanes1)
  const cfg1 = JSON.parse(cfgPanes1)
  expect(
    'the widths are remembered',
    typeof cfg1.l === 'number' &&
      typeof cfg1.r === 'number' &&
      // the reader is stored as a share of the window, so widening it has to
      // move the number and not just the pixels
      cfg1.r > 46,
    cfgPanes1
  )
  // double click puts an edge back, then the original widths are written back
  // so the next run starts where this one did
  await w.webContents.executeJavaScript(
    '(()=>{const s=document.querySelectorAll(".splitter")[0];'
    + 'if(!s)return 0;s.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))
  const p3 = JSON.parse(await paneW())
  log('panes after a double click', p3)
  expect('a double click resets the edge', p3.left === 240, p3)
  // the debounced write fires 400ms after the last change, so it has to land
  // before the restore below, or it would overwrite the restore and leave the
  // next run starting from widths this run chose
  await new Promise((r) => setTimeout(r, 700))
  const back = JSON.parse(cfgPanes)
  await w.webContents.executeJavaScript(
    `(async()=>{await window.api.setConfig({paneLeft:${back.l ?? 'undefined'},`
    + `paneRight:${back.r ?? 'undefined'}})})()`
  )
  await new Promise((r) => setTimeout(r, 300))

  if (annBackup) fs.writeFileSync(annPath, annBackup)
  if (readBackup) fs.writeFileSync(readPath, readBackup)
  else fs.rmSync(readPath, { force: true })
  const afterCount = await w.webContents.executeJavaScript(
    '(async()=>(await window.api.loadAnnotations()).length)()'
  )
  log('annotations file restored ->', afterCount, 'entries')

  // A paper that arrives has to be searchable without reading the library
  // again.  ftAdd is called here rather than through an import, because an
  // import needs the cloud and what is being checked is the append.
  const corpus = ftDocs().filter((d) => d.localPdf)
  let addInfo: {
    ok: boolean
    indexed?: number[]
    bytes?: number[]
    hits?: number
    owned?: boolean
  } = { ok: false }
  if (corpus.length >= 4) {
    const first = corpus.slice(0, 2)
    const second = corpus.slice(2, 4)
    ftClear()
    const before = ftStatus(ftDocs())
    await ftAdd(first, first.map((d) => d.id))
    const mid = ftStatus(ftDocs())
    await ftAdd(second, second.map((d) => d.id))
    const after = ftStatus(ftDocs())
    // whichever of these words turns up: what matters is that the hit is
    // reported against a paper that was actually indexed here
    const probe =
      ['the', 'of', 'and', 'in'].map((word) => ftSearch(word)).find((h) => h.length) ?? []
    addInfo = {
      ok: true,
      indexed: [before.indexed, mid.indexed, after.indexed],
      bytes: [before.bytes, mid.bytes, after.bytes],
      hits: probe.length,
      owned: probe.every((h) => corpus.slice(0, 4).some((d) => d.id === h.docId))
    }
  }
  log('indexing what was just added', addInfo)
  expect(
    'a paper that arrives is indexed on its own',
    addInfo.ok === true && addInfo.indexed?.[1] === 2,
    addInfo
  )
  // counted as growth rather than as an exact number: a scan with no text
  // layer yields nothing to index, and that is a property of the paper, not
  // of the append
  expect(
    'a second arrival appends instead of replacing',
    (addInfo.indexed?.[2] ?? 0) > (addInfo.indexed?.[1] ?? 0) &&
      (addInfo.bytes?.[2] ?? 0) > (addInfo.bytes?.[1] ?? 0),
    addInfo
  )
  expect(
    'text appended this way can be found',
    (addInfo.hits ?? 0) > 0 && addInfo.owned === true,
    addInfo
  )

  // An entry describes a file, not just a document.  The same paper offered
  // twice must not be written twice, and the same paper under a new name must
  // be read again — which is what a rename or a re-attached PDF looks like.
  let againInfo: { ok: boolean; same?: boolean; moved?: boolean; indexed?: number } = {
    ok: false
  }
  let two: Doc[] = []
  let late: Doc | undefined
  let lateOther: Doc | undefined
  const copyDir = path.join(app.getPath('temp'), 'mendeley-ng-ft-copies')
  if (corpus.length >= 4) {
    two = corpus.slice(0, 2)
    const pair = corpus.slice(2, 4)
    const before = ftStatus(ftDocs())
    await ftAdd(pair, pair.map((d) => d.id))
    const again = ftStatus(ftDocs())
    fs.mkdirSync(copyDir, { recursive: true })
    const moved = pair.map((d, i) => ({
      ...d,
      localPdf: path.join(copyDir, `${i}-${path.basename(d.localPdf as string)}`)
    }))
    moved.forEach((d, i) =>
      fs.copyFileSync(pair[i]!.localPdf as string, d.localPdf as string)
    )
    await ftAdd(moved, moved.map((d) => d.id))
    const afterMoved = ftStatus(ftDocs())
    againInfo = {
      ok: true,
      same: again.bytes === before.bytes && again.indexed === before.indexed,
      // new text, and no new document: the paper was re-read, not added
      moved: afterMoved.bytes > again.bytes && afterMoved.indexed === again.indexed,
      indexed: afterMoved.indexed
    }
  }
  log('the same paper again', againInfo)
  expect(
    'a paper already in the index is not written twice',
    againInfo.ok === true && againInfo.same === true,
    againInfo
  )
  expect(
    'a paper whose file moved is read again',
    againInfo.ok === true && againInfo.moved === true,
    againInfo
  )

  // A paper that arrives while the library is being indexed has to wait its
  // turn.  The build took the list of papers it will read before it started,
  // so nothing else would ever pick that one up.
  //
  // What is being added is a copy of a paper that does have a text layer
  // under an id the build has never heard of, so the only way it can reach
  // the index is the queue.  Whether a paper has a text layer is measured
  // rather than assumed: a scan has none, and that is a property of the
  // paper, not of the append.
  let duringInfo: {
    ok: boolean
    added?: number
    queued?: number
    left?: number
    indexed?: number
    want?: number
  } = { ok: false }
  if (corpus.length >= 4) {
    ftClear()
    const twoGot = await ftAdd(two, two.map((d) => d.id))
    let src: Doc | undefined
    for (const d of corpus.slice(0, 10)) {
      ftClear()
      if (await ftAdd([d], [d.id])) {
        src = d
        break
      }
    }
    if (src) {
      const copy = (tag: string): Doc => ({
        ...src!,
        id: `smoke-late-${tag}`,
        localPdf: path.join(copyDir, `${tag}-${path.basename(src!.localPdf as string)}`)
      })
      late = copy('a')
      lateOther = copy('b')
      fs.copyFileSync(src.localPdf as string, late.localPdf as string)
      fs.copyFileSync(src.localPdf as string, lateOther.localPdf as string)
      ftClear()
      // not awaited: the whole point is to be inside the run
      const running = ftBuild(two, () => undefined, true)
      // ftBuild claims the text file before it awaits anything, so this lands
      // while it is busy rather than racing it
      const added = await ftAdd([late], [late.id])
      const queued = ftPending()
      await running
      const left = ftPending()
      duringInfo = {
        ok: true,
        added,
        queued,
        left,
        indexed: ftStatus(ftDocs()).indexed,
        want: twoGot + 1
      }
    }
    ftClear()
  }
  log('a paper arriving during a build', duringInfo)
  expect(
    'a paper that arrives mid-build waits instead of being dropped',
    duringInfo.ok === true && duringInfo.added === 0 && duringInfo.queued === 1,
    duringInfo
  )
  expect(
    'the run picks it up when it finishes',
    duringInfo.ok === true && duringInfo.left === 0 && duringInfo.indexed === duringInfo.want,
    duringInfo
  )

  // An index with nothing in it is not fixed by adding one paper to it: the
  // paper becomes findable and the rest of the library does not, which reads
  // as a working search that happens to know about one paper.  Both halves
  // matter — the build when there is nothing, and no build when there is.
  const settle = async (want: boolean, ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      await new Promise((r) => setTimeout(r, 100))
      if (ftStatus(ftDocs()).building === want) return true
    }
    return false
  }
  let voidInfo: {
    ok: boolean
    wasVoid?: boolean
    started?: boolean
    stopped?: boolean
    quiet?: boolean
  } = { ok: false }
  if (late && lateOther) {
    ftClear()
    const wasVoid = ftVoid()
    indexAdded(late)
    const started = await settle(true, 8000)
    ftCancel()
    const stopped = await settle(false, 12000)
    // the other half: a library that already has an index is not rebuilt
    // behind the reader's back because one paper arrived
    ftClear()
    await ftAdd(two, two.map((d) => d.id))
    indexAdded(lateOther)
    // 1.2 s of quiet is not a proof, but a build that is going to start has
    // to claim the text file within a few hundred milliseconds
    const quiet = !(await settle(true, 1200))
    voidInfo = { ok: true, wasVoid, started, stopped, quiet }
    ftClear()
  }
  log('an index that has nothing in it', voidInfo)
  expect(
    'one paper in an empty index starts a build',
    voidInfo.ok === true && voidInfo.wasVoid === true && voidInfo.started === true,
    voidInfo
  )
  expect('the build it started can be stopped', voidInfo.stopped === true, voidInfo)
  expect(
    'a library with an index is not rebuilt behind the reader',
    voidInfo.ok === true && voidInfo.quiet === true,
    voidInfo
  )
  fs.rmSync(copyDir, { recursive: true, force: true })

  // the run left the throwaway index holding only those four; put it back the
  // way the next run expects to find it
  ftClear()

  // The window opening at the size it was last left at, in the place it was
  // last left, is the difference between an app that knows it was used before
  // and one that has to be arranged every morning.  Both halves are checked
  // here against a throwaway window: the close writes, and what is written is
  // only offered back while a display still contains it.
  const win0 = loadConfig().window ?? null
  const w2 = new BrowserWindow({ width: 1200, height: 800, show: false })
  w2.setBounds({ x: 120, y: 80, width: 1200, height: 800 })
  rememberBounds(w2)
  const boundsWrote = loadConfig().window
  log('bounds remembered', boundsWrote)
  expect(
    'closing writes where the window was',
    boundsWrote?.x === 120 &&
      boundsWrote?.y === 80 &&
      boundsWrote?.width === 1200 &&
      boundsWrote?.height === 800,
    boundsWrote
  )
  expect('it is offered back on the next start', savedBounds()?.width === 1200, savedBounds())
  // a rectangle no display contains is refused: this is what happens when a
  // monitor is unplugged between two runs
  saveConfig({
    ...loadConfig(),
    window: { x: -40_000, y: -40_000, width: 1200, height: 800, maximized: false }
  })
  expect('a rectangle outside every display is refused', savedBounds() === null, savedBounds())
  // maximising must not overwrite the size that was chosen, or coming back
  // from maximised has nowhere to go
  w2.maximize()
  rememberBounds(w2)
  const maxed = loadConfig().window
  log('bounds maximised', maxed)
  expect('maximising is remembered as a flag', maxed?.maximized === true, maxed)
  expect(
    'maximising leaves the chosen size alone',
    maxed?.width === 1200 && maxed?.height === 800,
    maxed
  )
  // and the writing has to be wired to the window actually going away, not
  // merely possible: this is the same call the real window gets
  // the flag decides whether the next start comes back maximised, so it is
  // cleared before the wiring is exercised: a maximised close keeps the
  // rectangle instead of writing one, which is what the check above is for
  saveConfig({
    ...loadConfig(),
    // deliberately different from where the window is about to be put: if
    // nothing is written on close, the value read afterwards is this one and
    // the check fails, which is the only way to know the wiring is what is
    // being tested and not a value this run happened to leave behind
    window: { x: 400, y: 300, width: 1100, height: 700, maximized: false }
  })
  w2.unmaximize()
  // coming back from maximised restores the old rectangle, and it does not
  // finish before the next line runs: setting bounds on top of a restore that
  // is still in flight is silently undone
  await new Promise((r) => setTimeout(r, 500))
  w2.setBounds({ x: 200, y: 150, width: 1300, height: 900 })
  await new Promise((r) => setTimeout(r, 300))
  attachWindowMemory(w2)
  w2.close()
  await new Promise((r) => setTimeout(r, 600))
  const onClose = loadConfig().window
  log('bounds on close', onClose)
  expect(
    'the write is wired to the window closing',
    onClose?.x === 200 &&
      onClose?.y === 150 &&
      onClose?.width === 1300 &&
      onClose?.height === 900 &&
      onClose?.maximized === false,
    onClose
  )
  expect('what is written is what comes back', savedBounds()?.width === 1300, savedBounds())
  const cfgw = loadConfig()
  if (win0) cfgw.window = win0
  else delete cfgw.window
  saveConfig(cfgw)

  // A dropped PDF used to be read off disk twice — once to harvest its
  // identifiers, once again to upload it — because pdf.js detaches the buffer
  // it is handed and a second read looked like the only way to get intact
  // bytes.  For a large paper that doubled the only real cost of an import.
  // The upload is stubbed for the duration: a real one would create a
  // document in the reader's own library.  Nothing after this point needs the
  // real handler, and the process exits when the run does.
  const importedCalls: { name: string; len: number }[] = []
  ipcMain.removeHandler('doc:importPdf')
  ipcMain.handle(
    'doc:importPdf',
    async (_e, name: string, bytes: ArrayBuffer) => {
      importedCalls.push({ name, len: bytes.byteLength })
      return {
        id: 'smoke-imported',
        title: 'Smoke Imported Paper',
        year: 2026,
        authors: [],
        folder_uuids: []
      } as Doc
    }
  )
  await w.webContents.executeJavaScript(
    '(()=>{window.__ab=0;if(!window.__abDone){'
    + 'const o=File.prototype.arrayBuffer;'
    + 'File.prototype.arrayBuffer=function(){window.__ab++;return o.call(this)};'
    + 'window.__abDone=1}'
    + 'const dt=new DataTransfer();'
    + 'dt.items.add(new File([new Uint8Array(4096)],"smoke-drop.pdf",'
    + '{type:"application/pdf"}));'
    + 'document.querySelector(".app").dispatchEvent(new DragEvent("drop",'
    + '{bubbles:true,cancelable:true,dataTransfer:dt}));return 1})()'
  )
  // two processes and a pdf.js worker stand between the drop and the upload;
  // poll for the arrival rather than betting on a delay
  for (let i = 0; i < 80 && !importedCalls.length; i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const readCount = await w.webContents.executeJavaScript('window.__ab')
  log('drop reads', { reads: readCount, calls: importedCalls })
  expect('a dropped PDF is read off disk once', readCount === 1, readCount)
  expect('the import still happens', importedCalls.length === 1, importedCalls)
  expect(
    'the bytes that reach the upload are whole',
    importedCalls[0]?.len === 4096,
    importedCalls[0]
  )

  // Clicking the icon twice used to start two copies: two windows on the same
  // library, each with its own annotations and reading position in memory and
  // writing them back over each other.  What is checked here is the decision
  // to take the lock, that a second launch is wired to something, and what
  // that something does — to a minimised window and to the one already open.
  log('single instance', {
    plain: wantsSingleInstance([]),
    smoke: wantsSingleInstance(['--smoke']),
    demo: wantsSingleInstance(['--demo']),
    listeners: app.listenerCount('second-instance')
  })
  // the packaged app and nothing else: a run that locks itself out of the
  // second copy is a run that cannot be told apart from the first
  expect('a normal launch asks to be the only one', wantsSingleInstance([]) === true, 'plain')
  expect(
    'a smoke run does not fight the app that is open',
    wantsSingleInstance(['--smoke']) === false,
    'smoke'
  )
  expect('nor does a screenshot run', wantsSingleInstance(['--demo']) === false, 'demo')
  expect(
    'a second launch is wired to something',
    app.listenerCount('second-instance') >= 1,
    app.listenerCount('second-instance')
  )
  // what it does to a window that is minimised: this is the whole point of
  // the feature — the click that produced no visible change is the click that
  // made the reader think the app had not started
  const w3 = new BrowserWindow({ width: 320, height: 200, show: false })
  w3.show()
  await new Promise((r) => setTimeout(r, 300))
  w3.minimize()
  await new Promise((r) => setTimeout(r, 500))
  const wasMin = w3.isMinimized()
  // the event Electron fires in the copy that is already running; emitted
  // here rather than by starting a second process, which a run that is
  // already holding the library open cannot do to itself
  app.emit('second-instance', null, [])
  bringUp(w3)
  await new Promise((r) => setTimeout(r, 500))
  const nowMin = w3.isMinimized()
  const focused = w3.isFocused()
  w3.close()
  log('minimised window brought back', { wasMin, nowMin, focused })
  expect('a second launch un-minimises the window', wasMin === true && nowMin === false, {
    wasMin,
    nowMin
  })
  // and brings it forward, which is what the reader was asking for by
  // clicking the icon again.  Checked on a window that is really on screen:
  // the window this whole run looks through is deliberately not.
  expect('a second launch brings the window forward', focused === true, focused)

  // Whatever the run found is what it has to leave, and not only when every
  // check passed.  A run that stops early on a failure used to leave the
  // column layout half-changed and the sort pointing at whatever the last
  // press happened to pick; the next run then started from that, and one red
  // line became a dozen more, each a symptom of the first and none of them
  // saying so.  Put back here, where every path out of the run goes past.
  const putBack = [
    'cols',
    'sort',
    'fontSize',
    'citeStyle',
    'pdfNameTemplate',
    'pdfContinuous',
    'ftPages',
    'dupeIgnores',
    'paneLeft',
    'paneRight'
  ] as const
  const end = loadConfig() as unknown as Record<string, unknown>
  const start = cfg0 as unknown as Record<string, unknown>
  for (const k of putBack) {
    if (start[k] !== undefined) end[k] = start[k]
    else delete end[k]
  }
  saveConfig(end as never)
  log('config put back', putBack.map((k) => `${k}:${start[k] === undefined ? '-' : 'set'}`).join(' '))

  if (fails.length) {
    log('FAILED CHECKS', fails.join(' | '))
    app.exit(1)
    return
  }
  log('all checks passed')
  app.exit(0)
}
