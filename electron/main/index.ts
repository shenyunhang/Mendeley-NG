import { BrowserWindow, app, clipboard, dialog, ipcMain, net, protocol, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Mendeley, findToken, importTokenFrom } from './mendeley'
import {
  DEFAULT_PDF_DIR,
  dataDir,
  loadAnnotations,
  loadConfig,
  loadLibrary,
  loadNotes,
  loadReading,
  saveAnnotations,
  saveConfig,
  saveLibrary,
  saveNotes,
  saveReading
} from './store'
import { attachPdfs, parseName } from './pdfindex'
import { lookup, resolveIdentifier } from './lookup'
import {
  initFullText,
  ftAdd,
  ftBuild,
  ftCancel,
  ftClear,
  ftSearch,
  ftStatus,
  setFullTextPages
} from './fulltext'
import type { FtStatus } from '../../shared/types'
import { initUpdater, type UpdateState } from './updater'
import type {
  Annotation,
  AppConfig,
  CloudAnnotation,
  Doc,
  Folder,
  SyncStatus
} from '../../shared/types'
import { DEFAULT_PDF_TEMPLATE } from '../../shared/types'

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
    /**
     * The taskbar and the title bar take this.  `build/icon.ico` is what goes
     * on the exe and the installer, but that directory is electron-builder's
     * and is not copied into the app, so the window needs the copy under
     * assets/.  `app.getAppPath()` is the project root unpacked and the asar
     * packaged, which is why the one path works in both.
     */
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
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

  // The file naming template.  Only its preview is exercised: actually
  // renaming moves files on disk, so confirm is stubbed to refuse and the
  // template is put back afterwards.
  const tpl0 = cfg0.pdfNameTemplate
  await w.webContents.executeJavaScript('(()=>{window.confirm=()=>false;return 1})()')
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
  await w.webContents.executeJavaScript(
    `(async()=>{await window.api.setConfig({`
    + `pdfNameTemplate:${JSON.stringify(tpl0 ?? '{authors} - {year} - {title}')}});`
    + `delete window.confirm;return 1})()`
  )

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
  expect('the row menu offers actions and separators', mi.items.length >= 4 && mi.seps >= 1, mi)
  expect('the row menu stays inside the window', mi.inWindow === true, mi)
  expect(
    'the row menu can hand the file to the OS',
    mi.items.includes('在文件夹中显示') && mi.items.includes('用系统程序打开'),
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
  await new Promise((r) => setTimeout(r, 400))
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
  await w.webContents.executeJavaScript('window.api.copyText("")')
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".row-menu-item")]'
    + '.find(x=>x.textContent.trim()==="复制标题");if(!b)return 0;b.click();return 1})()'
  )
  // 900 rather than 600: the write goes through an IPC round trip and under
  // load the read wins the race, which fails this check for a reason that has
  // nothing to do with the menu
  await new Promise((r) => setTimeout(r, 900))
  const titleCopied = await w.webContents.executeJavaScript('window.api.readClipboard()')
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
  log('render src (current page)', await src())
  const backOne = JSON.parse(await turn('←'))
  const fwdAgain = JSON.parse(await turn('→'))
  // a page turn onto a warmed neighbour must not re-render from scratch:
  // either the bitmap is already in the cache, or the warm that was started
  // for it is joined instead of duplicated
  expect('prefetch serves a step back', backOne.src === 'cache', backOne)
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
  expect('continuous lays out every page', cTop.pages === 4, cTop)
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
  const made = await addSinceBefore()
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
  // The cross-document annotation list.  It runs here, after a highlight has
  // been made, so there is something to list; and it only reads, because
  // deleting one of the user's real annotations is not a smoke run's business.
  log(
    'click 全部标注',
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
      + '.find(x=>x.textContent.trim()==="全部标注");if(!b)return "missing";b.click();return "ok"})()'
    )
  )
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
      + 'const rows=document.querySelectorAll("div.row").length;'
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
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".toolbar input");'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"the");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 1200))
  const ftRows = await w.webContents.executeJavaScript(
    'JSON.stringify({rows:document.querySelectorAll(".ft-row").length,'
    + 'hits:document.querySelectorAll(".ft-hit").length,'
    + 'pages:[...document.querySelectorAll(".ft-hit .pg")].slice(0,3).map(p=>p.textContent),'
    + 'snip:(document.querySelector(".ft-snip")||{}).textContent||null})'
  )
  log('ft results', ftRows)
  const ftOut = JSON.parse(ftRows)
  expect('full text finds hits', ftOut.rows > 0 && ftOut.hits > 0, ftOut)
  expect('a hit carries a page number', /^p\d+$/.test(ftOut.pages[0] ?? ''), ftOut.pages)
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
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pane-head button")]'
    + '.find(x=>x.textContent.trim()==="返回列表");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 400))

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
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".batch-bar button")]'
    + '.find(x=>x.textContent.trim()==="取消选择");if(b)b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 300))

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
  expect(
    'the about section carries the mark',
    typeof si.mark === 'string' && si.mark.startsWith('data:image/svg'),
    si.mark
  )
  expect('the settings panel opens', si.open === 1, si)
  expect(
    'it gathers every section in one place',
    si.secs.includes('外观') && si.secs.includes('文件') && si.secs.includes('全文检索'),
    si
  )
  expect('it shows the version', si.version === true, si)
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
  // the run left the throwaway index holding only those four; put it back the
  // way the next run expects to find it
  ftClear()

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

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('config:get', () => loadConfig())
ipcMain.handle('config:set', (_e, c: Partial<AppConfig>) => {
  const cur = loadConfig()
  saveConfig({ ...cur, ...c })
  // The full-text page budget lives in the index, not just in the config: it
  // has to take effect the moment it is written, or the index on disk keeps
  // describing a corpus nobody is asking about any more.
  if (typeof c.ftPages === 'number') setFullTextPages(c.ftPages)
  return loadConfig()
})

