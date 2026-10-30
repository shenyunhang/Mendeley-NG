import { BrowserWindow, app, dialog, ipcMain, net, protocol, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Mendeley, findToken, importTokenFrom } from './mendeley'
import {
  DEFAULT_PDF_DIR,
  loadAnnotations,
  loadConfig,
  loadLibrary,
  loadNotes,
  saveAnnotations,
  saveConfig,
  saveLibrary,
  saveNotes
} from './store'
import { attachPdfs, parseName } from './pdfindex'
import { lookup, resolveIdentifier } from './lookup'
import { initUpdater, type UpdateState } from './updater'
import type {
  Annotation,
  AppConfig,
  CloudAnnotation,
  Doc,
  Folder,
  SyncStatus
} from '../../shared/types'

let win: BrowserWindow | null = null
let client: Mendeley | null = null

function status(s: SyncStatus) {
  win?.webContents.send('sync:status', s)
}

function ensureClient(): Mendeley {
  if (client) return client
  const found = findToken()
  if (!found) throw new Error('NO_TOKEN')
  client = new Mendeley(found.path, found.tok)
  return client
}

/** Overlap applied to the incremental watermark.  A document modified while
 *  the previous sync was in flight would otherwise be missed for ever, since
 *  its last_modified predates the timestamp we recorded when we started. */
const SYNC_OVERLAP_MS = 60_000