// The renderer is a file:// page, where navigator.clipboard is a permission
// policy away from silently doing nothing.  Going through Electron's own
// clipboard is deterministic, and it lets the smoke run read back what was
// copied instead of trusting that a write happened.
ipcMain.handle('clipboard:write', (_e, text: string) => {
  clipboard.writeText(String(text ?? ''))
  return true
})
ipcMain.handle('clipboard:read', () => clipboard.readText())

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

// Reading position is a whole-file rewrite per change, but a change is one
// debounced write per document left, not one per page turned, so it stays
// cheap.  Kept in the main process so the renderer cannot lose it by
// navigating away mid-write.
ipcMain.handle('reading:load', () => loadReading())
let reading: Record<string, number> | null = null
ipcMain.handle('reading:set', (_e, docId: string, page: number) => {
  if (reading === null) reading = loadReading()
  reading[docId] = Math.max(1, Math.floor(Number(page) || 1))
  saveReading(reading)
  return { ok: true }
})

/** Placeholders a naming template can use.  Kept next to the function that
 *  expands them so the two cannot drift apart. */
const PDF_NAME_FIELDS = ['title', 'year', 'authors', 'journal', 'key', 'type', 'doi']

/** Name a downloaded PDF from a template.  Segments left empty by a missing
 *  field are dropped rather than leaving a run of dangling separators, so
 *  `{authors} - {year} - {title}` on a paper with no year does not produce
 *  "Knuth -  - On writing". */
function pdfNameFor(
  doc: Doc | undefined,
  fallback?: string,
  template: string = DEFAULT_PDF_TEMPLATE
): string {
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
  const vals: Record<string, string> = {
    title: safe(doc?.title ?? ''),
    year: doc?.year ? String(doc.year) : '',
    authors: author,
    journal: safe(doc?.source ?? ''),
    key: safe(doc?.citation_key ?? ''),
    type: safe(doc?.type ?? ''),
    doi: safe(doc?.identifiers?.doi ?? doc?.doi ?? '')
  }
  const expanded = safe(template).replace(/\{(\w+)\}/g, (_, k: string) => vals[k] ?? '')
  // split on the separator and drop the empty pieces, then put them back
  const parts = expanded.split(/\s*-\s*/).filter((s) => s.trim())
  const base = safe(parts.join(' - ') || safe(fallback || '') || 'download')
  return (base.slice(0, 150) || 'download') + '.pdf'
}

/**
 * Rename every local PDF to the template, or say what it would do.
 * `apply: false` is a preview: renaming files on disk is not something to
 * discover the shape of by doing it.
 */
ipcMain.handle(
  'pdf:rename',
  async (_e, template: string, apply: boolean) => {
    const lib = loadLibrary()
    if (!lib) return { total: 0, renamed: 0, skipped: 0, sample: [] as string[] }
    const plan: { doc: Doc; from: string; to: string }[] = []
    for (const d of lib.docs) {
      const from = d.localPdf
      if (!from || !fs.existsSync(from)) continue
      const to = path.join(path.dirname(from), pdfNameFor(d, undefined, template))
      if (path.normalize(to) === path.normalize(from)) continue
      plan.push({ doc: d, from, to })
    }
    const sample = plan.slice(0, 5).map((p) => `${path.basename(p.from)}  ->  ${path.basename(p.to)}`)
    if (!apply) return { total: plan.length, renamed: 0, skipped: 0, sample }

    let renamed = 0
    let skipped = 0
    const touched = new Set<string>()
    for (const p of plan) {
      // a name that is already taken is left alone rather than overwritten:
      // two papers can legitimately want the same file name
      if (fs.existsSync(p.to)) {
        skipped++
        continue
      }
      try {
        fs.renameSync(p.from, p.to)
        p.doc.localPdf = p.to
        touched.add(p.doc.id)
        renamed++
      } catch {
        skipped++
      }
    }
    if (renamed) saveLibrary(lib.docs, lib.folders)
    return { total: plan.length, renamed, skipped, sample }
  }
)

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
    const dest = path.join(dir, pdfNameFor(doc, name, cfg.pdfNameTemplate))
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
    indexAdded(doc)
    return doc
  }
)