async function sync(full: boolean) {
  const c = ensureClient()
  const cfg = loadConfig()
  const prev = loadLibrary()

  // Incremental needs both a cache to merge into and a watermark.  The cache
  // timestamp is already a "before the request" stamp, which is exactly what
  // a since filter wants.
  const since =
    !full && prev?.syncedAt
      ? new Date(Date.parse(prev.syncedAt) - SYNC_OVERLAP_MS).toISOString()
      : undefined

  status({ phase: 'folders', done: 0, total: 0, message: '拉取文件夹' })
  const folders = await c.allFolders()

  const label = since ? '拉取改动' : '拉取文献'
  status({ phase: 'documents', done: 0, total: 0, message: label })
  const changed = await c.allDocuments(
    (n) => status({ phase: 'documents', done: n, total: 0, message: label }),
    since
  )

  const byId = new Map((prev?.docs ?? []).map((d) => [d.id, d]))
  for (const d of changed) byId.set(d.id, d)
  let docs = since ? [...byId.values()] : changed

  // Nothing changed and we already have a library: skip the two expensive
  // steps, which is most of what an incremental sync is for.
  let pdf = { matched: 0, total: docs.length }
  if (!since || changed.length) {
    status({ phase: 'files', done: 0, total: 0, message: '核对 PDF 挂载' })
    const withFile = await c.fileDocumentIds()
    for (const d of docs) {
      if (withFile.size) d.file_attached = withFile.has(d.id)
    }

    status({ phase: 'pdf', done: 0, total: 0, message: '匹配本地 PDF' })
    pdf = attachPdfs(docs, cfg.pdfDir)
  }

  if (since && prev) {
    // Mendeley occasionally hands back a changed document with an empty
    // folder_uuids, and losing a folder membership is far worse than
    // redundantly keeping one, so the known value wins when the fresh one
    // is blank.  Only done incrementally: a full pull is authoritative.
    const known = new Map(prev.docs.map((d) => [d.id, d.folder_uuids]))
    for (const d of changed) {
      if (!d.folder_uuids?.length && known.get(d.id)?.length) {
        d.folder_uuids = known.get(d.id)
      }
    }
  }

  // keep previously resolved pdf paths across a resync
  if (prev) {
    const oldById = new Map(prev.docs.map((d) => [d.id, d]))
    for (const d of docs) {
      const old = oldById.get(d.id)
      if (old && !d.localPdf && old.localPdf && fs.existsSync(old.localPdf)) {
        d.localPdf = old.localPdf
      }
    }
  }

  saveLibrary(docs, folders)
  saveConfig({ ...cfg, lastSync: new Date().toISOString() })
  status({
    phase: 'done',
    done: docs.length,
    total: docs.length,
    message: since
      ? `增量同步：改动 ${changed.length} 条，共 ${docs.length} 条文献（删除只在全量同步时发现）`
      : `同步完成：${docs.length} 条文献，${folders.length} 个文件夹，本地 PDF 匹配 ${pdf.matched}/${pdf.total}`
  })
  return { docs, folders }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 650,
    // no zoomFactor and no DPI overrides on purpose: Chromium already renders
    // at the system scale factor, which is the whole point of this rewrite
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    win = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/**
 * `--smoke` runs the whole stack headlessly and writes a screenshot, which is
 * the only way to confirm both the sync pipeline and the high-DPI rendering
 * from a command line.  It is a development aid, never used by the packaged app.
 */
async function runSmoke() {
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
  w.webContents.on('console-message', (_e, _l, msg) => { if (/error|Error/.test(msg)) errs.push(msg) })
  w.webContents.on('did-fail-load', (_e, code, desc) => errs.push('did-fail-load ' + code + ' ' + desc))
  win = w
  await w.loadFile(path.join(__dirname, '../renderer/index.html'))
  await new Promise((r) => setTimeout(r, 2500))
  const info = await w.webContents.executeJavaScript(
    // typeof, not a call: a real prompt would block the run
    'JSON.stringify({dpr: devicePixelRatio, rows: document.querySelectorAll("table,.row,[data-row]").length,'
    + 'prompt: typeof window.prompt, confirm: typeof window.confirm, body: document.body.innerText.slice(0,300)})'
  )
  log('renderer', info)
  if (errs.length) log('renderer errors', errs.slice(0, 10).join(' | '))

  // the starred filter is read-only, so it can be exercised here without
  // writing to the cloud, unlike the star toggle itself
  const stars = await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
    + '.find(x=>x.textContent.trim()==="★");if(!b)return "no star button";'
    + 'const badge=()=>[...document.querySelectorAll(".toolbar .badge")].pop().textContent.trim();'
    + 'const rows=()=>document.querySelectorAll(".row .star").length;'
    + 'const before=badge();const n=rows();b.click();'
    + 'return JSON.stringify({before,rows:n})})()'
  )
  log('stars rendered', stars)
  await new Promise((r) => setTimeout(r, 300))
  log(
    'starred filter on',
    await w.webContents.executeJavaScript(
      '[...document.querySelectorAll(".toolbar .badge")].pop().textContent.trim()'
    )
  )
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
    + '.find(x=>x.textContent.trim()==="★");b.click();return 1})()'
  )

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
  log(
    'click 保存搜索',
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
      + '.find(x=>x.textContent.trim()==="保存搜索");if(!b)return "missing";'
      + 'if(b.disabled)return "disabled";b.click();return "ok"})()'
    )
  )
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
  log('render src (current page)', await src())
  const backOne = JSON.parse(await turn('←'))
  const fwdAgain = JSON.parse(await turn('→'))
  // a page turn onto a warmed neighbour must not re-render from scratch:
  // either the bitmap is already in the cache, or the warm that was started
  // for it is joined instead of duplicated
  expect('prefetch serves a step back', backOne.src === 'cache', backOne)
  expect('prefetch serves a step forward', fwdAgain.src === 'cache', fwdAgain)

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
  expect('continuous lays out every page', cTop.pages === 4, cTop)
  expect('continuous paints pages in view', cTop.painted > 0, cTop)
  expect('continuous paints further down', cBottom.painted > 0, cBottom)
  expect('scrolling the column moves the page box', cBottom.page !== cTop.page, {
    top: cTop.page,
    bottom: cBottom.page
  })
  log('click 连续 again', await clickBar('连续'))
  await new Promise((r) => setTimeout(r, 1200))

  // The selection layer is what turns a rubber band into a real highlight, so
  // the run makes a synthetic selection and checks that it produces sane
  // rectangles.  The annotation file is restored afterwards; leaving a stray
  // highlight on a real paper would be a nasty side effect of a smoke test.
  // snapshot at the file level, because the restore below is the only thing
  // standing between a smoke run and the user's real highlights
  const annPath = path.join(app.getPath('userData'), 'library', 'annotations.json')
  const annBackup = fs.existsSync(annPath) ? fs.readFileSync(annPath) : null
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
  await w.webContents.executeJavaScript(
    '(()=>{const el=document.querySelector(".pdf-scroll").firstElementChild;'
    + 'const b=el.getBoundingClientRect();'
    + 'el.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,clientX:b.left+5,clientY:b.top+5}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 1500))
  const made = await w.webContents.executeJavaScript(
    '(async()=>{const a=await window.api.loadAnnotations();const before=window.__before;'
    + 'const added=a.filter(x=>!before.some(y=>y.id===x.id));'
    + 'return JSON.stringify({added:added.length,rects:added[0]?added[0].rects:null,pos:added[0]?added[0].pos:null})})()'
  )
  log('selection highlight', 'before', beforeCount, made)

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
  await setNote('')
  await new Promise((r) => setTimeout(r, 400))
  log(
    'notes cleared',
    await w.webContents.executeJavaScript(
      '(async()=>{const n=await window.api.loadNotes();'
      + 'return JSON.stringify({keys:Object.keys(n).length})})()'
    )
  )
  if (annBackup) fs.writeFileSync(annPath, annBackup)
  const afterCount = await w.webContents.executeJavaScript(
    '(async()=>(await window.api.loadAnnotations()).length)()'
  )
  log('annotations file restored ->', afterCount, 'entries')
  if (fails.length) {
    log('FAILED CHECKS', fails.join(' | '))
    app.exit(1)
    return
  }
  log('all checks passed')
  app.exit(0)
}

app.whenReady().then(() => {
  // serve local PDFs through our own scheme so webSecurity stays on
  protocol.handle('mendeley', (req) => {
    const u = new URL(req.url)
    if (u.hostname === 'pdf') {
      const p = decodeURIComponent(u.pathname.replace(/^\//, ''))
      return net.fetch('file:///' + p.replace(/\\/g, '/').replace(/^\/+/, ''))
    }
    return new Response('not found', { status: 404 })
  })

  if (process.argv.includes('--smoke')) {
    runSmoke().catch((e) => {
      console.log('[smoke] crashed', String(e))
      app.exit(1)
    })
    return
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('library:load', () => {
  try {
    return loadLibrary()
  } catch (e) {
    return { error: String(e) }
  }
})

ipcMain.handle('library:sync', async (_e, full: boolean) => {
  try {
    return await sync(full)
  } catch (e) {
    const msg = String(e)
    status({ phase: 'error', done: 0, total: 0, message: msg })
    return { error: msg }
  }
})

ipcMain.handle('library:hasToken', () => !!findToken())

ipcMain.handle('config:get', () => loadConfig())
ipcMain.handle('config:set', (_e, c: Partial<AppConfig>) => {
  const cur = loadConfig()
  saveConfig({ ...cur, ...c })
  return loadConfig()
})

ipcMain.handle('dialog:pickPdfDir', async () => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath: loadConfig().pdfDir || DEFAULT_PDF_DIR
  })
  if (r.canceled || !r.filePaths[0]) return null
  const pdfDir = r.filePaths[0]
  saveConfig({ ...loadConfig(), pdfDir })
  return pdfDir
})

ipcMain.handle('dialog:importToken', async () => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'token.json', extensions: ['json'] }]
  })
  if (r.canceled || !r.filePaths[0]) return null
  try {
    const got = importTokenFrom(r.filePaths[0])
    client = new Mendeley(got.path, got.tok)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('doc:patch', async (_e, id: string, body: Record<string, unknown>) => {
  const c = ensureClient()
  const updated = await c.patchDocument(id, body)
  const lib = loadLibrary()
  if (lib) {
    const i = lib.docs.findIndex((d) => d.id === id)
    if (i >= 0) lib.docs[i] = { ...lib.docs[i], ...updated }
    saveLibrary(lib.docs, lib.folders)
  }
  return updated
})

// Mendeley has no hard delete for documents: they go to the trash and can be
// restored.  Probed against the live API to confirm the route is
// POST /trash/{id}/restore; POST /documents/{id}/restore returns
// "No service found for your request".
ipcMain.handle('doc:trash', async (_e, id: string) => {
  const c = ensureClient()
  await c.trashDocument(id)
  const lib = loadLibrary()
  if (lib) saveLibrary(lib.docs.filter((d) => d.id !== id), lib.folders)
  return { ok: true }
})

ipcMain.handle('trash:list', async () => {
  const c = ensureClient()
  return c.listTrash()
})

ipcMain.handle('trash:restore', async (_e, id: string) => {
  const c = ensureClient()
  return c.restoreDocument(id)
})

ipcMain.handle('trash:purge', async (_e, id: string) => {
  const c = ensureClient()
  await c.purgeDocument(id)
  return { ok: true }
})

ipcMain.handle(
  'folder:add',
  async (_e, folderId: string, docId: string) => {
    const c = ensureClient()
    await c.addToFolder(folderId, docId)
    const lib = loadLibrary()
    if (lib) {
      const d = lib.docs.find((x) => x.id === docId)
      if (d) {
        d.folder_uuids = [...(d.folder_uuids ?? []), folderId]
        saveLibrary(lib.docs, lib.folders)
      }
    }
    return { ok: true }
  }
)

ipcMain.handle(
  'folder:remove',
  async (_e, folderId: string, docId: string) => {
    const c = ensureClient()
    await c.removeFromFolder(folderId, docId)
    const lib = loadLibrary()
    if (lib) {
      const d = lib.docs.find((x) => x.id === docId)
      if (d) {
        d.folder_uuids = (d.folder_uuids ?? []).filter((f) => f !== folderId)
        saveLibrary(lib.docs, lib.folders)
      }
    }
    return { ok: true }
  }
)

ipcMain.handle(
  'folder:patch',
  async (_e, id: string, body: { name?: string; parent_id?: string | null }) => {
    const c = ensureClient()
    const f = await c.patchFolder(id, body)
    const lib = loadLibrary()
    if (lib) saveLibrary(lib.docs, lib.folders.map((x) => (x.id === id ? f : x)))
    return f
  }
)

ipcMain.handle('folder:delete', async (_e, id: string) => {
  const c = ensureClient()
  await c.deleteFolder(id)
  const lib = loadLibrary()
  if (lib) saveLibrary(lib.docs, lib.folders.filter((x) => x.id !== id && x.parent_id !== id))
  return { ok: true }
})

ipcMain.handle('folder:create', async (_e, name: string) => {
  const c = ensureClient()
  const f = await c.createFolder(name)
  const lib = loadLibrary()
  if (lib) saveLibrary(lib.docs, [...lib.folders, f])
  return f
})

ipcMain.handle('annotations:pull', async (_e, docId: string) => {
  const c = ensureClient()
  return c.listAnnotations(docId)
})

ipcMain.handle('annotations:fileHash', async (_e, docId: string) => {
  const c = ensureClient()
  return c.fileHash(docId)
})

ipcMain.handle(
  'annotations:push',
  async (_e, docId: string, filehash: string, items: { page: number; x: number; y: number; w: number; h: number }[]) => {
    const c = ensureClient()
    const out: CloudAnnotation[] = []
    for (const it of items) {
      const created = await c.createAnnotation({
        document_id: docId,
        filehash,
        type: 'highlight',
        positions: [
          {
            top_left: { x: it.x, y: it.y },
            bottom_right: { x: it.x + it.w, y: it.y + it.h },
            page: it.page
          }
        ]
      })
      out.push(created)
    }
    return out
  }
)

ipcMain.handle('annotations:deleteRemote', async (_e, id: string) => {
  const c = ensureClient()
  await c.deleteAnnotation(id)
  return { ok: true }
})

ipcMain.handle('annotations:load', () => loadAnnotations())
ipcMain.handle('annotations:save', (_e, list: Annotation[]) => {
  saveAnnotations(list)
  return { ok: true }
})

// notes are local only: Mendeley's /notes endpoint does not exist
ipcMain.handle('notes:load', () => loadNotes())
ipcMain.handle('notes:save', (_e, notes: Record<string, string>) => {
  saveNotes(notes)
  return { ok: true }
})

/** Name a downloaded PDF the way Mendeley Desktop would, so that the title
 *  matcher in pdfindex.ts picks it up again on the next scan instead of
 *  leaving it as an orphan file. */
function pdfNameFor(doc: Doc | undefined, fallback?: string): string {
  const safe = (s: string) =>
    (s || '')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const author = (() => {
    const a = doc?.authors?.[0]
    if (!a) return ''
    const first = a.last_name || a.first_name || ''
    if (!first) return ''
    return doc!.authors!.length > 1 ? `${first} et al.` : first
  })()
  const parts = [author, doc?.year ? String(doc.year) : '', safe(doc?.title ?? '')]
    .filter(Boolean)
    .join(' - ')
  const base = safe(parts || safe(fallback || 'download') || 'download')
  return (base.slice(0, 150) || 'download') + '.pdf'
}

ipcMain.handle('doc:create', async (_e, body: Record<string, unknown>) => {
  const c = ensureClient()
  const doc = await c.createDocument(body)
  const lib = loadLibrary()
  if (lib) saveLibrary([...lib.docs, doc], lib.folders)
  return doc
})

ipcMain.handle('dialog:openFiles', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '参考文献',
        extensions: ['bib', 'bibtex', 'ris', 'xml', 'enw', 'txt']
      }
    ]
  })
  if (r.canceled || !r.filePaths.length) return []
  return r.filePaths.map((p) => ({
    name: path.basename(p),
    text: fs.readFileSync(p, 'utf-8')
  }))
})