/**
 * Index a paper that has just been given a local PDF.
 *
 * It is not awaited: the import has already answered, and the point of it is
 * that nothing is asked of the reader.  One PDF is a fraction of a second,
 * where indexing the library takes minutes — which is why a newly imported
 * paper used to stay invisible to full-text search until the whole thing was
 * rebuilt, and usually was not.
 */
function indexAdded(doc: Doc) {
  void ftAdd([doc], [doc.id])
    .then((n) => {
      if (n > 0) win?.webContents.send('ft:progress', ftStatus(ftDocs()))
    })
    .catch(() => undefined)
}

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
    let dest = path.join(dir, pdfNameFor(doc, meta.file_name, cfg.pdfNameTemplate))
    for (let n = 2; fs.existsSync(dest) && n < 50; n++) {
      dest = path.join(
        dir,
        pdfNameFor(doc, meta.file_name, cfg.pdfNameTemplate).replace(/\.pdf$/, ` (${n}).pdf`)
      )
    }
    fs.writeFileSync(dest, buf)
    if (lib && doc) {
      doc.localPdf = dest
      saveLibrary(lib.docs, lib.folders)
      // a paper pulled down from the cloud is as new to the index as one that
      // was imported; it has to be searchable for the same reason
      indexAdded(doc)
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
// MENDELEY_FT_DIR puts the index somewhere other than alongside the library,
// which is also how the smoke run keeps a throwaway index of its own.
// MENDELEY_FT_LIMIT caps how many documents one run will read; it exists so
// the smoke run can exercise indexing without reading every PDF.
initFullText(process.env.MENDELEY_FT_DIR || dataDir())
// The page budget has to be in force before anything asks for a status,
// because a status read with the wrong budget reports an index that was built
// for a different question.
{
  const p = Number(loadConfig().ftPages ?? 0)
  if (p > 0) setFullTextPages(p)
}
const ftDocs = () => {
  const all = loadLibrary()?.docs ?? []
  const n = Number(process.env.MENDELEY_FT_LIMIT || 0)
  if (n <= 0) return all
  return all.filter((d) => d.localPdf).slice(0, n)
}

// Full-text search.  Building the index reads every local PDF, which takes
// minutes on a large library, so it is started on request and reports
// progress rather than blocking an invoke for the whole run.
ipcMain.handle('ft:status', () => ftStatus(ftDocs()))
ipcMain.handle('ft:build', async (_e, rebuild?: boolean) => {
  const docs = ftDocs()
  const send = (s: FtStatus) => win?.webContents.send('ft:progress', s)
  void ftBuild(docs, send, !!rebuild).catch(() => {})
  return ftStatus(docs)
})
// Stopping a build has to be its own call.  The build is answered
// immediately and runs in the background, so "cancel" cannot arrive on the
// same channel as the thing being cancelled.
ipcMain.handle('ft:cancel', () => {
  ftCancel()
  return ftStatus(ftDocs())
})
ipcMain.handle('ft:clear', () => {
  ftClear()
  return ftStatus(ftDocs())
})
ipcMain.handle('ft:search', (_e, q: string) => ftSearch(q))

initUpdater((s: UpdateState) => win?.webContents.send('updater:state', s))

ipcMain.handle('shell:openExternal', (_e, url: string) => {
  shell.openExternal(url)
  return { ok: true }
})

// Sometimes the file itself is the thing to work on: rename it, move it, or
// read it in an external reader.  Both go through shell rather than child
// processes, so the file manager and the default PDF handler are the ones the
// user already chose.
ipcMain.handle('pdf:reveal', (_e, p: string) => {
  if (!p) return { ok: false, error: 'no path' }
  shell.showItemInFolder(p)
  return { ok: true }
})

ipcMain.handle('pdf:openExternal', (_e, p: string) => {
  if (!p) return { ok: false, error: 'no path' }
  return shell.openPath(p)
})

export type { Doc, Folder }