ipcMain.handle('meta:lookup', async (_e, docId: string) => {
  const lib = loadLibrary()
  const doc = lib?.docs.find((d) => d.id === docId)
  if (!doc) return []
  return lookup(doc)
})

/** Add a paper by pasting a DOI, an arXiv id or a title.  Mendeley's catalogue
 *  needs a token, but the whole thing is still useful without one: the DOI
 *  then falls back to Crossref, which is anonymous. */
ipcMain.handle('meta:resolve', async (_e, value: string) => {
  let bearer: string | undefined
  try {
    bearer = await ensureClient().bearer()
  } catch {
    /* no token: DOI resolution degrades to Crossref instead of failing */
  }
  return resolveIdentifier(value, bearer)
})

ipcMain.handle(
  'doc:importPdf',
  async (_e, name: string, bytes: ArrayBuffer, ids: { doi?: string; arxiv?: string }) => {
    const c = ensureClient()
    const buf = Buffer.from(bytes)
    const created = await c.createDocumentFromFile(name, buf)
    // The server reads metadata out of the PDF itself — title, authors, year
    // and identifiers all come back filled in for a real paper, and that is
    // far better than anything the file name can tell us.  Only fall back to
    // the "author - year - title.pdf" shape when extraction found nothing,
    // otherwise the patch would overwrite a correct title with a worse one.
    const base = name.replace(/\.pdf$/i, '')
    const p = parseName(name)
    const patch: Record<string, unknown> = {}
    if (!created.title || created.title === base) {
      if (p.title && p.title !== base) patch.title = p.title
      if (p.year) patch.year = p.year
    }
    // doi/arxiv are ignored at the top level; they live under identifiers
    const ident: Record<string, string> = { ...(created.identifiers ?? {}) }
    if (ids?.doi && !ident.doi) ident.doi = ids.doi
    if (ids?.arxiv && !ident.arxiv) ident.arxiv = ids.arxiv
    if (
      ident.doi !== created.identifiers?.doi ||
      ident.arxiv !== created.identifiers?.arxiv
    ) {
      patch.identifiers = ident
    }
    let doc = created
    if (Object.keys(patch).length) {
      try {
        doc = await c.patchDocument(created.id, patch)
      } catch {
        /* a bad guess is not worth failing the import over */
      }
    }
    // keep a local copy next to the rest of the library so it opens without
    // another round trip to the cloud
    const cfg = loadConfig()
    const dir = cfg.pdfDir || DEFAULT_PDF_DIR
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, pdfNameFor(doc, name))
    if (buf.length) fs.writeFileSync(dest, buf)
    doc.localPdf = dest
    doc.file_attached = true
    const lib = loadLibrary()
    if (lib) {
      saveLibrary(
        lib.docs.some((d) => d.id === doc.id) ? lib.docs : [...lib.docs, doc],
        lib.folders
      )
    }
    return doc
  }
)

ipcMain.handle('pdf:download', async (_e, docId: string) => {
  try {
    const c = ensureClient()
    const meta = await c.fileMeta(docId)
    if (!meta) return { ok: false, error: '云端没有这篇的附件' }
    const buf = await c.downloadFile(meta.id)
    const cfg = loadConfig()
    const dir = cfg.pdfDir || DEFAULT_PDF_DIR
    fs.mkdirSync(dir, { recursive: true })
    const lib = loadLibrary()
    const doc = lib?.docs.find((d) => d.id === docId)
    let dest = path.join(dir, pdfNameFor(doc, meta.file_name))
    for (let n = 2; fs.existsSync(dest) && n < 50; n++) {
      dest = path.join(dir, pdfNameFor(doc, meta.file_name).replace(/\.pdf$/, ` (${n}).pdf`))
    }
    fs.writeFileSync(dest, buf)
    if (lib && doc) {
      doc.localPdf = dest
      saveLibrary(lib.docs, lib.folders)
    }
    return { ok: true, path: dest, size: buf.length }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('pdf:read', async (_e, p: string) => {
  try {
    const buf = fs.readFileSync(p)
    return { ok: true, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// updater events are pushed to the renderer, which renders them in the toolbar
initUpdater((s: UpdateState) => win?.webContents.send('updater:state', s))

ipcMain.handle('shell:openExternal', (_e, url: string) => {
  shell.openExternal(url)
  return { ok: true }
})

export type { Doc, Folder }
