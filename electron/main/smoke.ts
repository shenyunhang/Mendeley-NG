import { FAILURE, ignoreFailure, reportFailure, setFailureSink, failureCounts, resetFailureCounts } from '../../shared/failures'
import { clampToRange } from '../../shared/clamp'
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
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
import {
  DEFAULT_FT_PAGES,
  PROJECT_URL,
  type Annotation,
  type CloudAnnotation,
  type Doc,
  type MetaCandidate,
  type PdfPos
} from '../../shared/types'
// A start-up pass over the marks must merge without an open PDF and without
// losing a mark drawn while the network was in flight. Its rules are pure,
// so the ordering is checked here with fixed inputs (176).
import {
  applyMergedAnnotations,
  markPushed,
  mergeCloudAnnotations
} from '../../src/lib/annotationMerge'
// The page budget is written in the renderer and read in the main process.
// Both halves used to carry their own copy of the same clamp and their own
// idea of the default. The rule is shared now, and this run checks that the
// extraction answers exactly what both old copies answered.
import {
  bitmapPixelSize,
  devicePixelRatioOrOne
} from '../../src/lib/bitmapPixelSize'
import {
  clampFullTextPages,
  FULL_TEXT_MAX_PAGES,
  FULL_TEXT_MIN_PAGES,
  restoredPageBudget
} from '../../shared/fullTextPages'
// The Settings field is committed on blur. It is pure too, so the number
// written and the number shown can be checked against the old form without
// opening a window -- and its wiring is read back from the source (171).
import { commitPageBudget } from '../../src/lib/pageBudgetCommit'
// A text layer and a find hit both stitch one rectangle per line. The merge
// is shared now, but each caller keeps its own "same line" test, so this run
// checks both old loops verbatim and proves the two tests really differ (172).
import { mergeRectsIntoLines } from '../../src/lib/rectLines'
// Neighbouring-page bitmaps are keyed by page, scale and pixel ratio, with no
// document id in the key. Clearing the two maps on a paper change used to
// leave an in-flight render free to land the previous paper's bitmap on the
// new paper's canvas. The cache is DOM-free and generic now, so that ordering
// can be checked here by resolving render promises by hand (173).
import { PrefetchCache, StaleFlight } from '../../src/lib/pdfcache'
// This one lives with the renderer, but it is a pure function with no DOM in
// it, and the note it carries is the only data in the app that exists nowhere
// else — a claim about being able to take your library with you is worth one
// import across the boundary to have checked on every run.
import {
  humanBytes,
  toAnnotationsMarkdown,
  toBibtex,
  toEndnoteXml,
  toExitReadme,
  toNotesMarkdown
} from '../../src/lib/export'
// A copied \cite{...} and an exported BibTeX key are supposed to name the
// same paper, and they did not for a Chinese surname: one rule kept CJK
// letters, the other stripped them to `anon`. The stem is shared now; the
// disambiguation letter and the way the surname is picked stay with their
// callers (175).
import { formatCitation } from '../../src/lib/cite'
import { citationKeyStem } from '../../src/lib/citeKey'
// Both virtualised lists bubble row clicks up to their container, so the
// decision "was this click on a row?" has to be made on the target. The rule
// is shared and takes the row class as a parameter (177).
import { isListBlank } from '../../src/lib/listBlank'
// Opening a reference that is already in the library has to bring the folder
// tree with it. Which folder is chosen is a pure rule, checked here with
// fixed documents and folders (178).
import { folderForOpenedDoc } from '../../src/lib/folderForDoc'
// The list column and the details pane both answer "when did this join the
// library?" with the same day, extracted from Mendeley's `created` (180).
import { shortDate } from '../../shared/shortDate'
// A pull used to overwrite the cache with the snapshot it took at the start,
// resurrecting papers trashed while it was in flight. The write is a
// three-way decision now, checked here with fixed arrays (181).
import { reconcileSyncWrite } from '../../shared/libraryReconcile'
import { describeSyncFailure } from '../../src/lib/offline'
// One short-lived message and one pending clear, checked with a clock that
// is advanced by hand: a timeout that outlives the message that asked for it
// is a race, and a race cannot be checked by sleeping and hoping.
import { createFlashMessage, type FlashClock } from '../../src/lib/flash'
// A debounced lookup that may only answer the word still on screen, checked
// with a clock advanced by hand and promises resolved by hand: cancelling a
// timer is not the same as cancelling the request it already started.
import {
  answerFor,
  createLatestSearch,
  type SearchAnswer,
  type SearchClock
} from '../../src/lib/latestSearch'
// The reader keeps one component across papers, so a highlight read has to be
// tied to the paper that asked for it. Ordering is checked by resolving the
// reads by hand, not by hoping the disk answers in the order it was asked.
import {
  createDocumentLoad,
  createDocumentScope,
  valueForDocument,
  type ForDocument
} from '../../src/lib/documentScope'
// A find scan publishes hits page by page and opens the bar on its last page.
// Both writes belong to the word that started it: closing the box used to
// clear the state but leave the walk running, so the bar came back with the
// old word's marks. Checked by resolving one page at a time, not by sleeping.
import {
  answerBusy,
  answerHits,
  createFindScan,
  type ScanAnswer
} from '../../src/lib/findScan'
// Links and citation markers are pulled a page at a time. Clearing the state
// on a paper change does not stop a read of the old PDF from landing a moment
// later, so the order is controlled by resolving each page read by hand.
import { createLazyPages, type PageAnswer } from '../../src/lib/lazyPages'

// Eight product-side delays used to be bare literals at eight call sites.
// Giving them names is a readability change only if no number moved, so this
// run checks the names against the old literals and reads the call sites to
// confirm they actually use them (164).
import {
  ALL_HAVE_PDF_MESSAGE_VISIBLE_MS,
  BATCH_ACTION_MESSAGE_VISIBLE_MS,
  BATCH_CLEAN_MESSAGE_VISIBLE_MS,
  BATCH_FAILED_MESSAGE_VISIBLE_MS,
  CITATION_COPIED_MESSAGE_VISIBLE_MS,
  COLUMN_WIDTH_PERSIST_DEBOUNCE_MS,
  COPIED_FEEDBACK_VISIBLE_MS,
  DOWNLOAD_STOPPED_MESSAGE_VISIBLE_MS,
  EXPORT_ANNOTATIONS_MESSAGE_VISIBLE_MS,
  EXPORT_BIBLIOGRAPHY_MESSAGE_VISIBLE_MS,
  EXPORT_LIBRARY_MESSAGE_VISIBLE_MS,
  EXPORT_NOTES_MESSAGE_VISIBLE_MS,
  FIND_QUERY_DEBOUNCE_MS,
  FOLDER_NOOP_MESSAGE_VISIBLE_MS,
  FULL_TEXT_QUERY_DEBOUNCE_MS,
  HIGHLIGHT_UNDO_WINDOW_MS,
  IMPORT_FINISHED_MESSAGE_VISIBLE_MS,
  PANE_WIDTH_PERSIST_DEBOUNCE_MS,
  READING_POSITION_PERSIST_DEBOUNCE_MS,
  RENAME_RESULT_MESSAGE_VISIBLE_MS,
  STARTUP_UPDATE_CHECK_DELAY_MS,
  UPDATE_INSTALL_DELAY_MS
} from '../../src/lib/timing'
// Continuous mode walks every page in the background, once for links and
// once for citation markers. Both loops used to be written out in full down to
// a literal 8, and "one column rebuild per screenful" had no test of its own.
// The rule is pure now: promises resolve by hand, no PDF, no sleeping.
import {
  createPageWalk,
  PAGE_BATCH_SIZE,
  type PageWalkHost
} from '../../src/lib/pageWalk'
// A fixed citation card measured once stays at its old coordinates when the
// window changes. The placement rule takes its viewport as an argument so a
// resize can be checked by handing it a smaller one, rather than resizing a
// real window in the middle of a run full of coordinate assertions.
import {
  createCardSpotter,
  spotFor,
  GAP,
  type Box,
  type Spot,
  type Viewport
} from '../../src/lib/cardSpot'
// The reference list is read out of the paper in the renderer, but the rules
// that decide whether it was read correctly are pure, and a popover that
// names the wrong paper is the kind of mistake that has to be caught on every
// run rather than believed.
import {
  citeNums,
  docForRef,
  docForUrl,
  idIndex,
  isRefHead,
  linesOf,
  markersIn,
  parseRefEntries
} from '../../src/lib/refly'
import { ensureClient, sync } from './library'
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
 * The config as the run found it, kept at module scope so that a run which
 * never reaches its last line can still put it back.
 *
 * It is written down the moment it is read rather than at the end, because
 * the end is exactly what a crash skips.  A run that died half way used to
 * leave the column layout half-changed and the sort pointing at whatever the
 * last press picked; the next run then started from that, and one red line
 * became a dozen more, each a symptom of the first and none saying so.
 */
let cfgSnapshot: Record<string, unknown> | null = null

/**
 * Put back the keys the run is free to change, whether it finished or not.
 * Safe to call twice: a run that got to its own last line already did this,
 * and the caller cannot tell.
 */
export function restoreSmokeConfig() {
  if (!cfgSnapshot) return
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
  for (const k of putBack) {
    if (cfgSnapshot[k] !== undefined) end[k] = cfgSnapshot[k]
    else delete end[k]
  }
  saveConfig(end as never)
  console.log(
    '[smoke] config put back',
    putBack.map((k) => `${k}:${cfgSnapshot![k] === undefined ? '-' : 'set'}`).join(' ')
  )
}

/**
 * `--smoke` runs the whole stack headlessly and writes a screenshot, which is
 * the only way to confirm both the sync pipeline and the high-DPI rendering
 * from a command line.  It is a development aid, never used by the packaged app.
 */
/**
 * Another copy of the app running on this machine, or null.
 *
 * The installed build and this one are different executables over the same
 * userData, and Electron's single-instance lock does not see across them:
 * both open, both read the library at start, both write the config whenever
 * they feel like it.  Windows only, because that is where this runs; a check
 * that cannot run says nothing rather than guessing.
 */
function otherInstanceRunning(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execSync('tasklist /NH /FO CSV /FI "IMAGENAME eq Mendeley NG.exe"', {
      encoding: 'utf8',
      windowsHide: true
    })
    const rows = out
      .split(/\r?\n/)
      .filter((l) => l.includes('Mendeley NG.exe'))
    if (!rows.length) return null
    const pid = rows[0].split('","')[1] ?? '?'
    return `${rows.length} 个进程，第一个 pid ${pid}`
  } catch {
    // tasklist answers "no tasks match" with a non-zero exit rather than with
    // an empty list, so this is the common case and not a failure to report
    return null
  }
}

export async function runSmoke() {
  const log = (...a: unknown[]) => console.log('[smoke]', ...a)
  // This run writes the reader's real config, in the reader's real
  // userData — that is the point of it, and it is also why a second copy of
  // the app left running on this machine is fatal to it.  Both hold the same
  // file; whichever writes last wins, and the loser is not told.  The symptom
  // is not an error but a check that fails at random — "the new order is
  // remembered" being handed back a layout the other window wrote ten hours
  // ago — which is worse than an error, because it looks like a bug in the
  // thing under test.  Refuse before the run rather than explain after it.
  const other = otherInstanceRunning()
  if (other) {
    const msg =
      `另一份 Mendeley NG 正在运行（${other}），它和这次冒烟用同一个数据目录 `
      + `(${dataDir()})，两边会写同一个 config.json，跑出来的红是随机的、`
      + '而且不是被测代码的错。先关掉它再跑。'
    log('ANOTHER INSTANCE', other)
    if (process.env.SMOKE_ALLOW_OTHER_INSTANCE !== '1') throw new Error(msg)
    log('continuing anyway because SMOKE_ALLOW_OTHER_INSTANCE=1')
  }

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

  // A start-up pass over the marks has to be asked for, not merely defined.
  // Hold the handler before the window exists: the renderer's API is frozen
  // by contextBridge, and swapping the main-process handler is the only way
  // to count the call without talking to the real cloud (174).
  const startupHandlers = (
    ipcMain as unknown as {
      _invokeHandlers?: Map<string, (...args: unknown[]) => unknown>
    }
  )._invokeHandlers
  const savedMarksSync = startupHandlers?.get('annotations:syncAtStart')
  let startSyncCalls = 0
  if (savedMarksSync) {
    ipcMain.removeHandler('annotations:syncAtStart')
    ipcMain.handle('annotations:syncAtStart', async () => {
      startSyncCalls += 1
      return { docs: 0, pulled: 0, pushed: 0, skipped: [] }
    })
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

  // The mark is checked from its pixels, not by eye. The generator writes
  // 8-bit RGBA with filter 0 on every row, so the icon can be read back with
  // nothing but zlib: no tile behind the sheet, one cool colour family, and
  // a vector source with no cut slips or cords (179).
  {
    const decodeIconPng = (buf: Buffer) => {
      let off = 8
      let n = 0
      const parts: Buffer[] = []
      while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off)
        const type = buf.toString('ascii', off + 4, off + 8)
        const data = buf.subarray(off + 8, off + 8 + len)
        if (type === 'IHDR') n = data.readUInt32BE(0)
        if (type === 'IDAT') parts.push(data)
        off += 12 + len
      }
      const raw = zlib.inflateSync(Buffer.concat(parts))
      const stride = n * 4
      const rgba = new Uint8Array(stride * n)
      for (let y = 0; y < n; y++) {
        const at = y * (stride + 1)
        if (raw[at] !== 0) throw new Error('unexpected PNG row filter')
        for (let x = 0; x < stride; x++) rgba[y * stride + x] = raw[at + 1 + x]
      }
      return { n, rgba }
    }
    const iconDir = path.join(app.getAppPath(), 'assets')
    const { n, rgba } = decodeIconPng(fs.readFileSync(path.join(iconDir, 'icon.png')))
    const alphaAt = (x: number, y: number) => rgba[(y * n + x) * 4 + 3]
    const corners = [
      alphaAt(0, 0), alphaAt(n - 1, 0), alphaAt(0, n - 1), alphaAt(n - 1, n - 1)
    ]
    let opaque = 0
    let warm = 0
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i]
      const b = rgba[i + 2]
      if (rgba[i + 3] < 200) continue
      opaque++
      // red, orange and yellow all have a red channel well above blue; the
      // new mark is violet -> blue -> cyan and has none of them
      if (r > b + 40 && r > 140) warm++
    }
    expect(
      'the icon has no tile behind it',
      corners.every((a) => a === 0),
      { corners, n }
    )
    expect(
      'the icon stays in one cool colour family',
      opaque > (n * n) / 20 && warm === 0,
      { opaque, warm, n }
    )
    const svgText = fs.readFileSync(path.join(iconDir, 'logo.svg'), 'utf8')
    expect(
      'the vector source has no cut slips or cords',
      !svgText.includes('<mask') &&
        !svgText.includes('stroke-dasharray') &&
        svgText.length < 4096,
      { bytes: svgText.length }
    )
    const genText = fs.readFileSync(
      path.join(app.getAppPath(), 'scripts', 'make-icon.mjs'),
      'utf8'
    )
    expect(
      'the generator draws one continuous sheet with two colour stops',
      !genText.includes('const SLIP') &&
        !genText.includes('const CORD') &&
        !genText.includes('inGap(') &&
        !genText.includes('onCord(') &&
        (genText.match(/^  \[0\.0, \[/m) ?? []).length === 1 &&
        (genText.match(/^  \[1\.0, \[/m) ?? []).length === 1,
      { bytes: genText.length }
    )
  }
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

  // The marks pass is started by that same quiet pull, after the library
  // answer comes back. Poll the counter rather than assuming the status line
  // and the answer arrive in one tick; the count is deterministic, only its
  // arrival time is not.
  for (let i = 0; i < 40 && startSyncCalls === 0; i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(
    'a start-up pull also asks for the cloud copy of the marks',
    !!savedMarksSync && startSyncCalls >= 1,
    { startSyncCalls, handlerPresent: !!savedMarksSync }
  )
  if (savedMarksSync) {
    ipcMain.removeHandler('annotations:syncAtStart')
    ipcMain.handle(
      'annotations:syncAtStart',
      savedMarksSync as Parameters<typeof ipcMain.handle>[1]
    )
  }

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
      + 'inWindow:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,'
      + 'placed:!!(c.style.left&&c.style.top),inlineLeft:c.style.left,inlineTop:c.style.top}};'
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
  // A `position: fixed` card with no inline left/top is sitting at its
  // static position, which is exactly what `spotFor` exists to replace: the
  // window-edge clamp and the flip above the button never run for it. The
  // cards whose components are mounted only while open are the control —
  // their card is in the DOM when the layout effect first runs, so they were
  // always placed. MenuButton is not one of them: it stays mounted and
  // renders its card only when open.
  expect(
    'the more menu is placed by the spot rule, not left at its static position',
    popInfo.more?.placed === true,
    popInfo.more
  )
  expect(
    'the cards that mount with their component were always placed',
    popInfo.filter?.placed === true && popInfo.cols?.placed === true,
    { filter: popInfo.filter, cols: popInfo.cols }
  )
  // and what was removed to make room is still reachable
  const itemsOf = async (label: string): Promise<string[]> => {
    await openMenu(label)
    await new Promise((r) => setTimeout(r, 300))
    const list = JSON.parse(
      await w.webContents.executeJavaScript(
        'JSON.stringify([...document.querySelectorAll(".menu-pop .menu-item")]'
        + '.map(x=>x.textContent.trim()))'
      )
    ) as string[]
    // the same press closes it again.  Leaving one open would put two menus'
    // items under the selector above, and a check that reads both at once is
    // not a check: it would pass on the strength of the wrong menu.
    await openMenu(label)
    await new Promise((r) => setTimeout(r, 200))
    return list
  }
  const moreItems = await itemsOf('更多')
  log('under 更多', moreItems)
  expect(
    'the commands that left the bar are still there',
    ['查重', '全部标注', '回收站', '保存搜索'].every((x) => moreItems.includes(x)),
    moreItems
  )
  // Four of 更多's eight items had a home on the bar and went to it.  What
  // matters is not only that they arrived but that they left: a command that
  // lives in two menus is the kind of duplication nobody notices, and the
  // copy in the wrong place is the one a reader finds first.
  const importItems = await itemsOf('导入')
  log('under 导入', importItems)
  expect(
    'adding by identifier sits with the other way in',
    importItems.some((x) => x.includes('按标识符添加')),
    importItems
  )
  const setupItems = await itemsOf('设置')
  log('under 设置', setupItems)
  expect(
    'a token is next to the settings rather than two menus away',
    setupItems.some((x) => x.includes('导入 token')),
    setupItems
  )
  expect(
    'nothing that moved is still waiting in 更多',
    !moreItems.some((x) => /导入 token|按标识符添加|检查更新|项目主页/.test(x)),
    moreItems
  )

  // The one item in that menu that leaves the app.  A smoke run that really
  // opened a browser on the reader's desktop would be a worse bug than the one
  // being looked for, so the channel is taken over for the press and what is
  // checked is that the address arrives whole and only once.
  const homeOpened: string[] = []
  ipcMain.removeHandler('shell:openExternal')
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    homeOpened.push(url)
    return { ok: true }
  })
  try {
    // the project page moved out of 更多 and into 设置, which is where the
    // other things about this program live; the menu is opened by name so a
    // later move cannot leave this pressing a toggle that no longer holds it
    await openMenu('设置')
    await new Promise((r) => setTimeout(r, 300))
    const homePressed = Number(
      await w.webContents.executeJavaScript(
        '(()=>{const b=[...document.querySelectorAll(".menu-pop .menu-item")]'
        + '.find(x=>x.textContent.includes("项目主页"));if(!b)return 0;b.click();return 1})()'
      )
    )
    await new Promise((r) => setTimeout(r, 400))
    log('project home', { homePressed, homeOpened })
    expect(
      'the menu sends the reader to the project page and nothing else',
      homePressed === 1 && homeOpened.length === 1 && homeOpened[0] === PROJECT_URL,
      { homePressed, homeOpened }
    )
  } finally {
    ipcMain.removeHandler('shell:openExternal')
    ipcMain.handle('shell:openExternal', (_e, url: string) => {
      shell.openExternal(url)
      return { ok: true }
    })
  }

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

  // The in-app flow is the short way in, and its one real guard is refusing
  // to open a window before both values are there: a window that opened, sat
  // there, and then failed on a network request is worse than a line of text
  // under the fields.  Calling it with nothing exercises that guard without
  // opening a window, reaching the network, or changing anything.
  const authGuard = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>JSON.stringify(await window.api.authorize("","")))()'
    )
  )
  log('authorize guard', authGuard)
  expect(
    'authorising without both values is refused instead of opening a window',
    authGuard?.ok === false && /client_id/.test(authGuard.error ?? ''),
    authGuard
  )

  // Whether a row has a PDF used to be a mark that was never drawn.  The only
  // rule that gave it a size was `td .pdf-dot`, written when a row was a table
  // cell; rows have been a CSS grid of divs for several releases, so the
  // selector stopped matching and left the span with no width and no height.
  // The column was in the layout and the mark was not on screen.  So the first
  // question is not what colour it is but whether it has a size at all.
  const pdfMarks = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{'
      + 'const p=document.createElement("span");document.body.appendChild(p);'
      + 'const of=(c)=>{p.className=c;const s=getComputedStyle(p);'
      + 'return [s.width,s.height,s.backgroundColor,s.borderTopWidth,s.opacity].join("|")};'
      + 'const three={local:of("pdf-dot"),cloud:of("pdf-dot cloud"),'
      + 'none:of("pdf-dot no-pdf")};'
      + 'p.remove();'
      + 'const rows=[...document.querySelectorAll("div.row")].map(r=>{'
      + 'const m=r.querySelector(".pdf-dot");'
      + 'return {id:r.dataset.id,w:m?Math.round(m.getBoundingClientRect().width):0,'
      + 'cls:!m?null:m.classList.contains("no-pdf")?"no-pdf":m.classList.contains("cloud")'
      + '?"cloud":"local"}});'
      + 'return JSON.stringify({three,rows})})()'
    )
  )
  log('pdf marks', { three: pdfMarks.three, rows: pdfMarks.rows.length })
  expect(
    'every row carries a mark, and the mark has a size',
    pdfMarks.rows.length > 0 && pdfMarks.rows.every((r: { w: number }) => r.w >= 6),
    pdfMarks.rows.slice(0, 4)
  )

  const threeLooks = new Set(Object.values(pdfMarks.three) as string[])
  expect(
    'local, cloud-only and none are three different marks',
    threeLooks.size === 3 &&
      !(Object.values(pdfMarks.three) as string[]).some((s) => s.startsWith('0px')),
    pdfMarks.three
  )

  // Which mark each row gets is the document's to decide, so it is checked
  // against the library rather than asserted in the abstract: a mark that is
  // drawn but always says "here" would pass the two above.
  const docById = new Map((loadLibrary()?.docs ?? []).map((d) => [d.id, d]))
  const mismatched = pdfMarks.rows.filter((r: { id?: string; cls?: string | null }) => {
    const d = r.id ? docById.get(r.id) : undefined
    if (!d) return false
    const want = d.localPdf ? 'local' : d.file_attached ? 'cloud' : 'no-pdf'
    return r.cls !== want
  })
  const markChecked = pdfMarks.rows.filter(
    (r: { id?: string }) => r.id && docById.has(r.id)
  ).length
  expect(
    'the mark on each row is the one its document asks for',
    markChecked >= 5 && mismatched.length === 0,
    { checked: markChecked, wrong: mismatched.slice(0, 3) }
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

  // A search had no way to end it from where it was typed.  The exits were
  // selecting the word and deleting it, or — when the search happened to find
  // nothing — a button in the empty panel, which is precisely the case where
  // it is least needed: a search that worked left the reader in a card list
  // with nothing to click.
  await w.webContents.executeJavaScript(
    '(()=>{const i=document.querySelector(".toolbar input");'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,"acid");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()'
  )
  await new Promise((r) => setTimeout(r, 500))
  const xShown = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({x:document.querySelectorAll(".search-clear").length,'
      + 'q:document.querySelector(".toolbar input").value})'
    )
  )
  log('search box holding a word', xShown)
  expect(
    'the box offers a way out once there is a word in it',
    xShown.x === 1 && !!xShown.q,
    xShown
  )

  await w.webContents.executeJavaScript(
    '(()=>{const b=document.querySelector(".search-clear");if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 500))
  const xGone = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({x:document.querySelectorAll(".search-clear").length,'
      + 'q:(document.querySelector(".toolbar input")||{}).value||null,'
      + 'rows:document.querySelectorAll("div.row").length,'
      + 'focused:document.activeElement===document.querySelector(".toolbar input")})'
    )
  )
  log('after the ×', xGone)
  // `rows > 0` is the point: with a word in the box the middle pane is cards,
  // so rows coming back is what "normal mode" means.
  expect(
    'pressing it ends the search and gives the library back',
    xGone.x === 0 && !xGone.q && xGone.rows > 0,
    xGone
  )
  // the click would otherwise leave nothing focused at all, and the next key
  // press would go nowhere
  expect('and the box keeps the focus', xGone.focused === true, xGone)

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
  cfgSnapshot = cfg0 as Record<string, unknown>
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
  /**
   * Ask until the page agrees, rather than sleeping for a fixed time.
   *
   * A reload puts a whole new page in, and that page mounts on its own
   * schedule.  Under load a fixed 2500 ms has been watched losing that race,
   * and the run then read the layout off a page that was being thrown away —
   * which is not a small mistake here: one wrong column layout takes the pdf
   * dot off every row, and a dozen checks afterwards then fail for a reason
   * that has nothing to do with any of them.
   */
  const until = async (js: string, ok: (v: unknown) => boolean, ms = 8000) => {
    const t0 = Date.now()
    let last: unknown
    for (;;) {
      last = await w.webContents.executeJavaScript(js).catch(() => undefined)
      if (ok(last) || Date.now() - t0 > ms) return last
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  const OLD_DEFAULT = ['star', 'pdf', 'authors', 'title', 'year', 'source', 'citation_key']
  const atStart: string[] = await headKeys()
  const HEAD_KEYS =
    'JSON.stringify([...document.querySelectorAll(".col-head > div")]'
    + '.map(d=>d.dataset.col))'
  const keysOf = (v: unknown): string[] => {
    try {
      const k = JSON.parse(String(v ?? '[]'))
      return Array.isArray(k) ? k : []
    } catch {
      return []
    }
  }
  const setColsAndReload = async (cols: string[] | null) => {
    // written straight to the config rather than through setConfig, which can
    // only merge: a layout the user never had would come back as a null
    //
    // The migration may add a column, so what is waited for is that every
    // column asked for is on screen, not that the list is exactly it.
    const want = cols ?? atStart
    const has = (v: unknown) => {
      const k = keysOf(v)
      return k.length > 0 && want.every((x) => k.includes(x))
    }
    for (let i = 0; i < 3; i++) {
      const cfg = loadConfig()
      if (cols) cfg.cols = cols
      else delete cfg.cols
      saveConfig(cfg)
      await w.loadFile(path.join(__dirname, '../renderer/index.html'))
      if (has(await until(HEAD_KEYS, has))) {
        await new Promise((r) => setTimeout(r, 400))
        return
      }
      log('reload did not take the layout, again', i + 1)
    }
    await new Promise((r) => setTimeout(r, 400))
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
  log('cols before move', colsBeforeMove)
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
  // What has to hold is that the order on screen reaches disk.  Reading the
  // config the instant the mouse came up was reporting a stale value — one
  // written earlier in the run — as a failure, and a red that means nothing
  // trains everybody to ignore reds.  Waiting for it to match, with a bound,
  // keeps the check and drops the race: if it never matches, it still fails.
  // What has to hold is that the order on screen reaches disk.  Reading the
  // config the instant the mouse came up was reporting a stale value — one
  // written earlier in the run — as a failure, and a red that means nothing
  // trains everybody to ignore reds.  Waiting for it to match, with a bound,
  // keeps the check and drops that race.
  //
  // The bound is 10s because the write is not the slow part: it is an
  // un-awaited invoke from the renderer, and a renderer busy re-laying out
  // five thousand rows queues it behind that work.  Measured: the first
  // poll still answers with the layout the previous check left behind, the
  // second with the one it replaced, and the write lands anywhere in
  // between.  Four seconds was sometimes not enough and read as a lost
  // write.  Every value seen is logged, so a future red says whether the
  // write never arrived or arrived late, instead of only that it is missing.
  const seenCols: unknown[] = []
  const cfgCols1 = JSON.parse(
    String(
      (await until(
        '(async()=>{const c=await window.api.getConfig();'
          + 'return JSON.stringify(c.cols||null)})()',
        (v) => {
          seenCols.push(v)
          return v === JSON.stringify(k1)
        },
        10000
      )) ?? 'null'
    )
  ) as string[] | null
  log('cols after', cfgCols1, 'seen', seenCols)
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
    /**
     * A loaded page is not a started page.
     *
     * The sort the table shows is read over IPC, on the same channel the
     * renderer is asking for five thousand papers at that very moment, and a
     * header read before that answer lands is a header showing the default —
     * which is a year arrow where a title one was meant, and which then reads
     * exactly like a sort that did not survive the restart.  So the page is
     * asked what it has, and waited for.  Both sides of the wait are logged,
     * because they fail in different places: a value that never reaches the
     * page is the channel, a value that is not on disk any more is a write
     * that was overwritten, and only the second is a thing the app does.
     */
    const SORT_IN_PAGE =
      '(async()=>{const c=await window.api.getConfig();'
      + 'return JSON.stringify(c.sort||null)})()'
    const seen: unknown[] = []
    const inPage = await until(
      SORT_IN_PAGE,
      (v) => {
        seen.push(v)
        try {
          const g = JSON.parse(String(v ?? 'null')) as { key?: string; dir?: number } | null
          if (!s) return g === null
          return g?.key === s.key && g?.dir === s.dir
        } catch {
          return false
        }
      },
      10000
    )
    log('sort on the new page', { want: s, onDisk: loadConfig().sort ?? null, inPage, seen })
  }
  const pressHead = (col: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const c=[...document.querySelectorAll(".col-head > div")]`
      + `.find(d=>d.dataset.col===${JSON.stringify(col)});if(!c)return 0;`
      + `c.dispatchEvent(new MouseEvent("click",{bubbles:true}));return 1})()`
    )
  /**
   * The sort a press wrote, waited for rather than timed.
   *
   * The press writes from the renderer and the invoke is not awaited, so it
   * queues behind whatever the renderer is doing — re-laying out five
   * thousand rows is enough to put it a second out, which is why the column
   * order above needs the same wait and why a fixed pause here read a press
   * that had been written as one that had been lost.  Every value seen is
   * logged, so a red says whether the write never arrived or arrived late.
   */
  const seenSorts: unknown[] = []
  const sortUntil = async (want: { key: string; dir: number }) =>
    JSON.parse(
      String(
        (await until(
          '(async()=>{const c=await window.api.getConfig();'
            + 'return JSON.stringify(c.sort||null)})()',
          (v) => {
            seenSorts.push(v)
            try {
              const s = JSON.parse(String(v ?? 'null')) as { key?: string; dir?: number }
              return !!s && s.key === want.key && s.dir === want.dir
            } catch {
              return false
            }
          },
          10000
        )) ?? 'null'
      )
    ) as { key: string; dir: 1 | -1 } | null
  // what the reader had before the run started touching things: the press
  // further down writes, and the run has to put it back
  const ARROW_JS =
    '(()=>{const cs=[...document.querySelectorAll(".col-head > div")]'
    + '.filter(d=>d.dataset.col);'
    + 'const a=cs.find(d=>/[▲▼]/.test(d.textContent||""));'
    + 'return JSON.stringify(a?{col:a.dataset.col,'
    + 'dir:/▲/.test(a.textContent||"")?1:-1}:null)})()'
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
  const sort1 = await sortUntil({ key: 'title', dir: want1 })
  log('sort after one press', { had: sort0, want1, sort1, seen: seenSorts })
  expect(
    'a press on a header is remembered',
    sort1?.key === 'title' && sort1?.dir === want1,
    { sort1, want1 }
  )
  await pressHead('title')
  const sort2 = await sortUntil({ key: 'title', dir: -want1 })
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
  // The arrow is read off a page that has only just been reloaded, and a
  // reload does not mean the page it replaced is finished talking: a write
  // that page had queued can land after the new one has read the file, and
  // the arrow then says what the last writer said rather than what was put
  // there.  So it is waited for rather than read once, and every value seen
  // is kept — a red then says whether the sort never came back or came back
  // and was written over, which are two different faults and only one of
  // them is in the thing being checked.
  const seenArrows: unknown[] = []
  const backState = await (async () => {
    const got = await until(
      ARROW_JS,
      (v) => {
        seenArrows.push(v)
        try {
          const s = JSON.parse(String(v ?? 'null')) as { col?: string; dir?: number }
          return !!s && s.col === wantArrow && s.dir === wantDir
        } catch {
          return false
        }
      },
      8000
    )
    try {
      return JSON.parse(String(got ?? 'null')) as { col: string; dir: number } | null
    } catch {
      return null
    }
  })()
  log('sort restored', { wanted: { wantArrow, wantDir }, got: backState, seen: seenArrows })
  expect(
    'the run leaves the sort as it found it',
    backState?.col === wantArrow && backState?.dir === wantDir,
    { wantArrow, wantDir, backState, seen: seenArrows }
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

  // A note is the only data in the app with no other copy: Mendeley has no
  // /notes endpoint, so it lives in one local file that no bibliography
  // exporter looks at.  Losing the cache costs a resync and losing a PDF costs
  // a download; losing this costs the reading.
  //
  // It cannot be driven through the menu here — that would mean writing a note
  // into the reader's library, which a smoke run has no business doing — so
  // the function is handed a note of its own.  What has to hold is that the
  // text survives the trip out, that the paper is identifiable once it is
  // somewhere else, and that a paper with no note is left out entirely.
  const notesMd = toNotesMarkdown(
    [
      { id: 'n1', title: 'A Paper With A Note', year: 2024, citation_key: 'note2024a' },
      { id: 'n2', title: 'A Paper Without One', year: 2023 }
    ] as Doc[],
    { n1: 'the reading note\nsecond line' }
  )
  log('notes export', notesMd)
  expect(
    'a note can leave in a form anything can open',
    /second line/.test(notesMd) &&
      /A Paper With A Note/.test(notesMd) &&
      /note2024a/.test(notesMd),
    notesMd.slice(0, 140)
  )
  expect(
    'and a paper with nothing written on it is left out',
    !/A Paper Without One/.test(notesMd),
    notesMd.slice(0, 140)
  )

  // The other half of the same hole.  Mendeley keeps a highlight's rectangles
  // but not the words underneath them, and the words are the part worth
  // keeping; the three bibliography exporters take `Doc[]` and never see an
  // annotation at all.  Again the function is handed data of its own rather
  // than writing into the reader's library.
  const annsMd = toAnnotationsMarkdown(
    [
      { id: 'a1', title: 'A Paper With Marks', year: 2024, citation_key: 'marks2024' },
      { id: 'a2', title: 'A Paper Without Marks', year: 2023 }
    ] as Doc[],
    [
      {
        id: 'x1',
        docId: 'a1',
        page: 7,
        type: 'highlight',
        color: '#ffe066',
        rects: [],
        text: 'the sentence that mattered',
        pos: [{ page: 7, x: 1, y: 2, w: 3, h: 4 }],
        created: '2026-01-02T00:00:00.000Z'
      },
      {
        id: 'x2',
        docId: 'a1',
        page: 3,
        type: 'highlight',
        color: '#ffe066',
        rects: [],
        text: 'an earlier one',
        note: 'my comment',
        created: '2026-01-01T00:00:00.000Z'
      },
      {
        // the cloud knows one text field, so a note it sends back arrives as
        // the quoted words under a second name
        id: 'x3',
        docId: 'a1',
        page: 4,
        type: 'note',
        color: '#ffe066',
        rects: [],
        text: 'sticky words',
        note: 'sticky words',
        created: '2026-01-03T00:00:00.000Z'
      },
      {
        id: 'x4',
        docId: 'gone',
        page: 2,
        type: 'highlight',
        color: '#ffe066',
        rects: [],
        text: 'orphan words',
        created: '2026-01-04T00:00:00.000Z'
      }
    ] as Annotation[]
  )
  log('annotations export', annsMd)
  expect(
    'a highlight leaves with the words it covers',
    /the sentence that mattered/.test(annsMd) && /p7/.test(annsMd),
    annsMd.slice(0, 160)
  )
  expect(
    'and they come out in reading order, not in the order they were made',
    annsMd.indexOf('an earlier one') < annsMd.indexOf('the sentence that mattered') &&
      annsMd.indexOf('an earlier one') < annsMd.indexOf('sticky words'),
    annsMd.slice(0, 400)
  )
  expect(
    'a note the cloud sent back as the text is not printed twice',
    annsMd.split('sticky words').length - 1 === 1,
    annsMd.slice(0, 400)
  )
  expect(
    'a paper with nothing marked on it is left out',
    !/A Paper Without Marks/.test(annsMd),
    annsMd.slice(0, 160)
  )
  expect(
    'and a mark whose paper has gone from the library still gets out',
    /orphan words/.test(annsMd) && /已不在库中/.test(annsMd),
    annsMd.slice(0, 400)
  )

  // Losing the cloud is the one thing this program was built to survive, and
  // the message shown when it happens used to be the same sentence for every
  // cause, advising a token import even for a dead network — and never saying
  // that the library on screen is still there.  A reader who has just lost
  // Mendeley is not asking "what broke", they are asking "did I lose my
  // papers", and the answer has to be in the message.
  const netFail = describeSyncFailure('fetch failed', 5648)
  const authFail = describeSyncFailure('token refresh failed: 401 unauthorized', 5648)
  const otherFail = describeSyncFailure('GET /documents -> 500 oops', 5648)
  log('sync failures', { netFail, authFail, otherFail })
  expect(
    'a dead network is not reported as a bad token',
    netFail.kind === 'network' && !/token/.test(netFail.text),
    netFail
  )
  expect(
    'and it says the library is still here, in numbers',
    /本地这 5648 篇照常能用/.test(netFail.text) && /不经过网络/.test(netFail.text),
    netFail.text
  )
  expect(
    'an expired credential says what to do about it',
    authFail.kind === 'auth' && /重新授权/.test(authFail.text),
    authFail
  )
  expect(
    'every one of them says the papers are still here',
    [netFail, authFail, otherFail].every((f) => /照常能用/.test(f.text)),
    otherFail.text
  )

  // A message used to be shown with `setMsg(text); setTimeout(clear, ms)`
  // repeated at a dozen call sites. Each timeout cleared whatever was on
  // screen when it fired, not the message that asked for it — so copying a
  // citation and then exporting wiped the export result after 2.4 seconds.
  // The clock here is advanced by hand: this is a race, and waiting 2.4 real
  // seconds would make the check depend on how busy the machine is, which is
  // precisely the kind of assertion that goes red for no reason (11.11).
  {
    type Job = { at: number; fn: () => void; live: boolean }
    const jobs: Job[] = []
    let clockNow = 0
    const clock: FlashClock = {
      set: (fn, ms) => {
        const job: Job = { at: clockNow + ms, fn, live: true }
        jobs.push(job)
        return job
      },
      clear: (h) => {
        ;(h as Job).live = false
      }
    }
    const advanceTo = (t: number) => {
      clockNow = t
      for (const j of jobs) {
        if (j.live && j.at <= clockNow) {
          j.live = false
          j.fn()
        }
      }
    }
    // Control: the same two messages through the fire-and-forget version
    // that was in the app before. It never cancels a pending clear, so the
    // later message has to be wiped at 2400ms. If it were not, the checks
    // below would be asserting nothing — an assertion that cannot fail looks
    // exactly like one that passes (142 / 145 / 146).
    {
      const oldJobs: Job[] = []
      let oldNow = 0
      const oldClock: FlashClock = {
        set: (fn, ms) => {
          const j: Job = { at: oldNow + ms, fn, live: true }
          oldJobs.push(j)
          return j
        },
        clear: (h) => {
          ;(h as Job).live = false
        }
      }
      let oldShown: string | null = null
      const naiveFlash = (text: string, ms: number) => {
        oldShown = text
        oldClock.set(() => {
          oldShown = null
        }, ms)
      }
      naiveFlash('已复制引文', 2400)
      oldNow = 1000
      naiveFlash('已导出 12 条', 6000)
      oldNow = 2500
      for (const j of oldJobs) {
        if (j.live && j.at <= oldNow) {
          j.live = false
          j.fn()
        }
      }
      expect(
        'the old fire-and-forget version really does wipe the later message',
        oldShown === null,
        { oldShown, oldNow }
      )
    }

    let shown: string | null = null
    const msg = createFlashMessage((t) => {
      shown = t
    }, clock)

    msg.flash('已复制引文', 2400)
    clockNow = 1000
    msg.flash('已导出 12 条', 6000)
    advanceTo(2500)
    expect(
      'a later message is not wiped by an earlier timeout',
      shown === '已导出 12 条',
      { shown, clockNow, live: jobs.filter((j) => j.live).length }
    )
    advanceTo(7100)
    expect(
      'and the later message still clears on its own',
      shown === null,
      { shown, clockNow }
    )

    msg.flash('已修改 5 条', 2200)
    msg.show('正在移入回收站 3/10…')
    advanceTo(9500)
    expect(
      'a progress line survives a stale timeout',
      shown === '正在移入回收站 3/10…',
      { shown, clockNow }
    )

    msg.flash('即将卸载', 1000)
    msg.dispose()
    advanceTo(20000)
    expect(
      'unmount cancels the pending clear without rendering',
      !msg.hasPending() && shown === '即将卸载',
      { shown, clockNow, pending: msg.hasPending() }
    )
  }

  // The full-text box used to debounce a lookup with
  // `setTimeout(() => ftSearch(q).then(setHits), 250)` and clean up with
  // `clearTimeout(t)`. That cancels the timer, not the request it already
  // started: empty the box while a lookup is in flight and the old hits land
  // in state a moment later, then sit on screen under whatever word is typed
  // next. The view never asked which word produced its rows either. A clock
  // advanced by hand and promises resolved by hand make both halves of this
  // checkable without sleeping or real IPC.
  {
    type Job = { at: number; fn: () => void; live: boolean }
    const makeClock = () => {
      const jobs: Job[] = []
      let now = 0
      const clock: SearchClock = {
        set: (fn, ms) => {
          const job: Job = { at: now + ms, fn, live: true }
          jobs.push(job)
          return job
        },
        clear: (h) => {
          ;(h as Job).live = false
        }
      }
      const advanceTo = (t: number) => {
        now = t
        for (const j of jobs) {
          if (j.live && j.at <= now) {
            j.live = false
            j.fn()
          }
        }
      }
      return { clock, advanceTo, live: () => jobs.filter((j) => j.live).length }
    }
    type Sent = {
      q: string
      resolve: (hits: string[]) => void
      reject: (why: unknown) => void
    }
    const makeRun = () => {
      const sent: Sent[] = []
      const run = (q: string) =>
        new Promise<string[]>((resolve, reject) => sent.push({ q, resolve, reject }))
      return { run, sent }
    }
    // Resolving a promise only queues a microtask. setImmediate lets it run
    // without sleeping, so none of these checks can go red because the
    // machine happened to be busy (11.11).
    const flush = () => new Promise<void>((r) => setImmediate(() => r()))

    // Control, one: the pre-152 effect with the same clock and the same
    // order of events. It really does leave stale hits behind; if it did
    // not, everything below would be asserting nothing (142 / 145 / 146 / 151).
    {
      const { clock, advanceTo } = makeClock()
      const { run, sent } = makeRun()
      let oldHits: string[] = []
      const pending = clock.set(() => {
        run('protein').then((h) => {
          oldHits = h
        })
      }, 250)
      advanceTo(250)
      // The box is emptied. The old cleanup clears only the timer, and the
      // short-query branch clears the rows — but the lookup is already out.
      clock.clear(pending)
      oldHits = []
      sent[0].resolve(['protein p1'])
      await flush()
      expect(
        'the old debounce really does put stale hits back after the box is cleared',
        oldHits.length === 1 && oldHits[0] === 'protein p1',
        { oldHits, sent: sent.map((s) => s.q) }
      )
    }

    // Control, two: once two lookups are out, no cleanup can stop either.
    // An index build that finishes mid-lookup is the case that made this
    // one matter — the older "not found" lands last and wins.
    {
      const { clock, advanceTo } = makeClock()
      const { run, sent } = makeRun()
      let oldHits: string[] = []
      const naive = (q: string) =>
        clock.set(() => {
          run(q).then((h) => {
            oldHits = h
          })
        }, 0)
      naive('before build')
      naive('after build')
      advanceTo(0)
      sent[1].resolve(['after build p2'])
      await flush()
      sent[0].resolve(['before build p1'])
      await flush()
      expect(
        'and without a generation guard an older answer arriving last wins',
        oldHits[0] === 'before build p1',
        { oldHits, sent: sent.map((s) => s.q) }
      )
    }

    const { clock, advanceTo, live } = makeClock()
    const { run, sent } = makeRun()
    // Held on an object rather than a bare `let`: the render callback is the
    // only writer, and TypeScript narrows a captured `let` to its initial
    // `null`, which would make every read below look like a type error.
    const box: { answer: SearchAnswer<string, string[]> | null } = { answer: null }
    const renders: (SearchAnswer<string, string[]> | null)[] = []
    const search = createLatestSearch<string, string[]>(
      run,
      (a) => {
        box.answer = a
        renders.push(a)
      },
      [],
      clock
    )

    search.ask('pro', 250)
    search.ask('protein', 250)
    advanceTo(250)
    expect(
      'typing again before the debounce fires sends only the last word',
      sent.length === 1 && sent[0].q === 'protein' && !search.hasPendingTimer(),
      { sent: sent.map((s) => s.q), live: live() }
    )

    sent[0].resolve(['protein p1'])
    await flush()
    expect(
      'the new scheduler still delivers a normal answer',
      (answerFor(box.answer, 'protein') ?? [])[0] === 'protein p1',
      { answer: box.answer }
    )

    // The exact shape of control one, through the new scheduler. Cancelling
    // does not render and does not touch the old answer: the tag is what
    // keeps that answer off the screen, so there is no state write to make
    // and no extra render to perturb the table (152).
    search.ask('kinase', 250)
    advanceTo(500)
    search.cancel()
    const beforeCancel = renders.length
    sent[1].resolve(['kinase p2'])
    await flush()
    expect(
      'a lookup already in flight cannot answer after the box is cleared',
      renders.length === beforeCancel &&
        answerFor(box.answer, 'kinase') === null &&
        answerFor(box.answer, '') === null,
      { answer: box.answer, renders: renders.length, beforeCancel }
    )

    // The exact shape of control two, through the new scheduler.
    search.ask('alpha', 250)
    advanceTo(750)
    search.ask('beta', 250)
    advanceTo(1000)
    sent[3].resolve(['beta p2'])
    await flush()
    sent[2].resolve(['alpha p1'])
    await flush()
    expect(
      'an older answer arriving last cannot overwrite the newer one',
      (answerFor(box.answer, 'beta') ?? [])[0] === 'beta p2' &&
        box.answer?.question === 'beta',
      { answer: box.answer, sent: sent.map((s) => s.q) }
    )

    // An empty result is still an answer. If it were not, a search that
    // genuinely found nothing would sit at 正在查找 forever.
    expect(
      'an answer only belongs to the word that produced it',
      answerFor({ question: 'alpha', result: ['alpha p1'] }, 'beta') === null &&
        answerFor({ question: 'beta', result: [] }, 'beta') !== null,
      { answer: box.answer }
    )

    search.ask('gamma', 250)
    advanceTo(1250)
    sent[4].reject(new Error('ft:search went away'))
    await flush()
    expect(
      'a failed lookup answers with no hits instead of searching forever',
      answerFor(box.answer, 'gamma') !== null &&
        (answerFor(box.answer, 'gamma') ?? []).length === 0,
      { answer: box.answer }
    )

    search.ask('delta', 250)
    const beforeUnmount = renders.length
    search.cancel()
    advanceTo(2000)
    expect(
      'a cancel on unmount drops the pending lookup without rendering',
      !search.hasPendingTimer() && sent.length === 5 && renders.length === beforeUnmount,
      { sent: sent.map((s) => s.q), renders: renders.length, beforeUnmount, live: live() }
    )
  }

  // The reader is not keyed by document: clicking another paper re-renders
  // PdfViewer in place. usePdfAnnotations used to hold one bare array, so the
  // previous paper's marks stayed on the new PDF until the new file came back,
  // and a slow read for the old paper could land last and win. The PDF itself,
  // the outline, the links and the references each had a `dead` flag in that
  // same component; the annotation read was the one keyed load without one.
  {
    type Pending = {
      docId: string
      resolve: (marks: string[]) => void
      reject: (why: unknown) => void
    }
    const makeLoad = () => {
      const sent: Pending[] = []
      const load = (docId: string) =>
        new Promise<string[]>((resolve, reject) => sent.push({ docId, resolve, reject }))
      return { load, sent }
    }
    const flush = () => new Promise<void>((r) => setImmediate(() => r()))

    // Control: the pre-153 read with the same two papers and the same order of
    // answers. It has no tag and no generation, so the late answer for the
    // paper no longer on screen really does win. If it did not, every check
    // below would be asserting nothing (142 / 145 / 146 / 151 / 152).
    {
      const { load, sent } = makeLoad()
      let oldAnns: string[] = []
      const oldEffect = (docId: string) =>
        load(docId).then((all) => {
          oldAnns = all
        })
      oldEffect('paper-a')
      oldEffect('paper-b')
      sent[1].resolve(['b1'])
      await flush()
      sent[0].resolve(['a1', 'a2'])
      await flush()
      expect(
        'the old annotation read really does let the previous paper win',
        oldAnns.length === 2 && oldAnns[0] === 'a1',
        { oldAnns, sent: sent.map((s) => s.docId) }
      )
    }

    const { load, sent } = makeLoad()
    const box: { written: ForDocument<string[]> | null } = { written: null }
    const renders: ForDocument<string[]>[] = []
    const loader = createDocumentLoad<string[]>(
      load,
      (state) => {
        box.written = state
        renders.push(state)
      },
      []
    )

    // The exact order of the control, through the guarded read.
    loader.start('paper-a')
    loader.start('paper-b')
    sent[1].resolve(['b1'])
    await flush()
    sent[0].resolve(['a1', 'a2'])
    await flush()
    expect(
      'a late answer for the previous paper cannot overwrite the current one',
      renders.length === 1 &&
        box.written?.docId === 'paper-b' &&
        (valueForDocument(box.written, 'paper-b') ?? [])[0] === 'b1',
      { renders: renders.map((r) => r.docId), written: box.written }
    )

    // The zero-frame half: while this paper's read is still out, nothing that
    // belongs to another paper may be drawn on it.
    loader.start('paper-c')
    expect(
      "no other paper's marks are visible while this one is still loading",
      valueForDocument(box.written, 'paper-c') === undefined,
      { written: box.written }
    )

    const beforeCancel = renders.length
    loader.cancel()
    sent[2].resolve(['c1'])
    await flush()
    expect(
      'a read in flight when the paper changes cannot write',
      renders.length === beforeCancel && box.written?.docId === 'paper-b',
      { renders: renders.length, beforeCancel, written: box.written }
    )

    loader.start('paper-c')
    sent[3].reject(new Error('annotations.json is gone'))
    await flush()
    expect(
      "a failed annotation read answers with no marks, not the last paper's",
      box.written?.docId === 'paper-c' &&
        (valueForDocument(box.written, 'paper-c') ?? []).length === 0,
      { written: box.written }
    )

    // A highlight made by hand must not be replaced by file contents that
    // were already on their way when it was drawn.
    loader.start('paper-d')
    const beforeEdit = renders.length
    loader.cancel()
    box.written = { docId: 'paper-d', value: ['made-by-hand'] }
    sent[4].resolve(['from-disk'])
    await flush()
    expect(
      'a highlight made by hand beats a read already in flight',
      renders.length === beforeEdit &&
        (valueForDocument(box.written, 'paper-d') ?? [])[0] === 'made-by-hand',
      { renders: renders.length, beforeEdit, written: box.written }
    )

    // An empty list is still this paper's answer; a cleared selection is still
    // an answer; and neither may be borrowed from another paper.
    expect(
      'an empty mark list and a cleared selection are still answers',
      valueForDocument<string[]>({ docId: 'paper-b', value: [] }, 'paper-b') !== undefined &&
        valueForDocument<string | null>({ docId: 'paper-b', value: null }, 'paper-b') === null &&
        valueForDocument<string[]>(null, 'paper-b') === undefined,
      {}
    )
    expect(
      'the selected mark and the undo affordance are scoped to their paper',
      valueForDocument<string | null>({ docId: 'paper-a', value: 'a1' }, 'paper-b') ===
        undefined &&
        (valueForDocument<string | null>({ docId: 'paper-b', value: 'b1' }, 'paper-b') ?? '') ===
          'b1',
      {}
    )
  }

  // 154: closing the find bar cleared the state but did not bump the scan id,
  // so a walk still reading the pages kept publishing the old word's hits and,
  // on its last page, called setFindOpen(true) — the bar the reader had just
  // closed came back. The same missing tag showed the old word's count under a
  // newly typed word for the whole 250ms of debounce.
  {
    type Hit = { page: number }
    const flush = () => new Promise<void>((r) => setImmediate(() => r()))

    // Control: the pre-154 walk with one page still in flight. If this did not
    // really reopen the bar, every assertion below would be testing nothing
    // (142 / 145 / 146 / 151 / 152 / 153).
    {
      // Counters, not booleans: TypeScript narrows a `let` that is only
      // assigned inside a callback to its initial literal (see 152).
      const old: { hits: Hit[]; opens: number; busyStops: number } = {
        hits: [],
        opens: 0,
        busyStops: 0
      }
      let oldResolve!: (hits: Hit[]) => void
      const page = new Promise<Hit[]>((r) => {
        oldResolve = r
      })
      const oldWalk = (async () => {
        const got = await page
        old.hits = got
        old.opens += 1
        old.busyStops += 1
        return old.hits
      })()
      // closeFind cleared these, and left the walk alone
      old.hits = []
      old.opens = 0
      oldResolve([{ page: 3 }])
      await oldWalk
      expect(
        'the old find walk really does reopen a bar the reader closed',
        old.opens === 1 && old.hits.length === 1 && old.busyStops === 1,
        { opens: old.opens, hits: old.hits, busyStops: old.busyStops }
      )
    }

    const box: { answer: ScanAnswer<string, Hit> | null; renders: number } = {
      answer: null,
      renders: 0
    }
    const opened: string[] = []
    const scan = createFindScan<string, Hit>(
      (a) => {
        box.answer = a
        box.renders += 1
      },
      (q, hits) => {
        if (!hits.length) return
        opened.push(q + ':' + hits.length)
      }
    )

    const alpha = scan.start('alpha')
    expect(
      'starting a walk answers its own word with an empty, busy list',
      answerHits(box.answer, 'alpha') !== null &&
        (answerHits(box.answer, 'alpha') ?? []).length === 0 &&
        answerBusy(box.answer, 'alpha') === true &&
        answerHits(box.answer, '') === null,
      { answer: box.answer, renders: box.renders }
    )

    alpha.publish([{ page: 1 }])
    const beta = scan.start('beta')
    expect(
      'a newly typed word no longer shows the previous word hits',
      answerHits(box.answer, 'alpha') === null &&
        (answerHits(box.answer, 'beta') ?? []).length === 0 &&
        answerBusy(box.answer, 'beta') === true,
      { answer: box.answer }
    )

    alpha.publish([{ page: 9 }])
    alpha.finish([{ page: 9 }])
    await flush()
    expect(
      'an outdated walk cannot append hits under the word now in the box',
      (answerHits(box.answer, 'beta') ?? []).length === 0 && opened.length === 0,
      { answer: box.answer, opened }
    )

    beta.publish([{ page: 4 }, { page: 7 }])
    expect(
      'hits found so far are published while the rest of the pages are read',
      (answerHits(box.answer, 'beta') ?? []).length === 2 &&
        answerBusy(box.answer, 'beta') === true,
      { answer: box.answer }
    )

    beta.finish([{ page: 4 }, { page: 7 }])
    expect(
      'the last page opens the bar once, for the word that produced the hits',
      opened.length === 1 &&
        opened[0] === 'beta:2' &&
        answerBusy(box.answer, 'beta') === false,
      { opened, answer: box.answer }
    )

    const gamma = scan.start('gamma')
    gamma.finish([])
    expect(
      'a word with no hits is still an answer, not an endless spinner',
      answerHits(box.answer, 'gamma') !== null &&
        (answerHits(box.answer, 'gamma') ?? []).length === 0 &&
        answerBusy(box.answer, 'gamma') === false &&
        opened.length === 1,
      { answer: box.answer, opened }
    )

    const delta = scan.start('delta')
    expect(
      'a superseded walk cannot leave the old word busy forever',
      answerBusy(box.answer, 'gamma') === false &&
        answerBusy(box.answer, 'delta') === true,
      { answer: box.answer }
    )

    const beforeCancel = box.renders
    scan.cancel()
    delta.publish([{ page: 99 }])
    delta.finish([{ page: 99 }])
    expect(
      'closing the box cancels the walk without a state write or a reopen',
      box.renders === beforeCancel &&
        !delta.alive() &&
        opened.length === 1 &&
        (answerHits(box.answer, 'delta') ?? []).length === 0,
      { renders: box.renders, beforeCancel, opened, answer: box.answer }
    )
  }

  // 155: the reader keeps one component across papers. The background walk
  // over every page had a `dead` flag, but the lazy single-page `ensure` did
  // not: clearing links/marks on a paper change left its promise running, and
  // the old PDF's links landed in the new paper's state a moment later.
  {
    const flush = () => new Promise<void>((r) => setImmediate(() => r()))
    type Pending = {
      page: number
      resolve: (v: string[]) => void
      reject: (why: unknown) => void
    }
    const makeLoad = () => {
      const pending: Pending[] = []
      const load = (page: number) =>
        new Promise<string[]>((resolve, reject) => pending.push({ page, resolve, reject }))
      return { load, pending }
    }

    // Control: the pre-155 lazy read with the same order of answers. It has no
    // generation, so the old paper's page really does land after the state was
    // cleared for the new one (142 / 145 / 146 / 151 / 152 / 153 / 154).
    {
      const old: { links: Record<number, string[]>; writes: number } = {
        links: {},
        writes: 0
      }
      let resolve!: (v: string[]) => void
      const pageRead = new Promise<string[]>((r) => {
        resolve = r
      })
      const oldEnsure = (page: number) =>
        pageRead.then((got) => {
          old.links[page] = got
          old.writes += 1
        })
      const oldWalk = oldEnsure(3)
      // the paper changed: state was cleared, the read was left alone
      old.links = {}
      old.writes = 0
      resolve(['link-from-paper-a'])
      await oldWalk
      expect(
        'the old lazy page read really does put the previous paper in the new one',
        old.writes === 1 && (old.links[3] ?? []).length === 1,
        { writes: old.writes, links: old.links }
      )
    }

    const box: { writes: PageAnswer<string, string[]>[] } = { writes: [] }
    const scope = createLazyPages<string, string[]>((a) => box.writes.push(a), [])
    const { load, pending } = makeLoad()

    scope.read('paper-a', 2, load)
    expect(
      'a page is claimed once while its read is in flight',
      pending.length === 1 && scope.isBusy(2) === true && !scope.isBusy(3),
      { pending: pending.length, busy2: scope.isBusy(2) }
    )
    scope.read('paper-a', 2, load)
    expect(
      'asking for the same page twice does not read it twice',
      pending.length === 1,
      { pending: pending.length }
    )

    pending[0].resolve(['a-link'])
    await flush()
    expect(
      'a read for the current paper is delivered with its own document',
      box.writes.length === 1 &&
        box.writes[0].doc === 'paper-a' &&
        box.writes[0].page === 2 &&
        (box.writes[0].value ?? [])[0] === 'a-link' &&
        scope.isBusy(2) === false,
      { writes: box.writes }
    )

    scope.read('paper-a', 4, load)
    const beforeInvalidate = box.writes.length
    scope.invalidate()
    expect(
      'changing the paper writes no state and frees every page claim',
      box.writes.length === beforeInvalidate && !scope.isBusy(4) && !scope.isBusy(2),
      { writes: box.writes.length, beforeInvalidate, busy4: scope.isBusy(4) }
    )

    pending[1].resolve(['stale-link'])
    await flush()
    expect(
      'a page read in flight when the paper changes cannot write',
      box.writes.length === beforeInvalidate,
      { writes: box.writes.length, beforeInvalidate }
    )

    scope.read('paper-b', 4, load)
    pending[2].resolve(['b-link'])
    await flush()
    expect(
      'the new paper can read the page the old one left claimed',
      box.writes.length === beforeInvalidate + 1 &&
        box.writes[box.writes.length - 1].doc === 'paper-b' &&
        (box.writes[box.writes.length - 1].value ?? [])[0] === 'b-link',
      { writes: box.writes }
    )

    scope.read('paper-b', 5, load)
    pending[3].reject(new Error('page has no annotations'))
    await flush()
    expect(
      'a failed page read answers with no links, not the last paper links',
      box.writes.length === beforeInvalidate + 2 &&
        box.writes[box.writes.length - 1].doc === 'paper-b' &&
        (box.writes[box.writes.length - 1].value ?? ['not-empty']).length === 0,
      { writes: box.writes }
    )
  }

  // 156: the last hand-rolled timer in the reader. A hover card is the same
  // one-pending-clear shape as a status line, only with an object instead of a
  // string. Before the refactor, dismissing a card (scroll, page change, the
  // open button) called setCite(null) and left the 260ms hide timer running,
  // so it wrote null a second time. Checked with a clock advanced by hand.
  {
    type Card = { rows: string[] }
    const makeClock = () => {
      let now = 0
      const jobs: { at: number; live: boolean; fn: () => void }[] = []
      const clock: FlashClock = {
        set(fn, ms) {
          const j = { at: now + ms, live: true, fn }
          jobs.push(j)
          return j
        },
        clear(h) {
          const j = h as (typeof jobs)[number] | undefined
          if (j) j.live = false
        }
      }
      const advanceTo = (t: number) => {
        now = t
        for (const j of jobs) {
          if (j.live && j.at <= now) {
            j.live = false
            j.fn()
          }
        }
      }
      return { clock, jobs, advanceTo }
    }

    // Control: the old card had its own timer. Dismissing it did not clear
    // that timer, so it really does call setCite(null) once more afterwards.
    {
      const { clock, advanceTo } = makeClock()
      const writes: (Card | null)[] = []
      const oldSetCite = (v: Card | null) => writes.push(v)
      oldSetCite({ rows: ['[1]'] })
      clock.set(() => oldSetCite(null), 260)
      oldSetCite(null)
      const before = writes.length
      advanceTo(300)
      expect(
        'the old hide timer really does write after the card is already gone',
        writes.length === before + 1 && writes[writes.length - 1] === null,
        { before, after: writes.length }
      )
    }

    const { clock, jobs, advanceTo } = makeClock()
    const box: { card: Card | null; writes: number } = { card: null, writes: 0 }
    const card = createFlashMessage<Card>(
      (v) => {
        box.card = v
        box.writes += 1
      },
      clock
    )

    card.show({ rows: ['[1] He et al. (2022)'] })
    expect(
      'one controller now carries a card, not only a status string',
      box.card !== null &&
        box.card.rows[0] === '[1] He et al. (2022)' &&
        !card.hasPending(),
      { card: box.card, pending: card.hasPending() }
    )

    card.hold(260)
    const beforeHold = box.writes
    card.hold(260)
    expect(
      'hold keeps the card and never leaves two pending clears',
      box.writes === beforeHold &&
        box.card !== null &&
        card.hasPending() &&
        jobs.filter((j) => j.live).length === 1,
      { writes: box.writes, beforeHold, live: jobs.filter((j) => j.live).length }
    )

    card.keep()
    advanceTo(1000)
    expect(
      'the pointer coming back cancels the pending exit',
      box.writes === beforeHold && box.card !== null && !card.hasPending(),
      { writes: box.writes, beforeHold, card: box.card }
    )

    card.hold(260)
    advanceTo(1400)
    expect(
      'the card still exits on its own when the pointer stays away',
      box.card === null && box.writes === beforeHold + 1,
      { card: box.card, writes: box.writes, beforeHold }
    )

    card.show({ rows: ['[2]'] })
    card.hold(260)
    card.clear()
    const beforeClear = box.writes
    advanceTo(2000)
    expect(
      'dismissing the card cancels its pending clear, no second write',
      box.card === null &&
        box.writes === beforeClear &&
        !card.hasPending() &&
        jobs.filter((j) => j.live).length === 0,
      { writes: box.writes, beforeClear, live: jobs.filter((j) => j.live).length }
    )

    card.show({ rows: ['[3]'] })
    card.hold(260)
    card.dispose()
    const beforeUnmount = box.writes
    advanceTo(3000)
    expect(
      'unmount cancels the pending exit without rendering',
      box.writes === beforeUnmount && box.card !== null && !card.hasPending(),
      { writes: box.writes, beforeUnmount, card: box.card }
    )

    card.flash({ rows: ['[4]'] }, 100)
    advanceTo(3200)
    expect(
      'flash still works with an object payload',
      box.card === null && !card.hasPending(),
      { card: box.card, pending: card.hasPending() }
    )
  }

  // A citation card hung off a marker in a PDF, measured exactly once. When
  // the reader narrowed the window the card kept its old `left`, so it sat
  // outside the new viewport with its Open button out of reach. The rule is
  // pure now and the controller re-reads both boxes on resize, so hand it
  // two viewports instead of moving a real window. One assertion is a
  // control: if the old one-shot placement could not be shown to fail,
  // the rest would be seven assertions that can never fail.
  {
    const anchor: Box = { top: 100, bottom: 120, left: 900, width: 20, height: 20 }
    const card: Box = { top: 0, bottom: 0, left: 0, width: 300, height: 140 }
    const wide: Viewport = { width: 1400, height: 900 }
    const narrow: Viewport = { width: 800, height: 900 }

    const oldSpot: Spot = spotFor(anchor, card, wide)
    expect(
      'the old one-shot placement really does leave the card outside a narrower window',
      oldSpot.left + card.width > narrow.width - GAP,
      { oldSpot, narrowWidth: narrow.width }
    )

    const box: { spot: Spot | null; writes: number; closed: number } = {
      spot: null, writes: 0, closed: 0
    }
    const state: { anchor: Box | null; card: Box | null; view: Viewport } = {
      anchor, card, view: wide
    }
    const spotter = createCardSpotter(
      () => ({ anchor: state.anchor, card: state.card, view: state.view }),
      (v) => {
        box.spot = v
        box.writes += 1
      },
      () => {
        box.closed += 1
      }
    )

    spotter.measure()
    expect(
      'the first measurement puts the card under its marker',
      box.spot !== null && box.spot.left === oldSpot.left && box.spot.top === oldSpot.top,
      { spot: box.spot, oldSpot }
    )

    // A resize moves the marker as well as the viewport: the page reflows.
    state.view = narrow
    state.anchor = { ...anchor, left: 400, bottom: 130 }
    const beforeResize = box.writes
    spotter.resize()
    expect(
      'a resize re-places the card for the new window and the marker that moved',
      box.spot !== null &&
        box.spot.left + card.width <= narrow.width - GAP &&
        box.spot.left === state.anchor.left &&
        box.writes === beforeResize + 1,
      { spot: box.spot, writes: box.writes, beforeResize }
    )

    const lowAnchor: Box = { top: 700, bottom: 720, left: 100, width: 20, height: 20 }
    const shortView: Viewport = { width: 1400, height: 760 }
    const flipped = spotFor(lowAnchor, card, shortView)
    expect(
      'a short window puts the card above its marker instead of off the bottom',
      flipped.top + card.height <= shortView.height - GAP && flipped.top < lowAnchor.top,
      { flipped, shortHeight: shortView.height }
    )

    state.card = null
    const beforeHidden = box.writes
    spotter.measure()
    expect(
      'a card that has not been laid out is hidden rather than placed anywhere',
      box.spot === null && box.writes === beforeHidden + 1 && box.closed === 0,
      { spot: box.spot, writes: box.writes, closed: box.closed }
    )

    state.anchor = null
    const beforeGone = box.writes
    spotter.resize()
    expect(
      'a resize whose marker is gone closes the card instead of placing it from stale coordinates',
      box.closed === 1 && box.writes === beforeGone && box.spot === null,
      { closed: box.closed, writes: box.writes, beforeGone, spot: box.spot }
    )

    const early: { spot: Spot | null; closed: number } = { spot: null, closed: 0 }
    const earlySpotter = createCardSpotter(
      () => ({ anchor: null, card, view: wide }),
      (v) => {
        early.spot = v
      },
      () => {
        early.closed += 1
      }
    )
    earlySpotter.measure()
    expect(
      'a missing marker on the first measure is layout timing, not a reason to close',
      early.spot === null && early.closed === 0,
      early
    )

    spotter.dispose()
    const beforeDispose = { writes: box.writes, closed: box.closed }
    state.anchor = anchor
    state.card = card
    spotter.resize()
    expect(
      'a disposed placement never writes again after the card is gone',
      box.writes === beforeDispose.writes && box.closed === beforeDispose.closed,
      { beforeDispose, writes: box.writes, closed: box.closed }
    )
  }

  // The full-text page budget had one clamp in the renderer and another in
  // the index builder, each with its own literal default.  Pulling the rule
  // into shared/ is only safe if it answers exactly what both copies used to
  // answer -- over a wide table of values, not two happy cases.  No sleeping
  // here: every value is decided on the spot.
  {
    const oldRendererRule = (n: number, fallback: number) =>
      Math.max(1, Math.min(50, Math.floor(n) || fallback))
    const oldMainRule = (n: number) =>
      Math.max(1, Math.min(50, Math.floor(Number(n)) || 3))

    // Control.  Two copies that keep their own default really can disagree,
    // so the extraction removes a live divergence rather than just tidying
    // up two identical expressions.
    expect(
      'the two old copies of the page budget rule really can disagree',
      oldRendererRule(0, 5) === 5 &&
        oldMainRule(0) === 3 &&
        oldRendererRule(0, 5) !== oldMainRule(0),
      { renderer: oldRendererRule(0, 5), main: oldMainRule(0) }
    )

    // The equivalence claim.  This is the whole reason the change can be
    // called behaviour preserving: not one value may move.
    const cases: unknown[] = [
      null, undefined, NaN, Infinity, -Infinity, '', '0', '7', '50.9',
      0, 1, 2.9, 3, 50, 50.9, 51, 999, -1, -999
    ]
    for (let n = -60; n <= 110; n++) cases.push(n)
    const different = cases.filter(
      (n) =>
        clampFullTextPages(n) !== oldRendererRule(n as number, DEFAULT_FT_PAGES) ||
        clampFullTextPages(n) !== oldMainRule(n as number)
    )
    expect(
      'the shared page-budget rule answers exactly what both old copies did',
      different.length === 0,
      { checked: cases.length, different }
    )

    const unusable: unknown[] = [0, null, undefined, NaN, '', '0']
    expect(
      'a value that is not a usable page count falls back to the shared default',
      unusable.every((n) => clampFullTextPages(n) === DEFAULT_FT_PAGES) &&
        DEFAULT_FT_PAGES === 3,
      { unusable, answers: unusable.map((n) => clampFullTextPages(n)) }
    )

    const below: unknown[] = [-1, -999, -Infinity]
    expect(
      'a negative budget is held at the lower bound',
      below.every((n) => clampFullTextPages(n) === FULL_TEXT_MIN_PAGES),
      { below, answers: below.map((n) => clampFullTextPages(n)) }
    )

    const above: unknown[] = [51, 999, Infinity]
    expect(
      'a budget past the upper bound is held at the upper bound',
      above.every((n) => clampFullTextPages(n) === FULL_TEXT_MAX_PAGES),
      { above, answers: above.map((n) => clampFullTextPages(n)) }
    )

    expect(
      'the two bounds themselves survive unchanged',
      FULL_TEXT_MIN_PAGES === 1 &&
        FULL_TEXT_MAX_PAGES === 50 &&
        clampFullTextPages(FULL_TEXT_MIN_PAGES) === FULL_TEXT_MIN_PAGES &&
        clampFullTextPages(FULL_TEXT_MAX_PAGES) === FULL_TEXT_MAX_PAGES,
      { min: FULL_TEXT_MIN_PAGES, max: FULL_TEXT_MAX_PAGES }
    )

    expect(
      'a fractional budget is floored before it is clamped',
      clampFullTextPages(4.9) === 4 &&
        clampFullTextPages(2.1) === 2 &&
        clampFullTextPages(50.9) === FULL_TEXT_MAX_PAGES,
      {
        fourNine: clampFullTextPages(4.9),
        twoOne: clampFullTextPages(2.1),
        fiftyNine: clampFullTextPages(50.9)
      }
    )

    expect(
      'a numeric string out of a config file is accepted as a budget',
      clampFullTextPages('7') === 7 && clampFullTextPages('12') === 12,
      { seven: clampFullTextPages('7'), twelve: clampFullTextPages('12') }
    )

    let outside = 0
    let sample = 0
    for (let n = -1000; n <= 1000; n++) {
      const v = clampFullTextPages(n + 0.5)
      sample += 1
      if (
        v < FULL_TEXT_MIN_PAGES ||
        v > FULL_TEXT_MAX_PAGES ||
        !Number.isInteger(v)
      ) outside += 1
    }
    expect(
      'the shared default is itself valid and no input escapes the bounds',
      clampFullTextPages(DEFAULT_FT_PAGES) === DEFAULT_FT_PAGES &&
        DEFAULT_FT_PAGES >= FULL_TEXT_MIN_PAGES &&
        DEFAULT_FT_PAGES <= FULL_TEXT_MAX_PAGES &&
        outside === 0,
      { sample, outside, min: FULL_TEXT_MIN_PAGES, max: FULL_TEXT_MAX_PAGES }
    )
  }

  // 171: the Settings field used to clamp with literals of its own and to
  // write itself back only for an unusable value. Typing 999 therefore wrote
  // 50 into the config and rebuilt the index against 50 while the field kept
  // saying 999 -- one setting, two numbers. The commit is pure now: the
  // number written must not move for any input, and the number shown must
  // always be the number that took effect.
  {
    // The old commit, copied verbatim. It is a control, not dead code:
    // without it "same number as before" is not a testable claim.
    const legacyCommit = (raw: string) => {
      let shown = raw
      let applied = DEFAULT_FT_PAGES
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 1) {
        shown = String(DEFAULT_FT_PAGES)
        applied = DEFAULT_FT_PAGES
      } else {
        applied = Math.min(50, Math.floor(n))
      }
      return { shown, applied }
    }

    const inputs: string[] = [
      '', ' ', 'abc', 'NaN', 'Infinity', '-Infinity', 'null', '0', '-0',
      '0.9', '1', '1.9', '2', '3', '3.9', '49', '50', '50.9', '51', '100',
      '999', '1e3', '+7', '007', '-5', '-999', '0x10', '  8  ', '1.0001'
    ]
    for (let n = -60; n <= 160; n++) inputs.push(String(n))
    for (let n = 0; n <= 60; n++) inputs.push(String(n + 0.5))

    const moved: Array<{ raw: string; old: number; next: number }> = []
    for (const raw of inputs) {
      const old = legacyCommit(raw).applied
      const next = commitPageBudget(raw).applied
      if (!Object.is(old, next)) moved.push({ raw, old, next })
    }
    expect(
      'committing the page budget still writes exactly what the old form wrote',
      inputs.length >= 300 && moved.length === 0,
      { inputs: inputs.length, moved: moved.slice(0, 6) }
    )

    // The control for the fix itself: the old field really did lie, and only
    // the shown value changed. Green on both would mean 171 was a no-op.
    const oldOver = legacyCommit('999')
    const newOver = commitPageBudget('999')
    expect(
      'the old field kept a number that never took effect',
      oldOver.shown === '999' &&
        oldOver.applied === FULL_TEXT_MAX_PAGES &&
        newOver.shown === String(FULL_TEXT_MAX_PAGES) &&
        Object.is(newOver.applied, oldOver.applied),
      { old: oldOver, next: newOver }
    )

    const unusable = ['abc', '', '0', '-5', 'Infinity', 'NaN', ' ']
    expect(
      'an unusable field still falls back to the shared default',
      unusable.every((raw) => {
        const c = commitPageBudget(raw)
        return c.shown === String(DEFAULT_FT_PAGES) && c.applied === DEFAULT_FT_PAGES
      }),
      unusable.map((raw) => ({ raw, ...commitPageBudget(raw) }))
    )

    const drift = inputs.filter((raw) => {
      const c = commitPageBudget(raw)
      return (
        c.shown !== String(c.applied) ||
        !Number.isInteger(c.applied) ||
        c.applied < FULL_TEXT_MIN_PAGES ||
        c.applied > FULL_TEXT_MAX_PAGES
      )
    })
    expect(
      'the field always shows the value that takes effect',
      drift.length === 0,
      { inputs: inputs.length, drift: drift.slice(0, 6) }
    )

    expect(
      'the shared rule is idempotent, so App clamping again changes nothing',
      inputs.every((raw) => {
        const applied = commitPageBudget(raw).applied
        return Object.is(clampFullTextPages(applied), applied)
      }),
      inputs.length
    )

    // Values alone do not prove the wiring, and a "nothing left" assertion
    // looks exactly like a pass when its detector is broken.
    const pageRoot = path.join(__dirname, '../..')
    const settingsFile = path.join(pageRoot, 'src/components/Settings.tsx')
    const moduleFile = path.join(pageRoot, 'src/lib/pageBudgetCommit.ts')
    const settingsSrc = fs.existsSync(settingsFile)
      ? fs.readFileSync(settingsFile, 'utf8')
      : null
    const moduleSrc = fs.existsSync(moduleFile)
      ? fs.readFileSync(moduleFile, 'utf8')
      : null
    expect(
      'the settings sheet and the commit module can be read from this checkout',
      settingsSrc !== null && moduleSrc !== null,
      { settings: settingsSrc !== null, module: moduleSrc !== null }
    )

    // Count call sites, not bare names: the import path carries the name too.
    const callCount = (t: string, name: string) =>
      (t.match(new RegExp('\\b' + name + '\\s*\\(', 'g')) ?? []).length
    expect(
      'the settings sheet commits through the shared rule and the module uses it once',
      /from '[^']*pageBudgetCommit'/.test(settingsSrc ?? '') &&
        callCount(settingsSrc ?? '', 'commitPageBudget') === 1 &&
        /from '[^']*fullTextPages'/.test(moduleSrc ?? '') &&
        callCount(moduleSrc ?? '', 'clampFullTextPages') === 1,
      {
        wiring: callCount(settingsSrc ?? '', 'commitPageBudget'),
        rule: callCount(moduleSrc ?? '', 'clampFullTextPages')
      }
    )
    expect(
      'the commit module has no clamp of its own',
      !/Math\.min\(/.test(moduleSrc ?? '') &&
        !/Math\.floor\(/.test(moduleSrc ?? '') &&
        /FULL_TEXT_MIN_PAGES/.test(moduleSrc ?? ''),
      { module: moduleSrc !== null }
    )

    const oldFragments = [
      'Math.min(50, Math.floor(n))',
      'setPages(String(DEFAULT_FT_PAGES))',
      'onFtPages(DEFAULT_FT_PAGES)',
      'Number.isFinite(n) || n < 1'
    ]
    const detector = (t: string) =>
      oldFragments.flatMap((o) =>
        Array.from({ length: t.split(o).length - 1 }, () => o)
      )
    const legacyLines = [
      '    const n = Number(pages)',
      '    if (!Number.isFinite(n) || n < 1) {',
      '      setPages(String(DEFAULT_FT_PAGES))',
      '      onFtPages(DEFAULT_FT_PAGES)',
      '      return',
      '    }',
      '    onFtPages(Math.min(50, Math.floor(n)))'
    ].join('\n')
    expect(
      'the leftover detector really sees the old commit body',
      detector(legacyLines).length === 4,
      { caught: detector(legacyLines).length }
    )
    expect(
      'the settings sheet carries no second copy of the page budget rule',
      detector(settingsSrc ?? '').length === 0,
      { caught: detector(settingsSrc ?? '') }
    )
  }

  // 172: `pdffind.ts` and `pdfsel.ts` each wrote out the same four-line
  // "stitch fragments into one line box" merge. Only the answer to "are
  // these two on the same line" differed: find uses 0..1 page coordinates
  // with an adjacency test, selection uses CSS pixels and only compares y.
  // Sharing the merge is safe only if both old loops agree value by value,
  // and honest only if the two predicates are shown to really disagree.
  {
    type R = { x: number; y: number; w: number; h: number }

    // Both old loops, copied verbatim. Controls, not dead code.
    const legacyFind = (raw: R[]) => {
      const out: R[] = []
      for (const r of raw) {
        const line = out.find(
          (t) => Math.abs(t.y - r.y) < 0.006 && r.x <= t.x + t.w + 0.02
        )
        if (line) {
          const right = Math.max(line.x + line.w, r.x + r.w)
          line.x = Math.min(line.x, r.x)
          line.w = right - line.x
          line.h = Math.max(line.h, r.h)
        } else out.push({ ...r })
      }
      return out
    }
    const legacySel = (raw: R[]) => {
      const lines: R[] = []
      for (const r of raw) {
        const line = lines.find((l) => Math.abs(l.y - r.y) < 3)
        if (line) {
          const right = Math.max(line.x + line.w, r.x + r.w)
          line.x = Math.min(line.x, r.x)
          line.w = right - line.x
          line.h = Math.max(line.h, r.h)
        } else lines.push({ ...r })
      }
      return lines
    }
    const findLine = (t: R, r: R) =>
      Math.abs(t.y - r.y) < 0.006 && r.x <= t.x + t.w + 0.02
    const selLine = (l: R, r: R) => Math.abs(l.y - r.y) < 3
    const sameRects = (a: R[], b: R[]) =>
      a.length === b.length &&
      a.every(
        (r, i) =>
          Object.is(r.x, b[i].x) &&
          Object.is(r.y, b[i].y) &&
          Object.is(r.w, b[i].w) &&
          Object.is(r.h, b[i].h)
      )

    // Deterministic inputs in both coordinate spaces, plus hand-made cases
    // that force a merge, a gap, NaN and negative widths.
    const mk = (seed: number, scale: number): R[] => {
      let s = Math.imul(seed, 7919) + 13
      const next = () => {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0
        return s / 4294967296
      }
      const n = 1 + Math.floor(next() * 14)
      const raw: R[] = []
      for (let i = 0; i < n; i++) {
        raw.push({
          x: Math.round(next() * scale * 100) / 100,
          y: Math.round(next() * scale * 20) / 100,
          w: Math.round(next() * scale * 12) / 100,
          h: Math.round(next() * scale * 5) / 100
        })
      }
      return raw.sort((a, b) => a.y - b.y || a.x - b.x)
    }
    const cases: R[][] = [
      [],
      [{ x: 0, y: 0, w: 1, h: 1 }],
      [{ x: 0, y: 0, w: 10, h: 2 }, { x: 12, y: 0, w: 10, h: 3 }],
      [{ x: 0, y: 0, w: 10, h: 2 }, { x: 12, y: 1, w: 10, h: 3 }],
      [{ x: 0, y: 0, w: 10, h: 2 }, { x: 100, y: 0.001, w: 10, h: 3 }],
      [{ x: 0, y: 0, w: NaN, h: 2 }, { x: 1, y: 0, w: 1, h: 1 }],
      [{ x: -5, y: 0, w: -2, h: 2 }, { x: 0, y: 0, w: 3, h: 5 }],
      [
        { x: 0, y: 0, w: 10, h: 2 },
        { x: 1, y: 0, w: 2, h: 1 },
        { x: 20, y: 0, w: 4, h: 3 }
      ]
    ]
    for (const scale of [1, 400]) {
      for (let seed = 1; seed <= 240; seed++) cases.push(mk(seed, scale))
    }

    let checked = 0
    const drift: string[] = []
    for (const raw of cases) {
      const copy = () => raw.map((r) => ({ ...r }))
      const findOld = legacyFind(copy())
      const findNew = mergeRectsIntoLines(copy(), findLine)
      const selOld = legacySel(copy())
      const selNew = mergeRectsIntoLines(copy(), selLine)
      checked += 2
      if (!sameRects(findOld, findNew)) drift.push('find:' + drift.length)
      if (!sameRects(selOld, selNew)) drift.push('sel:' + drift.length)
    }
    expect(
      'the shared stitch answers both old loops for every sampled input',
      cases.length === 488 && checked >= 900 && drift.length === 0,
      { cases: cases.length, checked, drift: drift.slice(0, 6) }
    )

    // The control. If one predicate could serve both callers, injecting it
    // would be ceremony rather than a required separation (166).
    const split: R[] = [
      { x: 0, y: 0, w: 10, h: 2 },
      { x: 100, y: 1, w: 10, h: 3 }
    ]
    expect(
      'the two callers really mean different things by one line',
      legacyFind(split).length === 2 &&
        legacySel(split).length === 1 &&
        mergeRectsIntoLines(split, findLine).length === 2 &&
        mergeRectsIntoLines(split, selLine).length === 1,
      {
        findOld: legacyFind(split).length,
        selOld: legacySel(split).length,
        findNew: mergeRectsIntoLines(split, findLine).length,
        selNew: mergeRectsIntoLines(split, selLine).length
      }
    )

    const source: R[] = [
      { x: 5, y: 2, w: 10, h: 3 },
      { x: 7, y: 2, w: 4, h: 5 }
    ]
    const snapshot = source.map((r) => ({ ...r }))
    const merged = mergeRectsIntoLines(source, selLine)
    expect(
      'merging does not mutate the caller array and keeps the first y',
      sameRects(source, snapshot) &&
        merged.length === 1 &&
        merged[0].y === 2 &&
        merged[0].x === 5 &&
        merged[0].w === 10 &&
        merged[0].h === 5,
      { merged }
    )

    expect(
      'an empty or single fragment is handed back unchanged',
      mergeRectsIntoLines([], selLine).length === 0 &&
        sameRects(
          mergeRectsIntoLines([{ x: 1, y: 2, w: 3, h: 4 }], findLine),
          [{ x: 1, y: 2, w: 3, h: 4 }]
        ),
      {}
    )

    const odd: R[] = [
      { x: 0, y: 0, w: NaN, h: Infinity },
      { x: 1, y: 0, w: -Infinity, h: -1 }
    ]
    expect(
      'non-finite values are not silently cleaned up',
      sameRects(mergeRectsIntoLines(odd, selLine), legacySel(odd)) &&
        Number.isNaN(mergeRectsIntoLines(odd, selLine)[0].w),
      { merged: mergeRectsIntoLines(odd, selLine) }
    )

    // Values alone do not prove the wiring. Count call sites, not names:
    // the import path carries the module name too (169).
    const rectRoot = path.join(__dirname, '../..')
    const rectSites = [
      { file: 'src/lib/pdffind.ts', predicate: '0.006' },
      { file: 'src/lib/pdfsel.ts', predicate: '< 3' }
    ]
    const rectReads = rectSites.map((s) => {
      const f = path.join(rectRoot, s.file)
      return {
        ...s,
        text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
      }
    })
    expect(
      'both stitch call-site files can be read from this checkout',
      rectReads.every((r) => r.text !== null),
      { missing: rectReads.filter((r) => r.text === null).map((r) => r.file) }
    )
    const rectCalls = (t: string, name: string) =>
      (t.match(new RegExp('\\b' + name + '\\s*\\(', 'g')) ?? []).length
    expect(
      'both call sites use the shared stitch once and keep sorting to themselves',
      rectReads.every(
        (r) =>
          /from '[^']*rectLines'/.test(r.text ?? '') &&
          rectCalls(r.text ?? '', 'mergeRectsIntoLines') === 1 &&
          (r.text ?? '').split('raw.sort(').length - 1 === 1 &&
          (r.text ?? '').includes(r.predicate)
      ),
      rectReads.map((r) => ({
        file: r.file,
        calls: rectCalls(r.text ?? '', 'mergeRectsIntoLines'),
        sorts: (r.text ?? '').split('raw.sort(').length - 1,
        predicate: (r.text ?? '').includes(r.predicate)
      }))
    )
    expect(
      'neither call site inherited the other tolerance',
      !(rectReads[0].text ?? '').includes('Math.abs(l.y - r.y) < 3') &&
        !(rectReads[1].text ?? '').includes('0.006') &&
        !(rectReads[1].text ?? '').includes('t.x + t.w + 0.02'),
      {}
    )

    const oldMergeLines = [
      'const right = Math.max(line.x + line.w, r.x + r.w)',
      'line.x = Math.min(line.x, r.x)',
      'line.w = right - line.x',
      'line.h = Math.max(line.h, r.h)'
    ]
    const mergeDetector = (t: string) =>
      oldMergeLines.flatMap((o) =>
        Array.from({ length: t.split(o).length - 1 }, () => o)
      )
    const legacyMergeText = [...oldMergeLines, ...oldMergeLines].join('\n')
    expect(
      'the leftover detector really sees both old merge bodies',
      mergeDetector(legacyMergeText).length === 8,
      { caught: mergeDetector(legacyMergeText).length }
    )
    expect(
      'neither product file still carries the hand-written merge',
      rectReads.every((r) => mergeDetector(r.text ?? '').length === 0),
      rectReads.map((r) => ({
        file: r.file,
        caught: mergeDetector(r.text ?? '').length
      }))
    )

    const sharedFile = path.join(rectRoot, 'src/lib/rectLines.ts')
    const sharedSrc = fs.existsSync(sharedFile)
      ? fs.readFileSync(sharedFile, 'utf8')
      : null
    expect(
      'the shared rule does not sort and does not own either tolerance',
      sharedSrc !== null &&
        !sharedSrc.includes('.sort(') &&
        !sharedSrc.includes('0.006') &&
        !sharedSrc.includes('< 3'),
      { present: sharedSrc !== null }
    )
  }

  // A neighbouring-page bitmap is keyed by page, scale and pixel ratio only.
  // Clearing the two maps on a paper change left an in-flight render free to
  // land the *previous* paper's bitmap under a key the new paper would hit,
  // and a page turn that had already joined the flight drew it. Resolving
  // each render by hand checks the whole ordering without a PDF or a window;
  // the pre-fix cache is kept here so the control proves the bug was real (173).
  {
    type Bmp = { width: number; height: number; tag: string }
    const bmp = (tag: string): Bmp => ({ width: 800, height: 1100, tag })
    const deferred = () => {
      let resolve!: (b: Bmp) => void
      let reject!: (e: unknown) => void
      const promise = new Promise<Bmp>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }
    const outcome = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p
        return 'resolved'
      } catch (e) {
        return (e as Error)?.name ?? 'rejected'
      }
    }
    const KEY = '6:1.250:2'
    const staleName = new StaleFlight(KEY).name

    // The pre-fix cache, transcribed verbatim apart from the DOM stamp and
    // the LRU, neither of which participates in an in-flight write.
    class LegacyCache<T> {
      private done = new Map<string, T>()
      private busy = new Map<string, Promise<T>>()
      peek(k: string) { return this.done.get(k) }
      flight(k: string) { return this.busy.get(k) }
      warm(key: string, draw: () => Promise<T>): Promise<void> {
        if (this.done.has(key)) return Promise.resolve()
        const running = this.busy.get(key)
        if (running) return running.then(() => undefined).catch(() => undefined)
        const p = draw().then((c) => {
          this.busy.delete(key)
          this.done.set(key, c)
          return c
        })
        this.busy.set(key, p)
        p.catch(() => {
          this.busy.delete(key)
        })
        return p.then(() => undefined)
      }
      clear() {
        this.done.clear()
        this.busy.clear()
      }
    }

    const old = new LegacyCache<Bmp>()
    const oldDraw = deferred()
    const oldWarm = old.warm(KEY, () => oldDraw.promise)
    old.clear()
    oldDraw.resolve(bmp('paper-A'))
    await oldWarm
    expect(
      'the old cache really lands the previous paper bitmap after a paper change',
      old.peek(KEY)?.tag === 'paper-A',
      { tag: old.peek(KEY)?.tag ?? null }
    )

    const oldJoin = new LegacyCache<Bmp>()
    const joinDraw = deferred()
    const joinedWarm = oldJoin.warm(KEY, () => joinDraw.promise)
    const oldFlight = oldJoin.flight(KEY)
    oldJoin.clear()
    joinDraw.resolve(bmp('paper-A'))
    await joinedWarm
    const oldJoined = oldFlight ? await oldFlight : undefined
    expect(
      'the old cache also hands that bitmap to a page turn that joined the flight',
      oldJoined?.tag === 'paper-A',
      { tag: oldJoined?.tag ?? null }
    )

    const fresh = new PrefetchCache<Bmp>()
    const staleDraw = deferred()
    const staleWarm = fresh.warm(KEY, () => staleDraw.promise)
    const staleFlight = fresh.flight(KEY)
    fresh.clear()
    staleDraw.resolve(bmp('paper-A'))
    const warmOutcome = await outcome(staleWarm)
    const flightOutcome = await outcome(staleFlight ?? Promise.resolve())
    expect(
      'a render outlived by a paper change fails instead of landing a bitmap',
      warmOutcome === staleName &&
        flightOutcome === staleName &&
        fresh.peek(KEY) === undefined,
      { warmOutcome, flightOutcome, cached: fresh.peek(KEY)?.tag ?? null }
    )

    const normal = new PrefetchCache<Bmp>()
    const normalDraw = deferred()
    const normalWarm = normal.warm(KEY, () => normalDraw.promise)
    normalDraw.resolve(bmp('paper-B'))
    await normalWarm
    expect(
      'a render that finishes before the paper changes still warms the cache',
      normal.peek(KEY)?.tag === 'paper-B' && normal.flight(KEY) === undefined,
      { tag: normal.peek(KEY)?.tag ?? null, flight: normal.flight(KEY) !== undefined }
    )

    const guard = new PrefetchCache<Bmp>()
    const oldFail = deferred()
    const failWarm = guard.warm(KEY, () => oldFail.promise)
    guard.clear()
    const newDraw = deferred()
    const newWarm = guard.warm(KEY, () => newDraw.promise)
    const hadFlight = guard.flight(KEY) !== undefined
    oldFail.reject(new Error('render cancelled'))
    const failOutcome = await outcome(failWarm)
    const flightSurvived = guard.flight(KEY) !== undefined
    newDraw.resolve(bmp('paper-B'))
    await newWarm
    expect(
      'a stale failure does not delete the flight of the paper now on screen',
      hadFlight &&
        flightSurvived &&
        failOutcome === 'Error' &&
        guard.peek(KEY)?.tag === 'paper-B',
      {
        hadFlight,
        flightSurvived,
        failOutcome,
        tag: guard.peek(KEY)?.tag ?? null
      }
    )

    const order = new PrefetchCache<Bmp>()
    const lateOld = deferred()
    const lateWarm = order.warm(KEY, () => lateOld.promise)
    order.clear()
    const earlyNew = deferred()
    const earlyWarm = order.warm(KEY, () => earlyNew.promise)
    earlyNew.resolve(bmp('paper-B'))
    await earlyWarm
    lateOld.resolve(bmp('paper-A'))
    const lateOutcome = await outcome(lateWarm)
    expect(
      'the newer paper bitmap wins even when the old render finishes last',
      lateOutcome === staleName && order.peek(KEY)?.tag === 'paper-B',
      { lateOutcome, tag: order.peek(KEY)?.tag ?? null }
    )

    const stamps: string[] = []
    const lru = new PrefetchCache<Bmp>(2, (s) => stamps.push(s.keys.join(',')))
    for (const [k, tag] of [
      ['1', 'a'],
      ['2', 'b'],
      ['3', 'c']
    ] as const) {
      const d = deferred()
      const w = lru.warm(k, () => d.promise)
      d.resolve(bmp(tag))
      await w
    }
    lru.touch('2')
    const d4 = deferred()
    const w4 = lru.warm('4', () => d4.promise)
    d4.resolve(bmp('d'))
    await w4
    lru.drop('3')
    expect(
      'the LRU, touch and drop still answer as they did before the generation was added',
      lru.peek('1') === undefined &&
        lru.peek('2')?.tag === 'b' &&
        lru.peek('3') === undefined &&
        lru.peek('4')?.tag === 'd' &&
        stamps.at(-1) === '2,4',
      { lastStamp: stamps.at(-1) ?? null, stamps: stamps.length }
    )

    expect(
      'these ordering rules were checked in a process with no document at all',
      typeof (globalThis as unknown as Record<string, unknown>).document === 'undefined',
      {
        hasDocument: typeof (globalThis as unknown as Record<string, unknown>).document
      }
    )

    // Values alone do not prove the wiring. The detector is first handed the
    // old clear() verbatim, so a detector that cannot see a difference cannot
    // pass by reporting "all clear" (168).
    const cacheRoot = path.join(__dirname, '../..')
    const cacheSrc = fs.readFileSync(path.join(cacheRoot, 'src/lib/pdfcache.ts'), 'utf8')
    const viewerSrc = fs.readFileSync(
      path.join(cacheRoot, 'src/components/PdfViewer.tsx'),
      'utf8'
    )
    const legacyClear =
      'clear() {\n    this.done.clear()\n    this.busy.clear()\n  }'
    const guarded = (t: string) => t.includes('this.generation += 1')
    expect(
      'the guard detector really distinguishes the old clear from the new one',
      !guarded(legacyClear) &&
        legacyClear.includes('this.busy.clear()') &&
        guarded(cacheSrc),
      { oldGuarded: guarded(legacyClear), newGuarded: guarded(cacheSrc) }
    )
    const genChecks = (cacheSrc.match(/gen !== this\.generation/g) ?? []).length
    expect(
      'both the landing write and the failure cleanup check the generation',
      genChecks === 2 && /from '[^']*pdfcache'/.test(viewerSrc),
      { genChecks }
    )
    const constructors = (viewerSrc.match(/new PrefetchCache<HTMLCanvasElement>\(/g) ?? [])
      .length
    const stampCalls = (viewerSrc.match(/\.stamp\(\)/g) ?? []).length
    expect(
      'the window still receives its cache diagnostics from the injected callback',
      constructors === 1 &&
        viewerSrc.includes('d.pfKeys = s.keys.join') &&
        stampCalls === 2,
      { constructors, stampCalls }
    )
  }

  // A details panel is kept mounted across papers. A lookup started by a
  // click, a note saved by a blur and a patch applied by choosing a candidate
  // row all await something that can outlive the paper on screen; the old
  // lookup then rendered A's candidates over B and patched them with B's id.
  // Every answer has to carry the id of the paper that asked, and every write
  // has to re-ask whether that paper is still shown (174).
  {
    const scope = createDocumentScope('paper-a')
    expect(
      'the panel scope starts on the document it was mounted for',
      scope.current() === 'paper-a' && scope.isCurrent('paper-a') && !scope.isCurrent('paper-b'),
      { current: scope.current() }
    )

    const writes: string[] = []
    // The pre-fix shape: the closure holds the id of the paper that started
    // the read, and writes unconditionally when the answer comes back.
    const oldRead = (owner: string, answer: string) => writes.push(owner + ':' + answer)
    const guardedRead = (
      owner: string,
      answer: string,
      s: ReturnType<typeof createDocumentScope>
    ) => {
      if (!s.isCurrent(owner)) return
      writes.push(owner + ':' + answer)
    }

    oldRead('paper-a', 'lookup-A')
    expect(
      'the old lookup really writes its answer after the paper has changed',
      writes.length === 1 && writes[0] === 'paper-a:lookup-A' && scope.isCurrent('paper-a'),
      { writes: writes.slice() }
    )
    writes.length = 0
    const switched = createDocumentScope('paper-a')
    switched.switchTo('paper-b')
    guardedRead('paper-a', 'lookup-A', switched)
    expect(
      'a lookup that outlived its paper writes nothing at all',
      writes.length === 0,
      { writes: writes.slice(), current: switched.current() }
    )
    guardedRead('paper-b', 'lookup-B', switched)
    expect(
      'a lookup that finishes before the paper changes still writes',
      writes.length === 1 && writes[0] === 'paper-b:lookup-B',
      { writes: writes.slice() }
    )

    // The switch has to be synchronous. A ref updated only in an effect is
    // still the previous paper to every other effect in that same commit, so
    // a promise resolving in that window would walk through a stale guard.
    const inRender = createDocumentScope('paper-a')
    const inEffect = createDocumentScope('paper-a')
    inRender.switchTo('paper-b')
    expect(
      'an effect-only switch would still let the previous paper through',
      !inRender.isCurrent('paper-a') &&
        inEffect.isCurrent('paper-a') &&
        inRender.isCurrent('paper-b') &&
        !inEffect.isCurrent('paper-b'),
      { inRender: inRender.current(), inEffect: inEffect.current() }
    )

    const staleCands: ForDocument<string[]> = { docId: 'paper-a', value: ['candidate-A'] }
    expect(
      'a candidate list from the previous paper cannot be drawn on this one',
      valueForDocument(staleCands, 'paper-b') === undefined &&
        JSON.stringify(valueForDocument(staleCands, 'paper-a')) === '["candidate-A"]',
      { onB: valueForDocument(staleCands, 'paper-b') ?? null }
    )
    const emptyCands: ForDocument<string[]> = { docId: 'paper-b', value: [] }
    expect(
      'an empty answer is still an answer and is not mistaken for no answer',
      JSON.stringify(valueForDocument(emptyCands, 'paper-b')) === '[]',
      { onB: valueForDocument(emptyCands, 'paper-b') ?? null }
    )

    // Values alone do not prove the wiring. The detector is handed one line
    // of pre-fix code and one guarded line before it is trusted to count
    // call sites in the product file (168 / 169).
    const panelRoot = path.join(__dirname, '../..')
    const panelSrc = fs.readFileSync(
      path.join(panelRoot, 'src/components/DetailsPanel.tsx'),
      'utf8'
    )
    const guardCount = (t: string) => (t.match(/scope\.current\.isCurrent\(/g) ?? []).length
    const oldNoteLine =
      'if (n && typeof n[doc.id] === "string" && !noteDirty.current) setNote(n[doc.id])'
    const oneGuard = 'if (!scope.current.isCurrent(id)) return'
    expect(
      'the guard detector can really tell an unguarded read from a guarded one',
      guardCount(oldNoteLine) === 0 && guardCount(oneGuard) === 1,
      { old: guardCount(oldNoteLine), guarded: guardCount(oneGuard) }
    )
    expect(
      'every async exit in the panel re-asks which paper is on screen',
      guardCount(panelSrc) === 15 &&
        (panelSrc.match(/scope\.current\.switchTo\(/g) ?? []).length === 1 &&
        (panelSrc.match(/createDocumentScope\(/g) ?? []).length === 1,
      { guards: guardCount(panelSrc) }
    )
    expect(
      'the candidate list carries its paper and is patched with that paper id',
      (panelSrc.match(/valueForDocument\(/g) ?? []).length === 1 &&
        panelSrc.includes('setCands({ docId: id, value: list })') &&
        panelSrc.includes('patchDoc(ownerId, c.patch)') &&
        (panelSrc.match(/const id = doc\.id/g) ?? []).length === 4,
      {
        valueCalls: (panelSrc.match(/valueForDocument\(/g) ?? []).length,
        capturedIds: (panelSrc.match(/const id = doc\.id/g) ?? []).length
      }
    )
    expect(
      'switching papers resets the spinner, the save flag and the dirty note',
      (panelSrc.match(/setLooking\(false\)/g) ?? []).length === 2 &&
        (panelSrc.match(/setSaving\(false\)/g) ?? []).length === 3 &&
        (panelSrc.match(/noteDirty\.current = false/g) ?? []).length === 2,
      {
        looking: (panelSrc.match(/setLooking\(false\)/g) ?? []).length,
        saving: (panelSrc.match(/setSaving\(false\)/g) ?? []).length,
        dirty: (panelSrc.match(/noteDirty\.current = false/g) ?? []).length
      }
    )
  }

  // A \cite{...} pasted into a manuscript and the key of a BibTeX entry
  // exported from the same paper used to be built by two different rules:
  // cite.ts kept CJK letters, export.ts kept ASCII only. A Chinese surname
  // therefore produced 张三2023 in one place and anon2023a in the other.
  // Only the stem is shared now — the disambiguation letter belongs to a
  // whole-file export, and the way the surname is picked belongs to the
  // caller (175).
  {
    const doc = (id: string, last: string | undefined, year: Doc['year']): Doc => ({
      id,
      title: 'A paper',
      authors: last === undefined ? [] : [{ last_name: last }],
      year
    })
    const zh = doc('zh', '张三', 2023)
    const smith = doc('smith', 'Smith', 2023)

    // The two pre-fix rules, copied verbatim. Name parsing is not copied:
    // each caller hands the stem the string it chose, so this comparison is
    // about the stem rule and nothing else.
    const legacyCiteStem = (last: string, year: Doc['year']) =>
      ((last || 'anon').replace(/[^A-Za-z\u3400-\u9fff]/g, '') || 'anon').toLowerCase() +
      (year ?? '')
    const legacyExportKey = (last: string, year: Doc['year'], i: number) =>
      ((last || '').replace(/[^A-Za-z]/g, '') || 'anon').toLowerCase() +
      (year ?? '') + String.fromCharCode(97 + (i % 26))

    expect(
      'the two old rules really disagree about a Chinese surname',
      legacyCiteStem('张三', 2023) === '张三2023' &&
        legacyExportKey('张三', 2023, 0) === 'anon2023a' &&
        citationKeyStem('张三', 2023) === '张三2023',
      {
        copied: legacyCiteStem('张三', 2023),
        exported: legacyExportKey('张三', 2023, 0),
        shared: citationKeyStem('张三', 2023)
      }
    )

    const lasts = [
      '', 'anon', 'Smith', "O'Brien", 'Van der Berg', '张三', '王-小明',
      '李 四', 'Ångström', '123', 'a!b@c', '中文Mixed2023'
    ]
    const years: (number | null | undefined)[] = [undefined, null, 0, 1, 1999, 2023, -5, 3.5]
    let checked = 0
    let cjkChecked = 0
    let cjkChanged = 0
    const citeDrift: string[] = []
    const asciiDrift: string[] = []
    for (const last of lasts) {
      for (const year of years) {
        const stem = citationKeyStem(last, year)
        const oldCite = legacyCiteStem(last, year)
        const oldExport = legacyExportKey(last, year, 0).slice(0, -1)
        checked++
        if (!Object.is(stem, oldCite)) citeDrift.push(last + ':' + String(year))
        if (/[\u3400-\u9fff]/.test(last)) {
          cjkChecked++
          if (stem !== oldExport) cjkChanged++
        } else if (stem !== oldExport) {
          asciiDrift.push(last + ':' + String(year))
        }
      }
    }
    expect(
      'the shared stem answers the old citation rule for every sampled input',
      checked === lasts.length * years.length && citeDrift.length === 0,
      { checked, drift: citeDrift.slice(0, 6) }
    )
    expect(
      'ASCII surnames are exported exactly as before',
      asciiDrift.length === 0,
      { drift: asciiDrift.slice(0, 6) }
    )
    expect(
      'CJK surnames are the only ones whose exported key changed',
      cjkChecked > 0 && cjkChanged === cjkChecked,
      { cjkChecked, cjkChanged }
    )

    const keyPaste = formatCitation([zh], 'key')
    const bib = toBibtex([zh])
    const endnote = toEndnoteXml([zh])
    const bibKey = (bib.match(/^@\w+\{([^,]+),/m) ?? [])[1] ?? ''
    const refId = (endnote.match(/<ref-id>([^<]*)<\/ref-id>/) ?? [])[1] ?? ''
    expect(
      'a copied key and an exported BibTeX key now name the same paper',
      keyPaste === '\\cite{张三2023}' && bibKey === '张三2023a',
      { keyPaste, bibKey }
    )
    expect('EndNote ref-id follows the same stem', refId === '张三2023a', { refId })

    const twoKeys = toBibtex([smith, doc('smith2', 'Smith', 2023)])
    expect(
      'two papers with the same stem still get different export keys',
      twoKeys.includes('smith2023a') &&
        twoKeys.includes('smith2023b') &&
        formatCitation([smith], 'key') === '\\cite{smith2023}',
      { pasted: formatCitation([smith], 'key'), twoKeys: twoKeys.slice(0, 60) }
    )

    const keyRoot = path.join(__dirname, '../..')
    const citeSrc = fs.readFileSync(path.join(keyRoot, 'src/lib/cite.ts'), 'utf8')
    const exportSrc = fs.readFileSync(path.join(keyRoot, 'src/lib/export.ts'), 'utf8')
    const sharedSrc = fs.readFileSync(path.join(keyRoot, 'src/lib/citeKey.ts'), 'utf8')
    const stemCalls = (t: string) => (t.match(/citationKeyStem\(/g) ?? []).length
    const oldExportLine =
      "const last = (a?.last_name ?? '').replace(/[^A-Za-z]/g, '') || 'anon'"
    const asciiOnly = (t: string) => /\.replace\(\/\[\^A-Za-z\]\/g, ''\)/.test(t)
    expect(
      'the leftover detector really catches the old ASCII-only filter',
      asciiOnly(oldExportLine) && !asciiOnly(exportSrc) && !asciiOnly(citeSrc),
      { onOld: asciiOnly(oldExportLine), onExport: asciiOnly(exportSrc) }
    )
    expect(
      'both callers use the shared stem once and keep their own decisions',
      stemCalls(citeSrc) === 1 &&
        stemCalls(exportSrc) === 1 &&
        /from '[^']*citeKey'/.test(citeSrc) &&
        /from '[^']*citeKey'/.test(exportSrc) &&
        exportSrc.includes('String.fromCharCode(97 + (i % 26))') &&
        // count call sites, not the declaration: `function surnameKey(`
        // would otherwise be a third hit (169)
        (exportSrc.match(/\|\| surnameKey\(/g) ?? []).length === 2,
      {
        citeCalls: stemCalls(citeSrc),
        exportCalls: stemCalls(exportSrc),
        surnameKeyCalls: (exportSrc.match(/\|\| surnameKey\(/g) ?? []).length
      }
    )
    expect(
      'the shared module owns neither the suffix nor the name choice',
      !sharedSrc.includes('String.fromCharCode') &&
        !sharedSrc.includes('surname(') &&
        sharedSrc.includes('\\u3400-\\u9fff'),
      { present: sharedSrc.length > 0 }
    )
  }

  // A start-up sync has no open PDF to measure a page with. It must merge
  // only what the cloud already expresses in PDF points, never invent
  // coordinates for a local mark that has none, and never overwrite a mark
  // drawn while the network was in flight (176).
  {
    const pos = (page: number, x: number): PdfPos => ({ page, x, y: 10, w: 20, h: 5 })
    const local = (o: Partial<Annotation> & { id: string }): Annotation => ({
      docId: 'paper-a',
      page: 1,
      type: 'highlight',
      color: '#ffe066',
      rects: [],
      created: '2026-01-01T00:00:00.000Z',
      ...o
    })
    const cloud = (id: string, withPos = true): CloudAnnotation => ({
      id,
      document_id: 'paper-a',
      type: 'highlight',
      ...(withPos
        ? {
            positions: [
              { top_left: { x: 5, y: 7 }, bottom_right: { x: 15, y: 12 }, page: 2 }
            ]
          }
        : {})
    })
    const NOW = '2026-11-07T00:00:00.000Z'
    const known = local({
      id: 'l1',
      remoteId: 'c1',
      text: 'the words',
      note: 'my note',
      pos: [pos(1, 1)],
      rects: [{ x: 0, y: 0, w: 1, h: 1 }]
    })
    const localOnly = local({ id: 'l2', pos: [pos(3, 4)] })
    const localNoPos = local({ id: 'l3' })
    const orphan = local({ id: 'l4', remoteId: 'gone' })
    const mine = [known, localOnly, localNoPos, orphan]
    const mineSnapshot = JSON.stringify(mine)
    const cloudList = [
      cloud('c1'),
      cloud('c2'),
      cloud('c3', false),
      { ...cloud('c4', false), type: 'sticky_note' as const }
    ]
    const { merged, toPush } = mergeCloudAnnotations('paper-a', mine, cloudList, NOW)

    expect(
      'the merge keeps local words, notes and colours for a known cloud id',
      (() => {
        const m = merged.find((a) => a.id === 'l1')
        return (
          !!m && m.text === 'the words' && m.note === 'my note' &&
          m.color === '#ffe066' && m.remoteId === 'c1' && m.pos?.[0]?.page === 2
        )
      })(),
      { known: merged.find((a) => a.id === 'l1') }
    )
    expect(
      'a cloud-only mark is added with its positions and a cloud id',
      (() => {
        const m = merged.find((a) => a.id === 'cloud-c2')
        return !!m && m.remoteId === 'c2' && m.pos?.[0]?.x === 5 && m.created === NOW
      })(),
      { added: merged.find((a) => a.id === 'cloud-c2') }
    )
    expect(
      'a cloud mark with no positions is skipped unless it is a sticky note',
      !merged.some((a) => a.remoteId === 'c3') &&
        merged.some((a) => a.remoteId === 'c4' && a.type === 'note'),
      { ids: merged.map((a) => a.remoteId ?? a.id) }
    )
    expect(
      'a remote id the cloud no longer lists is kept, not deleted',
      merged.some((a) => a.id === 'l4'),
      { ids: merged.map((a) => a.id) }
    )
    expect(
      'only local-only marks carrying PDF points are offered for upload',
      toPush.length === 1 && toPush[0].id === 'l2' && toPush[0].pos[0].page === 3,
      { toPush }
    )
    expect(
      'the merge does not mutate the caller arrays',
      JSON.stringify(mine) === mineSnapshot && cloudList.length === 4,
      { unchanged: JSON.stringify(mine) === mineSnapshot }
    )

    const meanwhile = local({ id: 'l5', text: 'drawn while syncing' })
    const current = [...mine, meanwhile, local({ id: 'other', docId: 'paper-b' })]
    const applied = applyMergedAnnotations(current, 'paper-a', merged)
    expect(
      'writing back keeps a mark drawn while the sync was in flight',
      applied.some((a) => a.id === 'l5' && a.text === 'drawn while syncing') &&
        applied.some((a) => a.id === 'other' && a.docId === 'paper-b'),
      { ids: applied.map((a) => a.id) }
    )
    expect(
      'writing back also adds the new cloud mark and updates remote ids',
      applied.some((a) => a.id === 'cloud-c2') &&
        (applied.find((a) => a.id === 'l1')?.pos?.[0]?.page ?? 0) === 2,
      { ids: applied.map((a) => a.id) }
    )
    const pushed = markPushed(applied, 'l2', 'new-remote', [pos(3, 4)])
    expect(
      'a successful upload is recorded by id and leaves everything else alone',
      (pushed.find((a) => a.id === 'l2')?.remoteId ?? '') === 'new-remote' &&
        pushed.length === applied.length &&
        pushed.find((a) => a.id === 'l5')?.text === 'drawn while syncing',
      { pushedId: pushed.find((a) => a.id === 'l2')?.remoteId ?? null }
    )

    // Values alone do not prove the wiring. The detector is handed the old
    // start-up line and one wired line before it is trusted to read source.
    const syncRoot = path.join(__dirname, '../..')
    const libSrc = fs.readFileSync(path.join(syncRoot, 'src/lib/hooks/useLibrary.ts'), 'utf8')
    const marksSrc = fs.readFileSync(path.join(syncRoot, 'electron/main/ipc/marks.ts'), 'utf8')
    const preloadSrc = fs.readFileSync(path.join(syncRoot, 'electron/preload/index.ts'), 'utf8')
    const typesSrc = fs.readFileSync(path.join(syncRoot, 'src/global.d.ts'), 'utf8')
    const syncCalls = (t: string) => (t.match(/syncAnnotationsAtStart\(/g) ?? []).length
    const oldStart = 'window.api.sync(false).then((r) => setLib(r))'
    const wiredStart = 'window.api.syncAnnotationsAtStart()'
    expect(
      'the wiring detector can really see the call it is looking for',
      syncCalls(oldStart) === 0 && syncCalls(wiredStart) === 1,
      { old: syncCalls(oldStart), wired: syncCalls(wiredStart) }
    )
    expect(
      'the start-up pull, the API and the handler are all wired once',
      syncCalls(libSrc) === 1 &&
        (preloadSrc.match(/syncAnnotationsAtStart:/g) ?? []).length === 1 &&
        (typesSrc.match(/syncAnnotationsAtStart:/g) ?? []).length === 1 &&
        (marksSrc.match(/'annotations:syncAtStart'/g) ?? []).length === 1 &&
        (marksSrc.match(/mergeCloudAnnotations\(/g) ?? []).length === 1 &&
        (marksSrc.match(/applyMergedAnnotations\(/g) ?? []).length === 1 &&
        (marksSrc.match(/markPushed\(/g) ?? []).length === 1,
      {
        inHook: syncCalls(libSrc),
        inPreload: (preloadSrc.match(/syncAnnotationsAtStart:/g) ?? []).length,
        inHandler: (marksSrc.match(/'annotations:syncAtStart'/g) ?? []).length
      }
    )
    expect(
      'the same switch turns the marks pass off and its failure has a name',
      libSrc.includes('if (!syncOnStart') &&
        libSrc.includes('ignoreFailure(FAILURE.startupAnnotationSync') &&
        // split, so this file does not contain the exact empty-catch text
        // the 165 detector is looking for in product code
        !marksSrc.includes('catch' + '(() => {})'),
      { named: libSrc.includes('FAILURE.startupAnnotationSync') }
    )
  }

  // A click on the empty part of a list is the reader saying "nothing is
  // selected now". Esc and the batch bar only drop the multi-selection and
  // keep the open paper; a blank click drops all of it. Row clicks bubble to
  // the container, so the target decides (177).
  {
    const row = { closest: (s: string) => (s === '.row' ? {} : null) }
    const card = { closest: (s: string) => (s === '.res-row' ? {} : null) }
    const plain = { closest: () => null }
    expect(
      'a click outside every row is blank in both lists',
      isListBlank(plain, 'row') &&
        isListBlank(plain, 'res-row') &&
        isListBlank(null, 'row') &&
        isListBlank(undefined, 'row'),
      { plain: isListBlank(plain, 'row') }
    )
    expect(
      'a click on a row or a card is not blank in its own list',
      !isListBlank(row, 'row') &&
        !isListBlank(card, 'res-row') &&
        isListBlank(row, 'res-row') &&
        isListBlank(card, 'row'),
      { rowInTable: isListBlank(row, 'row'), cardInCards: isListBlank(card, 'res-row') }
    )
    expect(
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
    expect(
      'the wiring detector can really see a blank-click guard',
      blankCalls(oldWrap) === 0 && blankCalls(wiredWrap) === 1,
      { old: blankCalls(oldWrap), wired: blankCalls(wiredWrap) }
    )
    expect(
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

  // Opening a paper from a citation popover or an in-PDF link used to leave
  // the folder tree pointing at whatever folder was selected before — which
  // may not contain the paper now on screen. `folderId` is both the highlight
  // and the list filter, so moving it keeps the two in step (178).
  {
    const folders = [
      { id: 'f1', name: 'One' },
      { id: 'f2', name: 'Two' }
    ]
    const doc = (ids?: string[]): Doc => ({ id: 'd', ...(ids ? { folder_uuids: ids } : {}) })
    expect(
      'a paper in no folder clears the folder instead of leaving a wrong one',
      folderForOpenedDoc(doc(), 'f1', folders) === null &&
        folderForOpenedDoc(undefined, 'f1', folders) === null,
      { withEmpty: folderForOpenedDoc(doc(), 'f1', folders) }
    )
    expect(
      'a paper already inside the folder on screen leaves that folder alone',
      folderForOpenedDoc(doc(['f1', 'f2']), 'f2', folders) === 'f2',
      { kept: folderForOpenedDoc(doc(['f1', 'f2']), 'f2', folders) }
    )
    expect(
      'otherwise the first folder that still exists wins',
      folderForOpenedDoc(doc(['f1', 'f2']), null, folders) === 'f1' &&
        folderForOpenedDoc(doc(['gone', 'f2']), null, folders) === 'f2',
      { multiple: folderForOpenedDoc(doc(['f1', 'f2']), null, folders) }
    )
    expect(
      'a folder that was deleted cannot be selected',
      folderForOpenedDoc(doc(['gone', 'also-gone']), 'f1', folders) === null,
      { gone: folderForOpenedDoc(doc(['gone']), 'f1', folders) }
    )
    expect(
      'the rule does not mutate the document or the folder list',
      (() => {
        const d = doc(['f1'])
        const f = folders.slice()
        const out = folderForOpenedDoc(d, 'f2', f)
        return out === 'f1' && JSON.stringify(d.folder_uuids) === '["f1"]' && f.length === 2
      })(),
      {}
    )

    const folderRoot = path.join(__dirname, '../..')
    const appText = fs.readFileSync(path.join(folderRoot, 'src/App.tsx'), 'utf8')
    const treeText = fs.readFileSync(path.join(folderRoot, 'src/components/FolderTree.tsx'), 'utf8')
    const locateCalls = (t: string) => (t.match(/folderForOpenedDoc\(/g) ?? []).length
    const oldOpen = "onOpenDoc={(id) => {setSelId(id);setRightTab('pdf')}}"
    const wiredOpen = 'setFolderId(folderForOpenedDoc('
    expect(
      'the wiring detector can really see the folder lookup',
      locateCalls(oldOpen) === 0 && locateCalls(wiredOpen) === 1,
      { old: locateCalls(oldOpen), wired: locateCalls(wiredOpen) }
    )
    expect(
      'the app calls the folder lookup exactly once',
      locateCalls(appText) === 1,
      { lookups: locateCalls(appText) }
    )
    const openBlock = (appText.match(/onOpenDoc=\{\(id\) => \{[\s\S]*?\n      \}\}/) ?? [])[0] ?? ''
    expect(
      'the citation-open handler itself moves the folder and clears a saved search',
      openBlock.includes('folderForOpenedDoc(') &&
        openBlock.includes('setFolderId(') &&
        openBlock.includes('setActiveSearch(null)'),
      { block: openBlock.slice(0, 180) }
    )
    expect(
      'the tree highlight and the list filter are still the same state',
      (appText.match(/selected=\{folderId\}/g) ?? []).length === 1 &&
        treeText.includes('selected === f.id'),
      { tree: treeText.includes('selected === f.id') }
    )

    // The other half of the chain: moving folderId really does highlight a
    // row in the tree. Put the previous folder back afterwards, so the rest
    // of the run starts from where it was.
    const folderUi = JSON.parse(
      await w.webContents.executeJavaScript(
        '(async()=>{'
        + 'const wait=(m)=>new Promise(r=>setTimeout(r,m));'
        + 'const rows=()=>[...document.querySelectorAll(".folder-row")];'
        + 'if(rows().length<2)return JSON.stringify({error:"too few folders",n:rows().length});'
        + 'const nameOf=(r)=>((r.querySelector(".name")||{}).textContent||"").trim();'
        + 'const before=document.querySelector(".folder-row.sel");'
        + 'const beforeName=before?nameOf(before):"";'
        + 'const pick=rows().slice(1).find(r=>!r.classList.contains("sel"));'
        + 'if(!pick)return JSON.stringify({error:"no other folder"});'
        + 'pick.click();await wait(400);'
        + 'const after=document.querySelectorAll(".folder-row.sel").length;'
        + 'const picked=(document.querySelector(".folder-row.sel")||{});'
        + 'const pickedName=picked?nameOf(picked):"";'
        + 'const back=rows().find(r=>nameOf(r)===beforeName);'
        + 'if(back)back.click();await wait(400);'
        + 'return JSON.stringify({n:rows().length,beforeName,after,pickedName,'
        + 'restored:((document.querySelector(".folder-row.sel")||{}).textContent||"")'
        + '.includes(beforeName)})})()'
      )
    )
    log('folder tree highlight', folderUi)
    expect(
      'picking a folder highlights exactly that row and can be put back',
      folderUi.error === undefined &&
        typeof folderUi.beforeName === 'string' && folderUi.beforeName.length > 0 &&
        folderUi.after === 1 &&
        typeof folderUi.pickedName === 'string' && folderUi.pickedName.length > 0 &&
        folderUi.pickedName !== folderUi.beforeName &&
        folderUi.restored === true,
      folderUi
    )
  }

  // `created` has been in the library cache all along and is already a
  // default column, but the details pane never showed it. Trimming the ISO
  // timestamp must stay one rule shared by both places (180).
  {
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
    expect(
      'the shared day rule answers the old column rule for every input',
      drift.length === 0 && shortDate('2022-04-23T09:56:01.818Z') === '2022-04-23',
      { drift, samples: samples.length }
    )
    expect(
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
    expect(
      'both callers import the same day rule instead of keeping a copy',
      /from '[^']*shared\/shortDate'/.test(colSrc) &&
        /from '[^']*shared\/shortDate'/.test(panelSrc) &&
        !colSrc.includes('const shortDate =') &&
        sharedSrc.includes('export function shortDate('),
      { shared: sharedSrc.length > 0 }
    )
    expect(
      'the details pane shows it read-only with the exact moment on hover',
      /<label>加入时间<\/label>/.test(panelSrc) &&
        /shortDate\(doc\.created\) \|\| '未知'/.test(panelSrc) &&
        /readOnly/.test(panelSrc) &&
        /title=\{doc\.created \?\? ''\}/.test(panelSrc),
      { panel: panelSrc.length > 0 }
    )
  }

  // A pull can run for minutes. While it talked to Mendeley the reader may
  // have trashed a paper or imported one; the old sync wrote the starting
  // snapshot straight back, so the trashed paper came back and stayed until
  // a full pull. The old merge is copied verbatim below so the control is a
  // real comparison, not an assertion about a rule nobody ran (181).
  {
    type D = { id: string; tag?: string }
    const d = (id: string, tag?: string): D => (tag ? { id, tag } : { id })
    const empty = new Set<string>()
    const legacyWrite = (started: D[], proposed: D[]): D[] => {
      const byId = new Map(started.map((x) => [x.id, x]))
      for (const x of proposed) byId.set(x.id, x)
      return [...byId.values()]
    }
    const reconcile = (
      started: D[],
      proposed: D[],
      current: D[] | null,
      trashedIds = empty
    ) => reconcileSyncWrite({ started, proposed, current, trashedIds })

    const started = [d('A'), d('B')]
    const proposed = [d('A'), d('B')]
    const currentAfterTrash = [d('B')]
    const fixed = reconcile(started, proposed, currentAfterTrash)
    const old = legacyWrite(started, proposed)
    expect(
      'the old sync really resurrects a paper trashed mid-pull',
      old.some((x) => x.id === 'A') &&
        !fixed.some((x) => x.id === 'A') &&
        fixed.length === 1,
      { old: old.map((x) => x.id), fixed: fixed.map((x) => x.id) }
    )
    expect(
      'the reconcile keeps documents added locally during the pull',
      (() => {
        const r = reconcile([d('A')], [d('A'), d('C')], [d('A'), d('X')])
        const ids = new Set(r.map((x) => x.id))
        return ids.size === 3 && ids.has('A') && ids.has('C') && ids.has('X')
      })(),
      {}
    )
    expect(
      'the reconcile drops cloud deletions, trash and written-back residue',
      (() => {
        const cloudDel = reconcile([d('A'), d('B')], [d('A')], [d('A'), d('B')])
        const trashed = reconcile([d('A')], [d('A')], [d('A')], new Set(['A']))
        const residue = reconcile(started, proposed, started, new Set(['A']))
        return (
          cloudDel.length === 1 && cloudDel[0].id === 'A' &&
          trashed.length === 0 &&
          residue.length === 1 && residue[0].id === 'B'
        )
      })(),
      {}
    )
    expect(
      'a locally added paper that went to the trash does not sneak back',
      reconcile([d('A')], [d('A')], [d('A'), d('X')], new Set(['X']))
        .every((x) => x.id === 'A'),
      {}
    )
    expect(
      'with no cache file yet the cloud answer is still filtered by trash',
      reconcile([], [d('A'), d('B')], null, new Set(['A']))
        .map((x) => x.id)
        .join(',') === 'B',
      {}
    )
    expect(
      'the reconcile does not mutate any input array or set',
      (() => {
        const s = [d('A'), d('B')]
        const p = [d('A'), d('B')]
        const c = [d('B')]
        const t = new Set(['B'])
        const snap = JSON.stringify({ s, p, c, t: [...t] })
        reconcile(s, p, c, t)
        return JSON.stringify({ s, p, c, t: [...t] }) === snap
      })(),
      {}
    )

    const reconcileRoot = path.join(__dirname, '../..')
    const libSrc = fs.readFileSync(
      path.join(reconcileRoot, 'electron/main/library.ts'),
      'utf8'
    )
    const storeSrc = fs.readFileSync(
      path.join(reconcileRoot, 'electron/main/store.ts'),
      'utf8'
    )
    const fromSyncCalls = (text: string) =>
      (text.match(/saveLibraryFromSync\(/g) ?? []).length
    const oldWrite = 'let docs = since ? [...byId.values()] : changed\n  saveLibrary(docs, folders)'
    const wiredWrite = 'saveLibraryFromSync(finalDocs, folders)'
    expect(
      'the wiring detector can tell the old unconditional write from the new one',
      fromSyncCalls(oldWrite) === 0 && fromSyncCalls(wiredWrite) === 1,
      { old: fromSyncCalls(oldWrite), wired: fromSyncCalls(wiredWrite) }
    )
    expect(
      'the sync asks the cloud trash on every pull and no longer says only a full pull finds deletions',
      (libSrc.match(/listTrash\(\)/g) ?? []).length === 1 &&
        libSrc.includes('回收站对账') &&
        !libSrc.includes('删除只在全量同步时发现') &&
        /Date\.parse\(prev\.syncedAt\) > 0/.test(libSrc),
      { trashCalls: (libSrc.match(/listTrash\(\)/g) ?? []).length }
    )
    expect(
      'the sync reconciles before writing and returns the reconciled list',
      (libSrc.match(/reconcileSyncWrite\(/g) ?? []).length === 1 &&
        fromSyncCalls(libSrc) === 1 &&
        !libSrc.includes('saveLibrary(docs, folders)') &&
        libSrc.includes('return { docs: finalDocs, folders }'),
      { reconcile: (libSrc.match(/reconcileSyncWrite\(/g) ?? []).length }
    )
    expect(
      'local writes keep the watermark and only a real sync advances it',
      /prev\?\.syncedAt \?\? new Date\(0\)\.toISOString\(\)/.test(storeSrc) &&
        (storeSrc.match(/export function saveLibraryFromSync/g) ?? []).length === 1 &&
        storeSrc.includes('writeLibrary(docs, folders, new Date().toISOString())'),
      { bytes: storeSrc.length }
    )
  }

  // Links and citation markers each walked every page of a continuous PDF
  // with their own copy of the same loop, including a literal batch size of
  // 8. Pulling it into a pure controller is only safe if the event sequence
  // is identical -- and only worth doing if the batching rule can be shown
  // to matter. One assertion is a control; the rest are decided by handing
  // the walk promises that resolve on the spot.
  {
    type Host = PageWalkHost<string>
    type Scenario = {
      name: string
      last: number
      claimed?: number[]
      failAt?: number
      deadAt?: number
    }
    const makeHost = (o: {
      claimed?: number[]
      failAt?: number
      deadAt?: number
    }) => {
      const events: string[] = []
      const claimed = new Set(o.claimed ?? [])
      const busy = new Set<number>()
      const writes: Array<Record<number, string[]>> = []
      let dead = false
      const host: Host = {
        isDead: () => dead,
        isClaimed: (n) => claimed.has(n) || busy.has(n),
        claim: (n) => {
          busy.add(n)
          events.push('claim:' + n)
        },
        release: (n) => {
          busy.delete(n)
          events.push('release:' + n)
        },
        publish: (batch) => {
          events.push('write:' + Object.keys(batch).join(','))
          writes.push(batch)
        }
      }
      const read = (n: number): Promise<string[]> => {
        events.push('read:' + n)
        if (n === o.deadAt) dead = true
        if (n === o.failAt) return Promise.reject(new Error('page will not read'))
        return Promise.resolve(['p' + n])
      }
      return { events, host, read, writes, busy }
    }

    // Control: without batching, twenty pages really are twenty column
    // rebuilds. If this could not be shown, the assertion below would be
    // one that can never fail.
    const noBatching = async (
      last: number,
      h: Host,
      read: (n: number) => Promise<string[]>
    ) => {
      for (let n = 1; n <= last; n++) {
        if (h.isDead()) return
        if (h.isClaimed(n)) continue
        h.claim(n)
        let got: string[]
        try {
          got = await read(n)
        } catch {
          got = []
        }
        h.release(n)
        if (h.isDead()) return
        h.publish({ [n]: got })
      }
    }
    const ctrl = makeHost({})
    await noBatching(20, ctrl.host, ctrl.read)
    expect(
      'a loop with no batching really does rebuild the column once per page',
      ctrl.writes.length === 20,
      { writes: ctrl.writes.length }
    )

    const box = makeHost({})
    await createPageWalk<string>(box.host).walk(20, box.read)
    expect(
      'the shared walk publishes one screenful rather than one page',
      box.writes.length === 3,
      {
        writes: box.writes.length,
        batches: box.writes.map((b) => Object.keys(b).length)
      }
    )
    expect(
      'a short final batch is still flushed on the last page',
      Object.keys(box.writes[0]).length === PAGE_BATCH_SIZE &&
        Object.keys(box.writes[1]).length === PAGE_BATCH_SIZE &&
        Object.keys(box.writes[2]).join(',') === '17,18,19,20',
      { batches: box.writes.map((b) => Object.keys(b).join(',')) }
    )
    expect(
      'the batch size is one named constant rather than a literal in both loops',
      PAGE_BATCH_SIZE === 8 && box.writes.length === Math.ceil(20 / PAGE_BATCH_SIZE),
      { size: PAGE_BATCH_SIZE, writes: box.writes.length }
    )

    // The two loops exactly as they stood in the hooks, copied line for line.
    // One ends at `numPages`, the other at `refPage - 1`; both must agree
    // with the shared walk over the same pages, event for event.
    const oldLinksLoop = async (
      numPages: number,
      h: Host,
      read: (n: number) => Promise<string[]>
    ) => {
      let batch: Record<number, string[]> = {}
      for (let n = 1; n <= numPages; n++) {
        if (h.isDead()) return
        if (h.isClaimed(n)) continue
        h.claim(n)
        let got: string[]
        try {
          got = await read(n)
        } catch {
          got = []
        }
        h.release(n)
        if (h.isDead()) return
        batch[n] = got
        if (Object.keys(batch).length >= 8 || n === numPages) {
          const flush = batch
          batch = {}
          h.publish(flush)
        }
      }
    }
    const oldRefsLoop = async (
      refPage: number,
      h: Host,
      read: (n: number) => Promise<string[]>
    ) => {
      let batch: Record<number, string[]> = {}
      for (let n = 1; n < refPage; n++) {
        if (h.isDead()) return
        if (h.isClaimed(n)) continue
        h.claim(n)
        let got: string[]
        try {
          got = await read(n)
        } catch {
          got = []
        }
        h.release(n)
        if (h.isDead()) return
        batch[n] = got
        if (Object.keys(batch).length >= 8 || n === refPage - 1) {
          const flush = batch
          batch = {}
          h.publish(flush)
        }
      }
    }
    const scenarios: Scenario[] = [
      { name: 'no pages', last: 0 },
      { name: 'one page', last: 1 },
      { name: 'under one batch', last: 7 },
      { name: 'exactly one batch', last: 8 },
      { name: 'one page past a batch', last: 9 },
      { name: 'two batches', last: 12 },
      { name: 'three batches', last: 23 },
      { name: 'claimed pages', last: 12, claimed: [3, 7] },
      { name: 'claimed last page', last: 12, claimed: [3, 12] },
      { name: 'a failing page', last: 12, failAt: 5 },
      { name: 'killed mid-walk', last: 12, deadAt: 5 }
    ]
    // 167 changed exactly one scenario: a claimed last page. Keep the other
    // ten as the event-for-event control; that one is checked separately
    // below against both copied loops. The copies themselves stay verbatim.
    const equivalence = scenarios.filter((s) => s.name !== 'claimed last page')
    const mismatches: string[] = []
    for (const s of equivalence) {
      const a = makeHost(s)
      const b = makeHost(s)
      const c = makeHost(s)
      await oldLinksLoop(s.last, a.host, a.read)
      await oldRefsLoop(s.last + 1, b.host, b.read)
      await createPageWalk<string>(c.host).walk(s.last, c.read)
      const key = (x: { events: string[] }) => x.events.join('|')
      if (key(a) !== key(b) || key(a) !== key(c)) mismatches.push(s.name)
    }
    expect(
      'both old loop shapes and the shared walk produce the same events',
      mismatches.length === 0,
      { scenarios: equivalence.length, mismatches }
    )

    // 167: the walk used to lose the last short batch when the final page was
    // already claimed. The copied loops are still here verbatim as the control
    // -- proving the loss really happened is what keeps this fix from being a
    // no-op that happens to pass.
    const claimedLast: Scenario = {
      name: 'claimed last page',
      last: 12,
      claimed: [3, 12]
    }
    const oldClaimed = makeHost(claimedLast)
    await oldLinksLoop(claimedLast.last, oldClaimed.host, oldClaimed.read)
    const newClaimed = makeHost(claimedLast)
    await createPageWalk<string>(newClaimed.host).walk(
      claimedLast.last,
      newClaimed.read
    )
    expect(
      'the old loop really dropped the batch when the last page was claimed',
      oldClaimed.writes.length === 1 &&
        Object.keys(oldClaimed.writes[0]).length === PAGE_BATCH_SIZE &&
        oldClaimed.writes[0][10] === undefined &&
        oldClaimed.writes[0][11] === undefined,
      {
        writes: oldClaimed.writes.length,
        batches: oldClaimed.writes.map((b) => Object.keys(b).join(','))
      }
    )
    expect(
      'the fixed walk publishes the leftover batch when the last page is claimed',
      newClaimed.writes.length === 2 &&
        Object.keys(newClaimed.writes[1]).join(',') === '10,11' &&
        newClaimed.writes[1][10]?.[0] === 'p10' &&
        newClaimed.writes[1][11]?.[0] === 'p11',
      {
        writes: newClaimed.writes.length,
        batches: newClaimed.writes.map((b) => Object.keys(b).join(','))
      }
    )
    expect(
      'the fix adds only the trailing publish and changes nothing earlier',
      newClaimed.events.length === oldClaimed.events.length + 1 &&
        newClaimed.events.slice(0, oldClaimed.events.length).join('|') ===
          oldClaimed.events.join('|') &&
        newClaimed.events[newClaimed.events.length - 1] === 'write:10,11',
      {
        oldEvents: oldClaimed.events.length,
        newEvents: newClaimed.events.length,
        last: newClaimed.events[newClaimed.events.length - 1]
      }
    )

    // The trailing publish is new: prove it cannot resurrect a walk that was
    // killed while it still held a short, unflushed batch. Five reads with no
    // write means the batch really was pending, so this assertion is not one
    // that passes simply because there was nothing to publish.
    const deadWalk = makeHost({ deadAt: 5 })
    await createPageWalk<string>(deadWalk.host).walk(12, deadWalk.read)
    expect(
      'a dead walk drops its pending batch instead of publishing on the way out',
      deadWalk.events.filter((e) => e.startsWith('read:')).length === 5 &&
        deadWalk.writes.length === 0,
      {
        reads: deadWalk.events.filter((e) => e.startsWith('read:')),
        writes: deadWalk.writes.length
      }
    )

    const full = makeHost({})
    await createPageWalk<string>(full.host).walk(16, full.read)
    expect(
      'a full final batch is not published twice',
      full.writes.length === 2 &&
        full.writes.every((b) => Object.keys(b).length === PAGE_BATCH_SIZE),
      { batches: full.writes.map((b) => Object.keys(b).length) }
    )

    const none = makeHost({})
    await createPageWalk<string>(none.host).walk(0, none.read)
    const allClaimed = makeHost({ claimed: [1, 2, 3] })
    await createPageWalk<string>(allClaimed.host).walk(3, allClaimed.read)
    expect(
      'a walk with nothing left over publishes nothing',
      none.writes.length === 0 && allClaimed.writes.length === 0,
      { noPages: none.writes.length, allClaimed: allClaimed.writes.length }
    )

    const skipped = makeHost({ claimed: [3, 7] })
    await createPageWalk<string>(skipped.host).walk(12, skipped.read)
    expect(
      'pages already claimed are skipped without breaking the batch rhythm',
      !skipped.events.includes('read:3') &&
        !skipped.events.includes('read:7') &&
        skipped.writes.length === 2 &&
        Object.keys(skipped.writes[0]).length === PAGE_BATCH_SIZE &&
        Object.keys(skipped.writes[1]).join(',') === '11,12',
      {
        reads: skipped.events.filter((e) => e.startsWith('read:')),
        batches: skipped.writes.map((b) => Object.keys(b).join(','))
      }
    )

    const failing = makeHost({ failAt: 5 })
    await createPageWalk<string>(failing.host).walk(12, failing.read)
    expect(
      'a page that fails to read is published as empty and the walk continues',
      failing.writes.length === 2 &&
        JSON.stringify(failing.writes[0]['5']) === '[]' &&
        failing.events.includes('read:12'),
      {
        pageFive: failing.writes[0]['5'],
        batches: failing.writes.map((b) => Object.keys(b).length)
      }
    )

    const killed = makeHost({ deadAt: 5 })
    await createPageWalk<string>(killed.host).walk(12, killed.read)
    expect(
      'a walk killed mid-page stops before publishing anything else',
      killed.writes.length === 0 &&
        !killed.events.includes('read:6') &&
        killed.busy.size === 0,
      {
        writes: killed.writes.length,
        reads: killed.events.filter((e) => e.startsWith('read:')),
        busy: killed.busy.size
      }
    )

    const empty = makeHost({})
    await createPageWalk<string>(empty.host).walk(0, empty.read)
    expect(
      'a reference list on page one starts a walk over no pages',
      empty.events.length === 0 && empty.writes.length === 0,
      { events: empty.events.length, writes: empty.writes.length }
    )

    const paired = makeHost({ claimed: [3], failAt: 5 })
    await createPageWalk<string>(paired.host).walk(12, paired.read)
    const claims = paired.events.filter((e) => e.startsWith('claim:')).length
    const releases = paired.events.filter((e) => e.startsWith('release:')).length
    expect(
      'every claimed page is released, including one whose read failed',
      claims === 11 && releases === claims && paired.busy.size === 0,
      { claims, releases, busy: paired.busy.size }
    )
  }

  // A config file is plain JSON and can be hand edited. The renderer used to
  // accept any positive number while the index builder clamped it, so one
  // config entry could describe two different budgets. The restore path now
  // goes through the same shared rule (163). One assertion is a control:
  // without it the other five would be scoring a disagreement that was never
  // shown to exist.
  {
    const oldRestore = (v: unknown): number =>
      typeof v === 'number' && v > 0 ? v : DEFAULT_FT_PAGES
    const indexUses = (v: unknown): number => clampFullTextPages(v)

    expect(
      'the old restore really could disagree with the index builder',
      oldRestore(999) === 999 &&
        indexUses(999) === FULL_TEXT_MAX_PAGES &&
        oldRestore(999) !== indexUses(999),
      { restored: oldRestore(999), indexed: indexUses(999) }
    )

    const values: unknown[] = [
      1, 2, 3, 4.9, 50, 51, 999, -1, -999, 0, NaN, Infinity, -Infinity,
      0.5, 49.9
    ]
    for (let n = -10; n <= 60; n++) values.push(n)
    const drift = values.filter(
      (v) =>
        restoredPageBudget(v) !==
        indexUses(typeof v === 'number' && v > 0 ? v : DEFAULT_FT_PAGES)
    )
    expect(
      'a restored budget agrees with the index rule for every valid value',
      drift.length === 0,
      { checked: values.length, drift }
    )

    const unusable: unknown[] = [undefined, null, 0, -1, NaN, '', '7', {}, []]
    expect(
      'a missing or unusable config value falls back to the shared default',
      unusable.every((v) => restoredPageBudget(v) === DEFAULT_FT_PAGES),
      {
        answers: unusable.map((v) => restoredPageBudget(v))
      }
    )

    expect(
      'a numeric string in a hand-edited config is not a page budget',
      restoredPageBudget('7') === DEFAULT_FT_PAGES &&
        restoredPageBudget('50') === DEFAULT_FT_PAGES &&
        oldRestore('7') === DEFAULT_FT_PAGES,
      { seven: restoredPageBudget('7'), fifty: restoredPageBudget('50') }
    )

    expect(
      'a fractional budget from a config file is floored before it is stored',
      restoredPageBudget(4.9) === 4 &&
        restoredPageBudget(2.1) === 2 &&
        restoredPageBudget(50.9) === FULL_TEXT_MAX_PAGES,
      {
        fourNine: restoredPageBudget(4.9),
        twoOne: restoredPageBudget(2.1),
        fiftyNine: restoredPageBudget(50.9)
      }
    )

    let outside = 0
    for (let n = -100; n <= 200; n++) {
      const v = restoredPageBudget(n + 0.5)
      if (
        v < FULL_TEXT_MIN_PAGES ||
        v > FULL_TEXT_MAX_PAGES ||
        !Number.isInteger(v)
      ) outside += 1
    }
    expect(
      'no restored budget can leave the index bounds',
      outside === 0 &&
        restoredPageBudget(DEFAULT_FT_PAGES) === DEFAULT_FT_PAGES,
      { outside, min: FULL_TEXT_MIN_PAGES, max: FULL_TEXT_MAX_PAGES }
    )
  }


  // Eight delays that used to be bare literals (164). Naming them is only a
  // readability change if not one number moved. The literals are kept here as
  // the control, and a deliberately swapped wiring proves the control can
  // fail -- an assertion that can never go red looks exactly like a pass.
  {
    const legacy: Record<string, number> = {
      UPDATE_INSTALL_DELAY_MS: 700,
      COPIED_FEEDBACK_VISIBLE_MS: 1400,
      HIGHLIGHT_UNDO_WINDOW_MS: 8000,
      FIND_QUERY_DEBOUNCE_MS: 250,
      FULL_TEXT_QUERY_DEBOUNCE_MS: 250,
      COLUMN_WIDTH_PERSIST_DEBOUNCE_MS: 400,
      PANE_WIDTH_PERSIST_DEBOUNCE_MS: 400,
      READING_POSITION_PERSIST_DEBOUNCE_MS: 600
    }
    const named: Record<string, number> = {
      UPDATE_INSTALL_DELAY_MS,
      COPIED_FEEDBACK_VISIBLE_MS,
      HIGHLIGHT_UNDO_WINDOW_MS,
      FIND_QUERY_DEBOUNCE_MS,
      FULL_TEXT_QUERY_DEBOUNCE_MS,
      COLUMN_WIDTH_PERSIST_DEBOUNCE_MS,
      PANE_WIDTH_PERSIST_DEBOUNCE_MS,
      READING_POSITION_PERSIST_DEBOUNCE_MS
    }
    const drift = (got: Record<string, number>): string[] =>
      Object.keys(legacy).filter((k) => got[k] !== legacy[k])

    expect(
      'every named delay still answers its old literal',
      Object.keys(legacy).length === 8 &&
        Object.keys(named).length === 8 &&
        drift(named).length === 0,
      { checked: Object.keys(legacy).length, drift: drift(named) }
    )

    const swapped: Record<string, number> = {
      ...named,
      FIND_QUERY_DEBOUNCE_MS: READING_POSITION_PERSIST_DEBOUNCE_MS,
      READING_POSITION_PERSIST_DEBOUNCE_MS: FIND_QUERY_DEBOUNCE_MS
    }
    expect(
      'a swapped wiring really would be caught',
      drift(swapped).length === 2,
      { drift: drift(swapped) }
    )

    expect(
      'the multiset of delay values did not change',
      JSON.stringify(Object.values(legacy).sort((a, b) => a - b)) ===
        JSON.stringify(Object.values(named).sort((a, b) => a - b)),
      {
        legacy: Object.values(legacy).sort((a, b) => a - b),
        named: Object.values(named).sort((a, b) => a - b)
      }
    )

    expect(
      'the two 400ms persistence debounces stay separate decisions',
      COLUMN_WIDTH_PERSIST_DEBOUNCE_MS === 400 &&
        PANE_WIDTH_PERSIST_DEBOUNCE_MS === 400 &&
        Object.keys(named).length === 8,
      {
        columns: COLUMN_WIDTH_PERSIST_DEBOUNCE_MS,
        panes: PANE_WIDTH_PERSIST_DEBOUNCE_MS
      }
    )

    expect(
      'every named delay is a finite positive whole number',
      Object.values(named).every(
        (v) => Number.isFinite(v) && Number.isInteger(v) && v > 0
      ),
      { values: Object.values(named) }
    )

    // Constant values alone do not prove the call sites were wired. This run
    // always executes from the checkout, so the source beside the built main
    // bundle is readable; a missing checkout must fail loudly, not skip.
    const sites: { file: string; names: string[]; old: string[] }[] = [
      {
        file: 'src/App.tsx',
        names: ['UPDATE_INSTALL_DELAY_MS', 'COLUMN_WIDTH_PERSIST_DEBOUNCE_MS'],
        old: ['installUpdate(), 700)', '}, 400)']
      },
      {
        file: 'src/components/SetupGuide.tsx',
        names: ['COPIED_FEEDBACK_VISIBLE_MS'],
        old: ['setCopied(false), 1400)']
      },
      {
        file: 'src/components/PdfViewer.tsx',
        names: ['READING_POSITION_PERSIST_DEBOUNCE_MS'],
        old: ['}, 600)']
      },
      {
        file: 'src/lib/hooks/useFullText.ts',
        names: ['FULL_TEXT_QUERY_DEBOUNCE_MS'],
        old: ['ask(q, 250)']
      },
      {
        file: 'src/lib/hooks/usePaneWidths.ts',
        names: ['PANE_WIDTH_PERSIST_DEBOUNCE_MS'],
        old: ['}, 400)']
      },
      {
        file: 'src/lib/hooks/usePdfAnnotations.ts',
        names: ['HIGHLIGHT_UNDO_WINDOW_MS'],
        old: ['setJustMade(null), 8000)']
      },
      {
        file: 'src/lib/hooks/usePdfFind.ts',
        names: ['FIND_QUERY_DEBOUNCE_MS'],
        old: ['runFind(findQ), 250)']
      }
    ]
    const root = path.join(__dirname, '../..')
    const reads = sites.map((s) => {
      const f = path.join(root, s.file)
      return { file: s.file, text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null }
    })
    expect(
      'the eight call sites can be read from this checkout',
      reads.every((r) => r.text !== null),
      { missing: reads.filter((r) => r.text === null).map((r) => r.file) }
    )

    const notWired = reads.flatMap((r, i) => {
      const t = r.text ?? ''
      const bad: string[] = []
      if (!/from '[^']*timing'/.test(t))
        bad.push(sites[i].file + ': no timing import')
      for (const name of sites[i].names) {
        const hits = (t.match(new RegExp('\\b' + name + '\\b', 'g')) ?? []).length
        if (hits < 2) bad.push(sites[i].file + ': ' + name + ' appears ' + hits + ' times')
      }
      return bad
    })
    expect(
      'all eight call sites use their named delay',
      notWired.length === 0,
      { notWired }
    )

    const leftovers = reads.flatMap((r, i) =>
      sites[i].old
        .filter((o) => (r.text ?? '').includes(o))
        .map((o) => sites[i].file + ': ' + o)
    )
    expect(
      'no bare delay literal is left at any call site',
      leftovers.length === 0,
      { leftovers }
    )
  }


  // 164 named eight delays but only looked at direct setTimeout call sites.
  // Fourteen more were hiding as arguments to flashBatch / flashImport (168):
  // ten in App.tsx and four in useExport.ts. Naming them is a readability
  // change only if not one number moved, and only if the call sites really
  // stopped using the literals.
  {
    const legacy: Record<string, number> = {
      STARTUP_UPDATE_CHECK_DELAY_MS: 4000,
      BATCH_CLEAN_MESSAGE_VISIBLE_MS: 2500,
      BATCH_FAILED_MESSAGE_VISIBLE_MS: 5000,
      RENAME_RESULT_MESSAGE_VISIBLE_MS: 3000,
      FOLDER_NOOP_MESSAGE_VISIBLE_MS: 2500,
      ALL_HAVE_PDF_MESSAGE_VISIBLE_MS: 2500,
      DOWNLOAD_STOPPED_MESSAGE_VISIBLE_MS: 3000,
      BATCH_ACTION_MESSAGE_VISIBLE_MS: 2200,
      CITATION_COPIED_MESSAGE_VISIBLE_MS: 2400,
      IMPORT_FINISHED_MESSAGE_VISIBLE_MS: 2500,
      EXPORT_BIBLIOGRAPHY_MESSAGE_VISIBLE_MS: 6000,
      EXPORT_NOTES_MESSAGE_VISIBLE_MS: 6000,
      EXPORT_ANNOTATIONS_MESSAGE_VISIBLE_MS: 6000,
      EXPORT_LIBRARY_MESSAGE_VISIBLE_MS: 12000
    }
    const named: Record<string, number> = {
      STARTUP_UPDATE_CHECK_DELAY_MS,
      BATCH_CLEAN_MESSAGE_VISIBLE_MS,
      BATCH_FAILED_MESSAGE_VISIBLE_MS,
      RENAME_RESULT_MESSAGE_VISIBLE_MS,
      FOLDER_NOOP_MESSAGE_VISIBLE_MS,
      ALL_HAVE_PDF_MESSAGE_VISIBLE_MS,
      DOWNLOAD_STOPPED_MESSAGE_VISIBLE_MS,
      BATCH_ACTION_MESSAGE_VISIBLE_MS,
      CITATION_COPIED_MESSAGE_VISIBLE_MS,
      IMPORT_FINISHED_MESSAGE_VISIBLE_MS,
      EXPORT_BIBLIOGRAPHY_MESSAGE_VISIBLE_MS,
      EXPORT_NOTES_MESSAGE_VISIBLE_MS,
      EXPORT_ANNOTATIONS_MESSAGE_VISIBLE_MS,
      EXPORT_LIBRARY_MESSAGE_VISIBLE_MS
    }
    const drift = (got: Record<string, number>): string[] =>
      Object.keys(legacy).filter((k) => got[k] !== legacy[k])

    expect(
      'every newly named message duration still answers its old literal',
      Object.keys(legacy).length === 14 &&
        Object.keys(named).length === 14 &&
        drift(named).length === 0,
      { checked: Object.keys(legacy).length, drift: drift(named) }
    )

    const swapped: Record<string, number> = {
      ...named,
      BATCH_CLEAN_MESSAGE_VISIBLE_MS: BATCH_FAILED_MESSAGE_VISIBLE_MS,
      BATCH_FAILED_MESSAGE_VISIBLE_MS: BATCH_CLEAN_MESSAGE_VISIBLE_MS
    }
    expect(
      'a swapped message duration really would be caught',
      drift(swapped).length === 2,
      { drift: drift(swapped) }
    )

    expect(
      'the multiset of the fourteen durations did not change',
      JSON.stringify(Object.values(legacy).sort((a, b) => a - b)) ===
        JSON.stringify(Object.values(named).sort((a, b) => a - b)),
      {
        legacy: Object.values(legacy).sort((a, b) => a - b),
        named: Object.values(named).sort((a, b) => a - b)
      }
    )

    const distinct = new Set(Object.values(named)).size
    expect(
      'equal durations stay separate decisions rather than one shared key',
      Object.keys(named).length === 14 &&
        distinct === 8 &&
        Object.values(named).filter((v) => v === 2500).length === 4 &&
        Object.values(named).filter((v) => v === 3000).length === 2 &&
        Object.values(named).filter((v) => v === 6000).length === 3,
      { keys: Object.keys(named).length, distinct }
    )

    expect(
      'every newly named delay is a finite positive whole number',
      Object.values(named).every(
        (v) => Number.isFinite(v) && Number.isInteger(v) && v > 0
      ),
      { values: Object.values(named) }
    )

    // Values alone do not prove the wiring. Read the two product files back
    // from the checkout, as 164 did for its eight sites.
    const sites: { file: string; names: string[] }[] = [
      {
        file: 'src/App.tsx',
        names: [
          'STARTUP_UPDATE_CHECK_DELAY_MS',
          'BATCH_CLEAN_MESSAGE_VISIBLE_MS',
          'BATCH_FAILED_MESSAGE_VISIBLE_MS',
          'RENAME_RESULT_MESSAGE_VISIBLE_MS',
          'FOLDER_NOOP_MESSAGE_VISIBLE_MS',
          'ALL_HAVE_PDF_MESSAGE_VISIBLE_MS',
          'DOWNLOAD_STOPPED_MESSAGE_VISIBLE_MS',
          'BATCH_ACTION_MESSAGE_VISIBLE_MS',
          'CITATION_COPIED_MESSAGE_VISIBLE_MS',
          'IMPORT_FINISHED_MESSAGE_VISIBLE_MS'
        ]
      },
      {
        file: 'src/lib/hooks/useExport.ts',
        names: [
          'EXPORT_BIBLIOGRAPHY_MESSAGE_VISIBLE_MS',
          'EXPORT_NOTES_MESSAGE_VISIBLE_MS',
          'EXPORT_ANNOTATIONS_MESSAGE_VISIBLE_MS',
          'EXPORT_LIBRARY_MESSAGE_VISIBLE_MS'
        ]
      }
    ]
    const root = path.join(__dirname, '../..')
    const reads = sites.map((s) => {
      const f = path.join(root, s.file)
      return { file: s.file, text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null }
    })
    expect(
      'both product files can be read from this checkout',
      reads.every((r) => r.text !== null),
      { missing: reads.filter((r) => r.text === null).map((r) => r.file) }
    )

    const notWired = reads.flatMap((r, i) => {
      const t = r.text ?? ''
      const bad: string[] = []
      if (!/from '[^']*timing'/.test(t))
        bad.push(sites[i].file + ': no timing import')
      for (const name of sites[i].names) {
        const hits = (t.match(new RegExp('\\b' + name + '\\b', 'g')) ?? []).length
        // once in the import, once at its own call site
        if (hits !== 2) bad.push(sites[i].file + ': ' + name + ' appears ' + hits + ' times')
      }
      return bad
    })
    expect(
      'all fourteen call sites use their named duration exactly once',
      notWired.length === 0,
      { notWired }
    )

    // A bare duration is either the trailing argument of a flash/setTimeout
    // call, or -- for the one wrapped call -- a number alone on its own line.
    const bareNumbers = (t: string): string[] => [
      ...[...t.matchAll(/,\s*(\d{3,5})\s*\)/g)].map((m) => m[1]),
      ...[...t.matchAll(/^[ \t]*(\d{3,5})[ \t]*$/gm)].map((m) => m[1])
    ]
    const leftovers = reads.flatMap((r) =>
      bareNumbers(r.text ?? '').map((n) => r.file + ': ' + n)
    )
    expect(
      'no bare message duration is left in either product file',
      leftovers.length === 0,
      { leftovers }
    )

    // Control: the fourteen lines exactly as they stood before 168 must all
    // be caught by that detector, otherwise an empty result proves nothing.
    const legacyLines = [
      '    }, 4000)',
      '      flashBatch(`${what} ${ok} 条`, 2500)',
      '    flashBatch(`${what} ${ok} 条，${failed.length} 条失败`, 5000)',
      "          flashBatch(`已重命名 ${r.renamed} 个文件${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`, 3000)",
      "      flashBatch(op === 'add' ? '这些文献已经在这个文件夹里' : '这些文献不在这个文件夹里', 2500)",
      "      flashBatch('这些本地都已经有 PDF 了', 2500)",
      '      flashBatch(`已停止，下载了 ${okN} 篇`, 3000)',
      '    flashBatch(`${label} ${n} 条`, 2200)',
      '      2400',
      "    flashImport(files.length > 1 ? `已导入 ${files.length} 篇` : '导入完成', 2500)",
      '      flashBatch(`已导出 ${target.length} 条到 ${r.path}`, 6000)',
      '      flashBatch(`已导出 ${withNotes.length} 条笔记到 ${r.path}`, 6000)',
      '      flashBatch(`已导出 ${picked.length} 条标注到 ${r.path}`, 6000)',
      "        flashBatch(`已放到 ${dir}：${bits.join(' · ')}`, 12000)"
    ]
    expect(
      'the leftover detector really sees all fourteen old literals',
      legacyLines.length === 14 && bareNumbers(legacyLines.join('\n')).length === 14,
      { lines: legacyLines.length, caught: bareNumbers(legacyLines.join('\n')) }
    )
  }


  // Four call sites used to compute a page canvas's backing-store size by
  // hand (169): three in PdfViewer (two writes and the prefetch cache size
  // check) and one in the continuous column. If the check and the writes ever
  // disagree, every warm bitmap misses and the reader silently rerenders.
  // One function is only safe if it answers both old expressions exactly.
  {
    const oldRatio = (raw: number): number => raw || 1
    const ratios = [0, 1, 1.25, 1.5, 2, 3, -1, NaN, Infinity, -Infinity, 0.5, 1e-9]
    const ratioDrift = ratios.filter(
      (r) => !Object.is(oldRatio(r), devicePixelRatioOrOne(r))
    )
    expect(
      'the named pixel-ratio fallback answers the old expression for every input',
      ratios.length === 12 &&
        ratioDrift.length === 0 &&
        devicePixelRatioOrOne(0) === 1 &&
        devicePixelRatioOrOne(NaN) === 1,
      { checked: ratios.length, drift: ratioDrift }
    )

    const widths = [0, 1, 100.9, 612, 792.5, 0.1, -5, NaN, Infinity, 1e6]
    const heights = [0, 1, 100.9, 612, 792.5, 0.1, -5, NaN, Infinity, 1e6]
    const dprs = [1, 1.25, 1.5, 2, 3, 0, -1, NaN, Infinity]
    const oldSize = (w: number, h: number, d: number) => ({
      width: Math.floor(w * d),
      height: Math.floor(h * d)
    })
    let sizeChecked = 0
    const sizeDrift: string[] = []
    for (const w of widths)
      for (const h of heights)
        for (const d of dprs) {
          sizeChecked += 1
          const a = oldSize(w, h, d)
          const b = bitmapPixelSize({ width: w, height: h }, d)
          if (!Object.is(a.width, b.width) || !Object.is(a.height, b.height))
            sizeDrift.push(`${w},${h},${d}`)
        }
    expect(
      'the shared bitmap size answers both old floor expressions for every sampled input',
      sizeChecked === widths.length * heights.length * dprs.length &&
        sizeChecked >= 500 &&
        sizeDrift.length === 0,
      { checked: sizeChecked, drift: sizeDrift.slice(0, 5) }
    )

    let wrongDrift = 0
    for (const w of widths)
      for (const h of heights)
        for (const d of dprs) {
          const a = oldSize(w, h, d)
          const b = { width: Math.round(w * d), height: Math.round(h * d) }
          if (!Object.is(a.width, b.width) || !Object.is(a.height, b.height))
            wrongDrift += 1
        }
    expect(
      'a rule that rounds instead of truncating really would be caught',
      wrongDrift > 0,
      { wrongDrift, checked: sizeChecked }
    )

    const trunc = bitmapPixelSize({ width: 100.9, height: 200.9 }, 1.25)
    expect(
      'the shared rule truncates down instead of rounding up',
      trunc.width === 126 &&
        trunc.height === 251 &&
        bitmapPixelSize({ width: 0, height: 0 }, 1).width === 0,
      { trunc }
    )

    expect(
      'the shared rule does not quietly sanitise non-finite or negative sizes',
      Number.isNaN(bitmapPixelSize({ width: NaN, height: 1 }, 2).width) &&
        bitmapPixelSize({ width: -5, height: 1 }, 2).width === -10 &&
        bitmapPixelSize({ width: Infinity, height: 1 }, 2).width === Infinity,
      {
        nan: bitmapPixelSize({ width: NaN, height: 1 }, 2).width,
        negative: bitmapPixelSize({ width: -5, height: 1 }, 2).width
      }
    )

    // Values alone do not prove the wiring, and a "nothing left" assertion
    // looks exactly like a pass when its detector is broken.
    const sites = [
      {
        file: 'src/components/PdfViewer.tsx',
        sizeCalls: 2, // renderTo + single-page render
        ratioCalls: 3 // renderTo + warm + render
      },
      {
        file: 'src/lib/hooks/useContinuousPages.ts',
        sizeCalls: 1, // paintPage
        ratioCalls: 1 // paintPage
      }
    ]
    const root = path.join(__dirname, '../..')
    const reads = sites.map((s) => {
      const f = path.join(root, s.file)
      return { file: s.file, text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null }
    })
    expect(
      'both bitmap call-site files can be read from this checkout',
      reads.every((r) => r.text !== null),
      { missing: reads.filter((r) => r.text === null).map((r) => r.file) }
    )

    // Count call sites, not bare name occurrences: the import path contains
    // the module name too, so a name-only count would be two higher.
    const calls = (t: string, name: string) =>
      (t.match(new RegExp('\\b' + name + '\\s*\\(', 'g')) ?? []).length
    const notWired = reads.flatMap((r, i) => {
      const t = r.text ?? ''
      const bad: string[] = []
      if (!/from '[^']*bitmapPixelSize'/.test(t))
        bad.push(sites[i].file + ': no shared-rule import')
      const size = calls(t, 'bitmapPixelSize')
      const ratio = calls(t, 'devicePixelRatioOrOne')
      if (size !== sites[i].sizeCalls)
        bad.push(sites[i].file + ': size rule called ' + size + ' times')
      if (ratio !== sites[i].ratioCalls)
        bad.push(sites[i].file + ': ratio rule called ' + ratio + ' times')
      return bad
    })
    expect(
      'all four compute sites call the shared size rule and no site reads dpr by hand',
      notWired.length === 0,
      { notWired }
    )

    const oldFragments = [
      'Math.floor(viewport.width * dpr)',
      'Math.floor(viewport.height * dpr)',
      'window.devicePixelRatio || 1'
    ]
    const detector = (t: string) =>
      oldFragments.filter((o) => t.includes(o)).length
        ? oldFragments.flatMap((o) => {
            const n = t.split(o).length - 1
            return Array.from({ length: n }, () => o)
          })
        : []
    const leftovers = reads.flatMap((r) =>
      detector(r.text ?? '').map((o) => r.file + ': ' + o)
    )
    expect(
      'no hand-written floor expression or raw dpr fallback is left at any call site',
      leftovers.length === 0,
      { leftovers }
    )

    const legacyText = [
      'canvas.width = Math.floor(viewport.width * dpr)',
      'canvas.height = Math.floor(viewport.height * dpr)',
      'c.width === Math.floor(viewport.width * dpr) &&',
      'c.height === Math.floor(viewport.height * dpr)',
      'canvas.width = Math.floor(viewport.width * dpr)',
      'canvas.height = Math.floor(viewport.height * dpr)',
      'canvas.width = Math.floor(viewport.width * dpr)',
      'canvas.height = Math.floor(viewport.height * dpr)',
      'const dpr = window.devicePixelRatio || 1',
      'const dpr = window.devicePixelRatio || 1',
      'const dpr = window.devicePixelRatio || 1',
      'const dpr = window.devicePixelRatio || 1'
    ].join('\n')
    expect(
      'the leftover detector really sees the twelve old lines',
      detector(legacyText).length === 12,
      { caught: detector(legacyText).length }
    )

    // The plan listed five sites. The fifth, `canvas.width = bmp.width`,
    // copies dimensions from an already-rendered bitmap instead of computing
    // them from a viewport; folding it into this rule would change what it
    // means. Prove it was deliberately left as it was.
    const viewer = reads[0].text ?? ''
    expect(
      'the cached-bitmap dimension copy is deliberately left alone',
      viewer.includes('canvas.width = bmp.width') &&
        viewer.includes('canvas.height = bmp.height') &&
        !viewer.includes('bmp.width = bitmapPixelSize'),
      { copyKept: viewer.includes('canvas.width = bmp.width') }
    )
  }


  // Twelve empty catches used to hide twelve different decisions (165). An
  // empty catch says nothing: it cannot be told apart from a mistake, nobody
  // can say why the failure was acceptable, and there is no way to ask later
  // whether it ever happened. The split is a decision, not a mechanical
  // rewrite -- cleanup and optional startup reads are expected to fail, while
  // a side effect of something the reader did deserves a visible line.
  {
    const reasons = Object.values(FAILURE)
    expect(
      'the failure reasons are a fixed named set with no invented ones',
      reasons.length === 12 &&
        new Set(reasons).size === reasons.length &&
        reasons.every((r) => typeof r === 'string' && r.length > 0),
      { count: reasons.length, reasons }
    )
    expect(
      'no failure reason can be mistaken for a renderer error',
      reasons.every((r) => !/error/i.test(r)),
      { matching: reasons.filter((r) => /error/i.test(r)) }
    )

    const seen: { reason: string; kind: string }[] = []
    resetFailureCounts()
    setFailureSink((reason, kind) => seen.push({ reason, kind }))
    ignoreFailure(FAILURE.appVersionCosmetic, new Error('cosmetic'))
    const afterIgnore = failureCounts()
    expect(
      'an ignored failure is counted but never reported',
      afterIgnore[FAILURE.appVersionCosmetic]?.ignored === 1 &&
        afterIgnore[FAILURE.appVersionCosmetic]?.reported === 0 &&
        seen.length === 0,
      { afterIgnore, seen }
    )

    reportFailure(FAILURE.readingPosition, new Error('disk is full'))
    const afterReport = failureCounts()
    expect(
      'a reported failure reaches the sink and is counted',
      seen.length === 1 &&
        seen[0].reason === FAILURE.readingPosition &&
        seen[0].kind === 'reported' &&
        afterReport[FAILURE.readingPosition]?.reported === 1,
      { seen, afterReport }
    )

    // The default line is the one deliberately observable change. It must not
    // contain the word the smoke run collects as a renderer error.
    const originalWarn = console.warn
    const warned: string[] = []
    setFailureSink(null)
    console.warn = (...args: Parameters<typeof console.warn>) => {
      warned.push(args.map(String).join(' '))
    }
    let defaultOk = false
    try {
      reportFailure(FAILURE.continuousPreference)
      defaultOk =
        warned.length === 1 &&
        warned[0] === '[mendeley-ng] ' + FAILURE.continuousPreference &&
        !/error/i.test(warned[0])
    } finally {
      console.warn = originalWarn
      setFailureSink(null)
    }
    expect(
      'the default line names the failure without shouting error',
      defaultOk,
      { warned }
    )

    const snapshot = failureCounts()
    ignoreFailure(FAILURE.workerCleanup)
    expect(
      'failureCounts is a snapshot, not a live view',
      snapshot[FAILURE.workerCleanup] === undefined &&
        (failureCounts()[FAILURE.workerCleanup]?.ignored ?? 0) === 1,
      { snapshot }
    )
    resetFailureCounts()
    expect(
      'resetFailureCounts clears both tallies',
      Object.keys(failureCounts()).length === 0,
      { after: failureCounts() }
    )

    // Value checks cannot prove the call sites were wired (164). Read back
    // the five product files and count the named doors actually used; the
    // twelfth site lives in this file and is checked separately.
    const failureFiles = [
      'src/App.tsx',
      'src/components/PdfViewer.tsx',
      'src/lib/hooks/useLibrary.ts',
      'src/lib/hooks/usePdfAnnotations.ts',
      'electron/main/fulltext.ts'
    ]
    const root = path.join(__dirname, '../..')
    const texts: Record<string, string | null> = {}
    for (const f of failureFiles) {
      const full = path.join(root, f)
      texts[f] = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
    }
    expect(
      'the five product files can be read from this checkout',
      failureFiles.every((f) => texts[f] !== null),
      { missing: failureFiles.filter((f) => texts[f] === null) }
    )

    const body = failureFiles.map((f) => texts[f] ?? '').join('\n')
    const swallowed = body.match(/catch\(\(\) => \{\}\)/g) ?? []
    const ignores = [...body.matchAll(/ignoreFailure\(FAILURE\.([A-Za-z]+)/g)].map((m) => m[1])
    const reports = [...body.matchAll(/reportFailure\(FAILURE\.([A-Za-z]+)/g)].map((m) => m[1])
    expect(
      'all twelve product catches go through a named door',
      swallowed.length === 0 && ignores.length === 6 && reports.length === 6,
      { swallowed: swallowed.length, ignores, reports }
    )

    const IGNORE_KEYS = [
      'notesOptional',
      'annotationCacheOptional',
      'appVersionCosmetic',
      'workerCleanupTimedOut',
      'workerCleanup',
      'startupAnnotationSync',
      'testPdfCleanup'
    ]
    const REPORT_KEYS = [
      'undoFolderRemove',
      'undoFolderAdd',
      'cloudHighlightRemoval',
      'continuousPreference',
      'readingPosition'
    ]
    expect(
      'the ignore/report split follows the agreed strategy',
      ignores.every((k) => IGNORE_KEYS.includes(k)) &&
        reports.every((k) => REPORT_KEYS.includes(k)),
      { ignores, reports }
    )

    const thisFile = fs.readFileSync(path.join(root, 'electron/main/smoke.ts'), 'utf8')
    const allText = body + '\n' + thisFile
    expect(
      'every named reason is used and the test cleanup is wired',
      reasons.every((r) => {
        const key = Object.keys(FAILURE).find(
          (k) => FAILURE[k as keyof typeof FAILURE] === r
        )
        return !!key && allText.includes('FAILURE.' + key)
      }) &&
        /ignoreFailure\(FAILURE\.testPdfCleanup/.test(thisFile) &&
        (thisFile.match(/catch\(\(\) => \{\}\)/g) ?? []).length === 0,
      { reasons: reasons.length }
    )
  }


  // Six bare clamps (166). The old expressions are copied verbatim below so
  // the shared rule can be compared value by value, including non-finite
  // input. Two of them put Math.max on the outside, which agrees with
  // Math.min(max, Math.max(min, v)) only while min <= max: that inequality
  // is checked, not assumed.
  {
    const oldStep = (from: number, delta: number, len: number): number =>
      Math.min(len - 1, Math.max(0, from + delta))
    const oldAt = (want: number, numPages: number): number =>
      Math.min(Math.max(1, want), numPages)
    const oldGo = (n: number, numPages: number): number =>
      Math.min(Math.max(1, n), numPages || 1)
    const oldCol = (w: number, min: number): number =>
      Math.round(Math.max(min, Math.min(1000, w)))
    const oldFont = (cur: number, d: number): number =>
      Math.min(24, Math.max(11, cur + d))
    const oldLanes = (cpus: number): number =>
      Math.max(1, Math.min(4, cpus - 1))
    const oldClampNum = (v: number, lo: number, hi: number): number =>
      Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo

    const special: number[] = [NaN, Infinity, -Infinity, -0.5, 0, 0.5, 1.9, 999.9]
    const values: number[] = []
    for (let v = -60; v <= 110; v += 1) values.push(v)
    values.push(...special)

    const stepDrift: string[] = []
    let stepChecked = 0
    for (let len = 1; len <= 24; len += 1) {
      for (let from = -3; from <= len + 2; from += 1) {
        for (let delta = -3; delta <= 3; delta += 1) {
          const old = oldStep(from, delta, len)
          const now = clampToRange(from + delta, 0, len - 1)
          stepChecked += 1
          if (!Object.is(old, now)) stepDrift.push(`${len}/${from}/${delta}`)
        }
      }
    }
    expect(
      'the shared clamp answers the old row-step clamp for every sampled input',
      stepChecked === 3108 && stepDrift.length === 0,
      { stepChecked, stepDrift: stepDrift.slice(0, 5) }
    )

    const pageDrift: string[] = []
    let pageChecked = 0
    for (const v of values) {
      for (let pages = 0; pages <= 24; pages += 1) {
        const oldOpen = oldAt(v, pages)
        const nowOpen = clampToRange(v, 1, pages)
        const oldGoTo = oldGo(v, pages)
        const nowGoTo = clampToRange(v, 1, pages || 1)
        pageChecked += 2
        if (!Object.is(oldOpen, nowOpen)) pageDrift.push(`open/${v}/${pages}`)
        if (!Object.is(oldGoTo, nowGoTo)) pageDrift.push(`go/${v}/${pages}`)
      }
    }
    expect(
      'the shared clamp answers both old page clamps for every sampled input',
      pageChecked > 4000 && pageDrift.length === 0,
      { pageChecked, pageDrift: pageDrift.slice(0, 5) }
    )

    const colDrift: string[] = []
    let colChecked = 0
    for (const v of values) {
      for (const floor of [24, 26, 48]) {
        const old = oldCol(v, floor)
        const now = Math.round(clampToRange(v, floor, 1000))
        colChecked += 1
        if (!Object.is(old, now)) colDrift.push(`${v}/${floor}`)
      }
    }
    expect(
      'the shared clamp answers the old column-width clamp for every sampled input',
      colChecked === values.length * 3 && colDrift.length === 0,
      { colChecked, colDrift: colDrift.slice(0, 5) }
    )

    const fontDrift: string[] = []
    let fontChecked = 0
    for (const cur of values) {
      for (let d = -20; d <= 20; d += 1) {
        const old = oldFont(cur, d)
        const now = clampToRange(cur + d, 11, 24)
        fontChecked += 1
        if (!Object.is(old, now)) fontDrift.push(`${cur}/${d}`)
      }
    }
    expect(
      'the shared clamp answers the old font-size clamp for every sampled input',
      fontChecked > 7000 && fontDrift.length === 0,
      { fontChecked, fontDrift: fontDrift.slice(0, 5) }
    )

    const laneDrift: string[] = []
    let laneChecked = 0
    for (let cpus = 0; cpus <= 64; cpus += 1) {
      const old = oldLanes(cpus)
      const now = clampToRange(cpus - 1, 1, 4)
      laneChecked += 1
      if (!Object.is(old, now)) laneDrift.push(String(cpus))
    }
    for (const cpus of [NaN, Infinity, -Infinity]) {
      const old = oldLanes(cpus)
      const now = clampToRange(cpus - 1, 1, 4)
      laneChecked += 1
      if (!Object.is(old, now)) laneDrift.push(String(cpus))
    }
    expect(
      'the shared clamp answers the old lane count for every cpu count',
      laneChecked === 68 && laneDrift.length === 0,
      { laneChecked, laneDrift }
    )

    // The existing named clamp could not have been reused: it answers non-
    // finite input with the lower bound, which these six sites never did.
    expect(
      'clampNum really cannot stand in for these six expressions',
      oldClampNum(NaN, 1, 4) === 1 &&
        Number.isNaN(clampToRange(NaN, 1, 4)) &&
        oldClampNum(Infinity, 1, 4) === 1 &&
        clampToRange(Infinity, 1, 4) === 4,
      {
        oldNaN: oldClampNum(NaN, 1, 4),
        newNaN: String(clampToRange(NaN, 1, 4)),
        oldInf: oldClampNum(Infinity, 1, 4),
        newInf: clampToRange(Infinity, 1, 4)
      }
    )

    // Two old expressions put Math.max on the outside. They agree with the
    // shared rule only while min <= max; prove the split is real, then prove
    // every real column floor is on the safe side of it.
    const root = path.join(__dirname, '../..')
    const colSrc = fs.readFileSync(path.join(root, 'src/lib/columns.ts'), 'utf8')
    const floors = [...colSrc.matchAll(/min:\s*(\d+)/g)].map((m) => Number(m[1]))
    const minPx = Number((colSrc.match(/MIN_PX\s*=\s*(\d+)/) ?? [])[1])
    const maxPx = Number((colSrc.match(/MAX_PX\s*=\s*(\d+)/) ?? [])[1])
    expect(
      'the max-outside form really diverges when the floor exceeds the ceiling',
      oldCol(20, 1200) === 1200 && clampToRange(20, 1200, 1000) === 1000,
      { old: oldCol(20, 1200), shared: clampToRange(20, 1200, 1000) }
    )
    expect(
      'every real column floor stays below the shared ceiling',
      floors.length >= 2 &&
        [...floors, minPx].every((v) => Number.isInteger(v) && v > 0 && v <= maxPx),
      { floors, minPx, maxPx }
    )

    const clampFiles = [
      'src/App.tsx',
      'src/components/PdfViewer.tsx',
      'src/lib/columns.ts',
      'src/lib/hooks/useConfig.ts',
      'electron/main/fulltext.ts'
    ]
    const joined = clampFiles
      .map((f) => {
        const full = path.join(root, f)
        return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : ''
      })
      .join('\n')
    const uses = (joined.match(/clampToRange\(/g) ?? []).length
    const leftoverBare = [
      /Math\.min\(filtered\.length - 1, Math\.max\(0, from \+ delta\)\)/,
      /Math\.min\(Math\.max\(1, want\), numPages\)/,
      /Math\.min\(Math\.max\(1, n\), numPages \|\| 1\)/,
      /Math\.round\(Math\.max\(def\.min \?\? MIN_PX, Math\.min\(MAX_PX, w\)\)\)/,
      /Math\.min\(24, Math\.max\(11, fontRef\.current \+ d\)\)/,
      /Math\.max\(1, Math\.min\(4, \(os\.cpus\(\)\?\.length \?\? 4\) - 1\)\)/
    ].filter((r) => r.test(joined)).length
    expect(
      'all six call sites use the shared clamp with their old bounds',
      uses === 6 && leftoverBare === 0 && joined.length > 0,
      { uses, leftoverBare }
    )

    // 161 left two verbatim copies of the old page-budget rule here as its
    // control. Rewiring them into the shared clamp would destroy the evidence.
    const smokeSrc = fs.readFileSync(path.join(root, 'electron/main/smoke.ts'), 'utf8')
    const controls = (smokeSrc.match(/Math\.max\(1, Math\.min\(50, Math\.floor/g) ?? []).length
    expect(
      'the 161 control copies stay bare so the old rule remains comparable',
      controls === 2,
      { controls }
    )
  }

  // The way out as one action.  Four exports the reader has to know about and
  // run one after another is not an answer to "can I leave", so the folder
  // gets a note on top naming what is in it — including the two kinds nothing
  // else will import, which a folder that pretended otherwise would have the
  // reader discover after the old library was gone.
  const exitReadme = toExitReadme({ docs: 12, notes: 3, anns: 5, pdfs: 7 })
  log('exit readme', exitReadme)
  expect(
    'a folder holding everything says what is in it',
    /BibTeX/.test(exitReadme) &&
      /RIS/.test(exitReadme) &&
      /notes\.md/.test(exitReadme) &&
      /annotations\.md/.test(exitReadme) &&
      /pdf\//.test(exitReadme),
    exitReadme.slice(0, 220)
  )
  expect(
    'and it says out loud which two things nothing else will import',
    /没有导入格式/.test(exitReadme),
    exitReadme.slice(0, 400)
  )
  const thinReadme = toExitReadme({ docs: 12, notes: 0, anns: 0, pdfs: 0 })
  expect(
    'what was not taken is not listed as if it had been',
    !/pdf\//.test(thinReadme) && !/notes\.md/.test(thinReadme),
    thinReadme.slice(0, 300)
  )
  expect(
    'and the size is said the way a reader says it',
    humanBytes(29_400_000_000) === '29.4 GB' && humanBytes(4_200_000) === '4 MB',
    [humanBytes(29_400_000_000), humanBytes(4_200_000)]
  )

  // The same, driven through the real IPC into a scratch folder with a file of
  // its own.  The reader's own PDFs are tens of gigabytes; a smoke run that
  // copied those would not be a smoke run.
  const stamp = Date.now()
  const leaveDir = path.join(app.getPath('temp'), `mendeley-ng-leave-${stamp}`)
  const fakePdf = path.join(app.getPath('temp'), `mendeley-ng-leave-${stamp}.pdf`)
  fs.writeFileSync(fakePdf, Buffer.alloc(2048, 0x20))
  const leavePlan = JSON.parse(
    await w.webContents.executeJavaScript(
      `(async()=>{const p=await window.api.pdfPlan(${JSON.stringify([
        fakePdf,
        fakePdf,
        fakePdf + '.nope'
      ])});return JSON.stringify(p)})()`
    )
  ) as { copies: { from: string; to: string }[]; bytes: number }
  log('pdf plan', leavePlan)
  // the third path does not exist, so it must not be promised or counted
  expect(
    'what copying the PDFs would cost is known before anything is copied',
    leavePlan.copies.length === 2 && leavePlan.bytes === 4096,
    leavePlan
  )
  expect(
    'two papers that own the same filename do not overwrite each other',
    leavePlan.copies[0].to !== leavePlan.copies[1].to,
    leavePlan.copies
  )
  const leaveRes = JSON.parse(
    await w.webContents.executeJavaScript(
      `(async()=>{const r=await window.api.leaveLibrary(${JSON.stringify(leaveDir)},`
        + `[{name:"README.txt",text:"hello"}],${JSON.stringify(leavePlan.copies)});`
        + `return JSON.stringify(r)})()`
    )
  ) as { dir?: string; files?: string[]; copied?: number; failed?: unknown[]; bytes?: number }
  log('leave', leaveRes)
  const leftFile = fs.existsSync(path.join(leaveDir, 'README.txt'))
    ? fs.readFileSync(path.join(leaveDir, 'README.txt'), 'utf8')
    : ''
  expect(
    'the whole library lands in the folder the reader chose',
    leftFile === 'hello' && leaveRes.files?.length === 1,
    { leaveRes, landed: leftFile }
  )
  expect(
    'and the PDFs come with it',
    leavePlan.copies.every((c) => fs.existsSync(path.join(leaveDir, c.to))),
    leaveRes
  )
  expect('nothing was lost on the way', (leaveRes.failed ?? []).length === 0, leaveRes)
  fs.rmSync(leaveDir, { recursive: true, force: true })
  fs.rmSync(fakePdf, { force: true })

  // Both ways out have to be *offered*, not merely to exist as functions.  A
  // menu item that appears only once there is already something to carry is
  // no comfort to somebody deciding whether to write in here at all — and a
  // greyed-out one that does not say why looks like a broken button.
  log('open 导出', await openMenu('导出'))
  await new Promise((r) => setTimeout(r, 300))
  const exportItems = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify([...document.querySelectorAll(".menu-pop .menu-item")]'
        + '.map(x=>({t:x.textContent.trim(),off:x.disabled,why:x.title})))'
    )
  ) as { t: string; off: boolean; why: string }[]
  log('export menu', exportItems)
  expect(
    'both kinds of local reading are offered a way out',
    exportItems.some((i) => /笔记/.test(i.t)) && exportItems.some((i) => /标注/.test(i.t)),
    exportItems
  )
  expect(
    'and so is the whole library in one go',
    exportItems.some((i) => /带走/.test(i.t)),
    exportItems
  )
  expect(
    'and whichever is greyed out says why',
    exportItems.filter((i) => i.off).every((i) => (i.why ?? '').length > 0),
    exportItems
  )
  log('close 导出', await openMenu('导出'))
  await new Promise((r) => setTimeout(r, 200))

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

  // Emptying the search box, and waiting for the table to come back.  Used
  // wherever a check narrows the list to reach one paper and then has to read
  // that paper back off the table: with a word in the box the middle pane is
  // result cards and not rows, so a row cannot be read back from a pane that
  // is not showing rows.  The run also goes on from here with the whole
  // library in front of it — a box left holding one paper's title would take
  // that away from everything that follows.
  const clearSearch = async () => {
    await w.webContents.executeJavaScript(
      `(()=>{const i=document.querySelector(".toolbar input[placeholder^='搜索']");if(!i)return 0;`
        + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
        + `set.call(i,"");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
    await new Promise((r) => setTimeout(r, 1200))
  }
  // Typing into a box the way a reader does.  React keeps its own value on
  // the element, so setting `.value` alone is invisible to it and the change
  // never happens: the native setter has to be called and the input event
  // dispatched, which is what a keystroke does.
  const setInput = (sel: string, v: string) =>
    w.webContents.executeJavaScript(
      `(()=>{const i=document.querySelector(${JSON.stringify(sel)});if(!i)return 0;`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
      + `set.call(i,${JSON.stringify(v)});`
      + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )

  // Links inside a paper.  A reference list is only worth having if a
  // citation can be followed and a DOI in the margin only if it can be
  // opened, so the run presses one of each kind and checks where it ended
  // up.  The two end in different places and that is the whole point: a
  // destination inside the paper turns the page, an address outside it is
  // handed to the shell and nothing else in the app moves.
  //
  // Which paper carries links is a property of the library, not of the run,
  // so it is asked for rather than written down: a title hard-coded here
  // would only be true on the machine it was taken from.  pdf.js is already
  // loaded in this process for the full-text index, so the papers can be
  // asked without putting them on screen.
  let linkInfo: {
    ok?: boolean
    skip?: string
    title?: string
    /** Which paper was scanned, and which one the reader ended up on.  They
     *  are both recorded because a check about links is only a check about
     *  this paper when they are the same paper. */
    want?: string
    card?: string
    at?: string
    anchors?: number
    pageFrom?: number
    pageTo?: number
    extPage?: number | null
    opened?: string[]
  } = {}
  const wantLinks = await (async () => {
    const cands = (loadLibrary()?.docs ?? []).filter(
      (d) => d.localPdf && fs.existsSync(d.localPdf as string)
    )
    for (const d of cands.slice(0, 60)) {
      try {
        const data = new Uint8Array(fs.readFileSync(d.localPdf as string))
        const pdf = await pdfjs.getDocument({ data, useSystemFonts: false }).promise
        const last = Math.min(pdf.numPages, 12)
        let inner = 0
        let extPage: number | null = null
        for (let i = 1; i <= last; i++) {
          const p = await pdf.getPage(i)
          const anns = (await p.getAnnotations({ intent: 'display' })) as unknown as {
            subtype?: string
            url?: string
            unsafeUrl?: string
            dest?: unknown
          }[]
          for (const a of anns) {
            if (a.subtype !== 'Link') continue
            if (i === 1 && a.dest != null && !(a.url ?? a.unsafeUrl)) inner++
            if (extPage === null && (a.url ?? a.unsafeUrl)) extPage = i
          }
          if (extPage !== null && inner) break
        }
        await pdf.destroy()
        // page one is what the reader lands on, so a link there is what can be
        // pressed without hunting for it
        if (inner >= 1) return { doc: d, extPage }
      } catch {
        /* a paper that will not parse simply has no links to offer */
      }
    }
    return undefined
  })()

  if (!wantLinks) {
    linkInfo = { skip: 'no paper in this library carries a link on its first page' }
  } else {
    const title = String(wantLinks.doc.title ?? '').slice(0, 40)
    // The table only draws the rows it can see, so a paper that is not on
    // screen cannot be clicked; narrowing the list to it is the way in.
    //
    // And the way in used to be "click the first row with a PDF dot", which
    // is a row that does not exist: with a word in the search box the middle
    // pane is result cards.  Nothing was clicked, so what was read was
    // whichever paper was already open — and "a page with links on it" is
    // true of a great many papers, so the check passed on whichever one it
    // happened to be looking at.  What was scanned is named by its own id
    // now, and what ended up under the reader is read back before anything is
    // pressed.
    await w.webContents.executeJavaScript(
      `(()=>{const i=document.querySelector(".toolbar input[placeholder^='搜索']");if(!i)return 0;`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
      + `set.call(i,${JSON.stringify(title)});`
      + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
    await new Promise((r) => setTimeout(r, 1500))
    const linkCard = String(
      await until(
        `(document.querySelectorAll('div.res-row[data-id=${JSON.stringify(wantLinks.doc.id)}]').length?'yes':'no')`,
        (v) => v === 'yes',
        6000
      )
    )
    await w.webContents.executeJavaScript(
      `(()=>{const r=document.querySelector('div.res-row[data-id=${JSON.stringify(wantLinks.doc.id)}]');`
      + `if(!r)return 0;r.click();return 1})()`
    )
    await new Promise((r) => setTimeout(r, 5000))
    await clearSearch()
    const linkAt = String(
      await w.webContents.executeJavaScript(
        '(()=>{const r=document.querySelector("div.row.sel");return r?r.dataset.id||"":""})()'
      )
    )
    // reopening a paper opens where it was left, and the links are read for
    // the page being read
    await paneKey('Home')
    await new Promise((r) => setTimeout(r, 1200))
    const onTheScannedOne = linkCard === 'yes' && linkAt === wantLinks.doc.id
    // A press that landed somewhere else is not evidence about this paper at
    // all, so the rest is not run rather than answered about a different one:
    // it says so instead, and loudly, because a check that quietly did not
    // happen is the one that cannot be told apart from a check that passed.
    if (!onTheScannedOne) {
      linkInfo = {
        skip: 'the press did not land on the paper that was scanned',
        want: wantLinks.doc.id,
        card: linkCard,
        at: linkAt,
        title
      }
      expect('the links are read off the paper that was scanned', false, linkInfo)
    }
    if (onTheScannedOne) {
      const seen = JSON.parse(
        await w.webContents.executeJavaScript(
          '(()=>{const a=[...document.querySelectorAll("a.pdf-link")];'
          + 'return JSON.stringify({n:a.length,'
          + 'ext:a.filter(x=>x.classList.contains("ext")).length,'
          + 'href:(a.find(x=>x.classList.contains("ext"))||{}).href||null,'
          + 'marked:a.length?getComputedStyle(a[0]).pointerEvents:null})})()'
        )
      )
      log('links on the page', seen)
      expect(
        'a paper that carries links gets a link to press',
        seen.n >= 1 && seen.marked === 'auto',
        seen
      )
      // an internal link is pressed only if it points somewhere else: a link to
      // the page it is on turning the page to the page it is on proves nothing
      const pageFrom = await pageNow()
      const pressed = Number(
        await w.webContents.executeJavaScript(
          '(()=>{const cur=Number((document.querySelector(".pdf-bar input")||{}).value||0);'
          + 'const a=[...document.querySelectorAll("a.pdf-link")]'
          + '.filter(x=>!x.classList.contains("ext"))'
          + '.find(x=>{const m=(x.getAttribute("href")||"").match(/^#page-(\\d+)$/);'
          + 'return m&&Number(m[1])!==cur});'
          + 'if(!a)return 0;a.click();return 1})()'
        )
      )
      await new Promise((r) => setTimeout(r, 1200))
      const pageTo = await pageNow()
      log('internal link', { pressed, pageFrom, pageTo })
      expect(
        'pressing a link inside the paper turns to the page it points at',
        pressed === 1 && pageTo !== pageFrom,
        { pressed, pageFrom, pageTo }
      )
      // An external link has to reach the shell and nowhere else.  The channel
      // is taken over for the press, because a smoke run that really opened the
      // browser on the user's desktop would be a worse bug than the one being
      // looked for; what is checked is that the address arrives intact.
      const opened: string[] = []
      ipcMain.removeHandler('shell:openExternal')
      ipcMain.handle('shell:openExternal', (_e, url: string) => {
        opened.push(url)
        return { ok: true }
      })
      try {
        if (wantLinks.extPage !== null) {
          await w.webContents.executeJavaScript(
            `(()=>{const i=document.querySelector(".pdf-bar input");if(!i)return 0;`
            + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
            + `set.call(i,${JSON.stringify(String(wantLinks.extPage))});`
            + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
          )
          await new Promise((r) => setTimeout(r, 2500))
        }
        const extPressed = Number(
          await w.webContents.executeJavaScript(
            // one that is not marked as already on the shelf: those are answered
            // here now, and pressing one would prove nothing about the browser
            '(()=>{const a=document.querySelector("a.pdf-link.ext:not(.own)");if(!a)return 0;'
            + 'a.click();return 1})()'
          )
        )
        await new Promise((r) => setTimeout(r, 800))
        log('external link', { extPage: wantLinks.extPage, extPressed, opened })
        if (wantLinks.extPage === null) {
          log('no external link in this paper, press not checked')
        } else {
          expect(
            'a link out of the paper reaches the shell and nothing else',
            extPressed === 1 && opened.length === 1 && /^https?:\/\//.test(opened[0] ?? ''),
            { extPage: wantLinks.extPage, extPressed, opened }
          )
        }
      } finally {
        ipcMain.removeHandler('shell:openExternal')
        ipcMain.handle('shell:openExternal', (_e, url: string) => {
          shell.openExternal(url)
          return { ok: true }
        })
      }
      linkInfo = { ok: true, title, anchors: seen.n, pageFrom, pageTo, opened }
    }
    // back to the whole library: what follows looks at the rows near the top
    await w.webContents.executeJavaScript(
      `(()=>{const i=document.querySelector(".toolbar input[placeholder^='搜索']");if(!i)return 0;`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
      + `set.call(i,"");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
    await new Promise((r) => setTimeout(r, 1000))
    await w.webContents.executeJavaScript(
      '(()=>{const s=document.querySelector(".table-wrap");if(s)s.scrollTop=0;'
      + 'const r=[...document.querySelectorAll("div.row")]'
      + '.filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));if(r.length)r[0].click();return 1})()'
    )
    await new Promise((r) => setTimeout(r, 1500))
  }
  log('links in a paper', linkInfo)

  // A citation in the body, answered where the reader is.
  //
  // Meeting "[3]" in a paper means going to the end, counting to the third
  // entry, holding it in mind and coming back.  This is the most frequent
  // interruption in reading a paper, and the answer to it is only worth
  // having if it is right: a popover naming the wrong paper sends the reader
  // to a paper they did not ask about, with no reason to doubt it.  So what
  // is checked is not that a popover appears but that the entry in it is one
  // of the entries the paper actually printed.
  const citeRules = {
    // an appendix numbering its steps also opens its lines with `1.`
    appendix: parseRefEntries([
      '1. Take the first step.',
      '2. Then take the second one.',
      '3. And the third.'
    ]).size,
    // a range this long is a review's way of saying "many"; it is not
    // something to put under the pointer
    longRange: citeNums('[1-40]'),
    // and two entries are not enough to believe a list was found at all
    short: parseRefEntries([
      '[1] A. Author. A paper. 2020.',
      '[2] B. Author. Another paper. 2021.'
    ]).size,
    byDoi:
      docForRef(
        idIndex([
          { id: 'a', doi: '10.1000/xyz' } as Doc,
          { id: 'b', doi: '10.2000/other' } as Doc
        ]),
        'A. Author. A paper. Journal, 2020. doi:10.1000/xyz.'
      )?.id ?? null,
    // an entry carrying no identifier is not matched to anything: guessing
    // from a title is how the wrong paper gets opened
    noId:
      docForRef(
        idIndex([{ id: 'a', doi: '10.1000/xyz' } as Doc]),
        'A. Author. A paper. 2020.'
      ) ?? null
  }
  expect('an appendix numbering its steps is not read as a reference list', citeRules.appendix === 0, citeRules)
  expect('a range of forty is not put under the pointer', citeRules.longRange === null, citeRules)
  expect('two entries are not enough to believe a list', citeRules.short === 0, citeRules)
  expect('a reference is matched to the library by its DOI', citeRules.byDoi === 'a', citeRules)
  expect('a reference with no identifier is matched to nothing', citeRules.noId === null, citeRules)

  // A link out of a paper, and whether the paper it points at is already on
  // the shelf.  Answered from the identifier the link carries and from
  // nothing else, for the reason a reference is: guessing from a title is
  // how the wrong paper gets opened.  A link that cannot be pinned down is
  // left to the browser, which is both what it did before and what the
  // reader wants when the answer really is somewhere else.
  const linkRules = {
    byDoi:
      docForUrl(
        idIndex([{ id: 'a', doi: '10.1000/xyz' } as Doc]),
        'https://doi.org/10.1000/xyz'
      )?.id ?? null,
    other: docForUrl(
      idIndex([{ id: 'a', doi: '10.1000/xyz' } as Doc]),
      'https://doi.org/10.9999/nope'
    ),
    byArxiv:
      docForUrl(
        idIndex([{ id: 'b', arxiv: '2401.01234' } as Doc]),
        'https://arxiv.org/abs/2401.01234'
      )?.id ?? null,
    // what follows a link is not part of the identifier: a link that came out
    // of somebody else's reference manager carries a query, and `?ref=1` is
    // not the tail of a DOI
    query:
      docForUrl(
        idIndex([{ id: 'a', doi: '10.1000/xyz' } as Doc]),
        'https://doi.org/10.1000/xyz?ref=1'
      )?.id ?? null,
    plain: docForUrl(idIndex([{ id: 'a', doi: '10.1000/xyz' } as Doc]), 'https://example.com/p')
  }
  expect('a link to a paper already in the library is matched', linkRules.byDoi === 'a', linkRules)
  expect(
    'a link to a paper that is not in it is matched to nothing',
    linkRules.other === null,
    linkRules
  )
  expect('an arXiv link is matched by its id', linkRules.byArxiv === 'b', linkRules)
  expect('what follows a link is not part of the identifier', linkRules.query === 'a', linkRules)
  expect(
    'a link carrying no identifier is left to the browser',
    linkRules.plain === null,
    linkRules
  )

  /**
   * Where a link out of a paper goes when the paper it points at is already
   * on the shelf.
   *
   * A reference to something the reader owns is not a reason to leave for a
   * landing page: the PDF is on their own disk and the answer to the press is
   * here.  Both halves are checked, because either alone is a weaker claim —
   * staying put and doing nothing also reaches no shell, and opening the
   * wrong paper also opens one.
   *
   * The pair is hunted for instead of assumed: whether one paper links to
   * another that is in the same library is a fact about that pair, and not
   * something a run can arrange.  The list is sampled across its whole length
   * rather than from the top, because the papers added first are the oldest
   * and their PDFs carry almost no links at all.
   */
  const ownIx = idIndex(loadLibrary()?.docs ?? [])
  // More than one is looked for, because the second half of this check has to
  // reach a particular row in a list of five thousand, and a title that
  // cannot be reached would otherwise turn into a red that says nothing
  // about the thing being checked.
  const wantOwn = await (async () => {
    const lib = loadLibrary()?.docs ?? []
    const cands = lib.filter((d) => d.localPdf && fs.existsSync(d.localPdf as string))
    const stride = Math.max(1, Math.floor(cands.length / 120))
    const found: { doc: (typeof cands)[number]; page: number }[] = []
    for (let k = 0; k < cands.length && found.length < 6; k += stride) {
      const d = cands[k]
      try {
        const data = new Uint8Array(fs.readFileSync(d.localPdf as string))
        const pdf = await pdfjs.getDocument({ data, useSystemFonts: false }).promise
        const last = Math.min(pdf.numPages, 12)
        let page = 0
        for (let i = 1; i <= last && !page; i++) {
          const p = await pdf.getPage(i)
          const anns = (await p.getAnnotations({ intent: 'display' })) as unknown as {
            subtype?: string
            url?: string
            unsafeUrl?: string
          }[]
          for (const a of anns) {
            if (a.subtype !== 'Link') continue
            const u = a.url ?? a.unsafeUrl
            if (!u) continue
            const hit = docForUrl(ownIx, u)
            if (hit && hit.id !== d.id) {
              page = i
              break
            }
          }
        }
        await pdf.destroy()
        if (page) found.push({ doc: d, page })
      } catch {
        /* a paper that will not parse simply has no links to offer */
      }
    }
    return found
  })()

  let ownInfo: Record<string, unknown> = {}
  if (!wantOwn.length) {
    ownInfo = { skip: 'no paper in this library links to another paper in it' }
  } else {
    // A paper is reached by narrowing the list to it, and what a word in the
    // search box brings back is a column of cards, not rows: the table is
    // what the reader gets when the box is empty.  The card pressed is the
    // one carrying this paper's id, because a search for a title does not
    // promise to put the paper that was asked for first.  Several are tried,
    // because a title the list happens not to reach is a fact about the list
    // and not about the thing being checked; what was actually opened is read
    // back, so a press that landed somewhere else says so instead of passing.
    for (const cand of wantOwn) {
      const title = String(cand.doc.title ?? '').slice(0, 40)
      await w.webContents.executeJavaScript(
        `(()=>{const i=document.querySelector(".toolbar input[placeholder^='搜索']");if(!i)return 0;`
          + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
          + `set.call(i,${JSON.stringify(title)});`
          + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
      )
      await new Promise((r) => setTimeout(r, 1500))
      // How many cards the search left is worth knowing: a press that had
      // nowhere to land has to say so rather than look like a press that did
      // nothing.
      const seen = String(
        await w.webContents.executeJavaScript(
          `JSON.stringify({cards:document.querySelectorAll("div.res-row").length,`
            + `mine:document.querySelectorAll('div.res-row[data-id=${JSON.stringify(cand.doc.id)}]').length})`
        )
      )
      const cardSeen = String(
        await until(
          `(document.querySelectorAll('div.res-row[data-id=${JSON.stringify(cand.doc.id)}]').length?'yes':'no')`,
          (v) => v === 'yes',
          6000
        )
      )
      let done = false
      try {
        if (cardSeen !== 'yes') {
          ownInfo = { tried: title, seen, why: 'its card was not in the results' }
        } else {
          const ownOpened = Number(
            await w.webContents.executeJavaScript(
              `(()=>{const r=document.querySelector('div.res-row[data-id=${JSON.stringify(cand.doc.id)}]');`
                + `if(!r)return 0;r.click();return 1})()`
            )
          )
          await new Promise((r) => setTimeout(r, 1800))
          // The whole library comes back before anything is pressed.  Where
          // the reader ends up is read off the selected row, and a row can
          // only be marked selected when it is in the list: narrowed to the
          // one paper that was just opened, the list cannot contain the paper
          // the link points at, and the press would look like it went nowhere.
          await clearSearch()
          const ownAt = String(
            await w.webContents.executeJavaScript(
              '(()=>{const r=document.querySelector("div.row.sel");return r?r.dataset.id||"":""})()'
            )
          )
          // and the paper under the reader is the one that was scanned: a
          // press that landed on another is not evidence about this pair, so
          // it says so and the next candidate is tried
          if (ownAt !== cand.doc.id) {
            ownInfo = {
              title,
              seen,
              opened: ownOpened,
              at: ownAt,
              why: 'the press opened another paper'
            }
          } else {
            await w.webContents.executeJavaScript(
              `(()=>{const i=document.querySelector(".pdf-bar input");if(!i)return 0;`
                + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
                + `set.call(i,${JSON.stringify(String(cand.page))});`
                + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
            )
            await new Promise((r) => setTimeout(r, 2500))
            // Which link is pressed is read out of the page rather than carried
            // over from the scan: what is in the document is the address after
            // it has been checked, and the paper that address names is what the
            // press is then expected to land on.
            const ownHref = String(
              await w.webContents.executeJavaScript(
                '(()=>{const a=document.querySelector("a.pdf-link.own");'
                  + 'return a?a.getAttribute("href")||"":""})()'
              )
            )
            const want = ownHref ? docForUrl(ownIx, ownHref) : null
            ownInfo = {
              title,
              page: cand.page,
              href: ownHref,
              at: ownAt,
              openedRow: ownOpened,
              want: want?.id ?? null,
              seen
            }
            if (!want) {
              ownInfo.why = 'no link marked as on the shelf on the page under the reader'
            } else {
              const openedOwn: string[] = []
              ipcMain.removeHandler('shell:openExternal')
              ipcMain.handle('shell:openExternal', (_e, url: string) => {
                openedOwn.push(url)
                return { ok: true }
              })
              try {
                const clicked = Number(
                  await w.webContents.executeJavaScript(
                    '(()=>{const a=document.querySelector("a.pdf-link.own");if(!a)return 0;'
                      + 'a.click();return 1})()'
                  )
                )
                await new Promise((r) => setTimeout(r, 2500))
                const got = String(
                  await w.webContents.executeJavaScript(
                    '(()=>{const r=document.querySelector("div.row.sel");return r?r.dataset.id||"":""})()'
                  )
                )
                ownInfo.clicked = clicked
                ownInfo.opened = openedOwn
                ownInfo.got = got
                expect(
                  'a link to a paper already in the library opens it here and not in a browser',
                  ownOpened === 1 &&
                    ownAt === cand.doc.id &&
                    clicked === 1 &&
                    openedOwn.length === 0 &&
                    got === want.id,
                  ownInfo
                )
                done = true
              } finally {
                ipcMain.removeHandler('shell:openExternal')
                ipcMain.handle('shell:openExternal', (_e, url: string) => {
                  shell.openExternal(url)
                  return { ok: true }
                })
              }
            }
          }
        }
      } finally {
        // and it stays that way for whatever comes next: the list is how the
        // next twenty checks reach a paper at all
        await clearSearch()
      }
      if (done) break
    }
  }
  log('a link to a paper on the shelf', ownInfo)

  let citeInfo: {
    ok?: boolean
    skip?: string
    hots?: number
    onPage?: number
    refPage?: number
    refHots?: number
    text?: string
    second?: string | null
  } = {}
  /**
   * Which paper to read is a property of the library, not of the run, so it
   * is asked for rather than written down — and what is asked for is not
   * merely "does this paper have a list" but "does a marker a reader can
   * actually hover resolve to an entry in it".  The list alone proves
   * nothing: markers that are not citations, and entries that are not there,
   * are exactly the failure this is here to catch.
   */
  type Runs = { str?: string; transform?: number[] }[]
  /** One paper's list, read the way the reader reads it. */
  const scanPaper = async (d: Doc) => {
    const data = new Uint8Array(fs.readFileSync(d.localPdf as string))
    const pdf = await pdfjs.getDocument({ data, useSystemFonts: false }).promise
    try {
      let entries = new Map<number, string>()
      let refPage = 0
      const later: string[] = []
      for (let n = pdf.numPages; n >= Math.max(1, pdf.numPages - 59); n--) {
        const pg = await pdf.getPage(n)
        const rows = linesOf((await pg.getTextContent()).items as unknown as Runs).map(
          (l) => l.text
        )
        const at = rows.findIndex(isRefHead)
        if (at >= 0) {
          const got = parseRefEntries([...rows.slice(at + 1), ...later])
          if (got.size >= 3) {
            entries = got
            refPage = n
            break
          }
        }
        later.unshift(...rows)
      }
      if (!refPage) return null
      // the page to hover on: the first one carrying a marker every number of
      // which is in the list, since that is the only kind that gets a hotspot
      let on = 0
      for (let n = 1; n < refPage && !on; n++) {
        const pg = await pdf.getPage(n)
        const lines = linesOf((await pg.getTextContent()).items as unknown as Runs)
        if (lines.some((l) => markersIn(l.text).some((m) => m.nums.every((x) => entries.has(x)))))
          on = n
      }
      return on ? { refPage, on, entries: [...entries.values()] } : null
    } finally {
      await pdf.destroy().catch((e) => ignoreFailure(FAILURE.testPdfCleanup, e))
    }
  }

  /**
   * Which paper to read is a property of the library, not of the run, so it
   * is asked for rather than written down — and what is asked for is not
   * merely "does this paper have a list" but "does a marker a reader can
   * actually hover resolve to an entry in it".  The list alone proves
   * nothing: markers that are not citations, and entries that are not there,
   * are exactly the failure this is here to catch.
   *
   * The paper is opened first and identified afterwards, from the row the
   * table says is selected.  A title typed into the search box is not enough
   * to land on a particular paper — several papers share a beginning, and the
   * row that comes back first is not always the one that was meant.  This
   * check first failed that way: it compared a popover against the entries of
   * a paper it had never opened, and the only thing wrong was the paper.
   */
  const openRowByIndex = async (i: number) => {
    await w.webContents.executeJavaScript(
      '(()=>{const s=document.querySelector(".table-wrap");if(s)s.scrollTop=0;'
        + 'const r=[...document.querySelectorAll("div.row")]'
        + '.filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"));'
        + `if(r.length<=${i})return 0;r[${i}].click();return 1})()`
    )
    await new Promise((r) => setTimeout(r, 1800))
    return String(
      await w.webContents.executeJavaScript(
        '(()=>{const r=document.querySelector("div.row.sel");return r?r.dataset.id||"":""})()'
      )
    )
  }
  const wantCites = await (async () => {
    const byId = new Map(
      (loadLibrary()?.docs ?? [])
        .filter((d) => d.localPdf && fs.existsSync(d.localPdf as string))
        .map((d) => [d.id, d])
    )
    for (let i = 0; i < 6; i++) {
      const id = await openRowByIndex(i)
      const d = byId.get(id)
      if (!d) continue
      try {
        const got = await scanPaper(d)
        if (got) return { doc: d, ...got }
      } catch {
        /* a paper that will not parse simply has no list to offer */
      }
    }
    return undefined
  })()

  if (!wantCites) {
    citeInfo = { skip: 'no paper in this library has a reference list that can be read' }
  } else {
    log('the paper being read', {
      title: String(wantCites.doc.title ?? '').slice(0, 50),
      refPage: wantCites.refPage,
      on: wantCites.on
    })
    // The page to hover on is set rather than assumed.  What page a freshly
    // opened paper lands on is a fact about the paper before it as much as
    // about this one — the reader carries its page across a change of
    // document — and a reader left on page eight reads page eight of the new
    // paper too, which on a reference list is a page with no markers on it.
    await w.webContents.executeJavaScript(
      `(()=>{const i=document.querySelector(".pdf-bar input");if(!i)return 0;`
        + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
        + `set.call(i,${JSON.stringify(String(wantCites.on))});`
        + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
    await new Promise((r) => setTimeout(r, 1200))
    // The list is read in the background once the paper is open, so what is
    // waited for is the hotspots rather than a fixed time.
    // Where the hotspots are is as much a part of the answer as what they
    // say: a card that opens on the wrong word is the same wrong answer in a
    // different place, and nothing about a dispatched hover would notice —
    // the event lands on the element wherever that element is.  So the boxes
    // are measured against the page: inside it, and no bigger than a marker
    // can be.  A rectangle in the wrong coordinate space fails the first, a
    // rectangle covering a whole run instead of `[3]` fails the second.
    const HOT =
      '(()=>{const cur=Number((document.querySelector(".pdf-bar input")||{}).value||0);'
      + 'const host=document.querySelector(\'[data-page="\'+cur+\'"]\')||document.querySelector(".pdf-scroll");'
      + 'if(!host)return JSON.stringify({page:cur,n:0,pe:null});'
      + 'const box=host.querySelector(".pg-box")||host.firstElementChild||host;'
      + 'const b=box.getBoundingClientRect();'
      + 'const h=[...host.querySelectorAll(".cite-hot")];'
      + 'let maxW=0,maxH=0,outside=0;'
      + 'for(const e of h){const r=e.getBoundingClientRect();'
      + 'if(b.width>0){maxW=Math.max(maxW,r.width/b.width);maxH=Math.max(maxH,r.height/b.height);'
      + 'const cx=(r.left+r.right)/2,cy=(r.top+r.bottom)/2;'
      + 'if(cx<b.left-1||cx>b.right+1||cy<b.top-1||cy>b.bottom+1)outside++;}}'
      + 'return JSON.stringify({page:cur,n:h.length,'
      + 'pe:h.length?getComputedStyle(h[0]).pointerEvents:null,'
      + 'maxW:Math.round(maxW*1000)/1000,maxH:Math.round(maxH*1000)/1000,outside})})()'
    let hot = JSON.parse(await w.webContents.executeJavaScript(HOT))
    for (let i = 0; i < 30 && !(hot.n >= 1); i++) {
      await new Promise((r) => setTimeout(r, 300))
      hot = JSON.parse(await w.webContents.executeJavaScript(HOT))
    }
    log('citations on the page', { page: hot.page, refPage: wantCites.refPage, n: hot.n })
    expect(
      'a citation in the body offers the entry it names',
      hot.n >= 1 && hot.pe === 'auto',
      hot
    )
    // A marker can be eleven numbers long.  `[27, 39, 25, 45, 55, 36, 4, 59,
    // 3, 60, 50]` is one marker on the first page of Sohn et al. 2020 and it
    // measures 0.277 of the page across — the line used to sit at 0.2, which
    // is a ruler calibrated on `[3]` and one that calls a correct box wrong.
    // What the box must not be is a line: a coordinate space that is out by a
    // page puts the boxes outside it, which `outside` catches, and a box laid
    // over a run instead of over the marker is a column wide.
    expect(
      'the box it offers it from is on the page and no bigger than a marker',
      hot.outside === 0 && hot.maxW < 0.4 && hot.maxH < 0.06 && hot.maxW > 0,
      hot
    )

    // Hovering one.  React hears `mouseover` at the root and works out the
    // enter from it, so that is the event to send.
    const HOVER =
      '(()=>{const cur=Number((document.querySelector(".pdf-bar input")||{}).value||0);'
      + 'const host=document.querySelector(\'[data-page="\'+cur+\'"]\')||document.querySelector(".pdf-scroll");'
      + 'const h=host?[...host.querySelectorAll(".cite-hot")]:[];if(!h.length)return 0;'
      + 'const e=h[arguments0]||h[0];'
      + 'e.dispatchEvent(new MouseEvent("mouseover",{bubbles:true,cancelable:true}));'
      + 'return h.length})()'
    const POP =
      '(()=>{const p=document.querySelector(".cite-pop");if(!p)return JSON.stringify({open:false});'
      + 'const b=p.getBoundingClientRect();'
      + 'return JSON.stringify({open:true,vis:getComputedStyle(p).visibility,'
      + 'rows:[...p.querySelectorAll(".cite-row")].map(r=>'
      + '(r.querySelector(".cite-tx")||{}).textContent||"")})})()'
    const hover = (which: number) =>
      w.webContents.executeJavaScript(HOVER.replace('arguments0', String(which)))
    const popNow = async () => {
      let p = JSON.parse(await w.webContents.executeJavaScript(POP))
      for (let i = 0; i < 12 && !p.open; i++) {
        await new Promise((r) => setTimeout(r, 120))
        p = JSON.parse(await w.webContents.executeJavaScript(POP))
      }
      return p as { open: boolean; vis?: string; rows?: string[] }
    }

    await hover(0)
    const pop = await popNow()
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
    const known = new Set(wantCites.entries.map(flat))
    const got = flat(String(pop.rows?.[0] ?? ''))
    log('the entry under the pointer', {
      open: pop.open,
      vis: pop.vis,
      len: got.length,
      inList: known.has(got)
    })
    expect(
      'what it offers is an entry the paper actually printed',
      pop.open && pop.vis === 'visible' && got.length > 20 && known.has(got),
      { vis: pop.vis, got: got.slice(0, 80), rows: pop.rows?.length }
    )

    // A second marker has to offer its own entry: a popover that answers
    // every marker with the same paper is the wrong-paper failure in its
    // plainest form.
    const many = Number(await hover(1))
    let second: string | null = null
    if (many > 1) {
      const p2 = await popNow()
      second = flat(String(p2.rows?.[0] ?? ''))
      log('a second marker', { len: second.length, same: second === got })
    }
    citeInfo = {
      ok: true,
      hots: hot.n,
      onPage: hot.page,
      refPage: wantCites.refPage,
      text: got.slice(0, 60),
      second: many > 1 ? second?.slice(0, 60) ?? null : 'only one marker on the page'
    }

    // While highlighting is on the whole layer stands down: a drag across the
    // page is a highlight, and a card opening under it would take the drag.
    const marking = await (async () => {
      const pressed = Number(
        await w.webContents.executeJavaScript(
          '(()=>{const b=[...document.querySelectorAll(".pdf-bar button")]'
            + '.find(x=>x.textContent.trim()==="高亮");if(!b)return 0;b.click();return 1})()'
        )
      )
      await new Promise((r) => setTimeout(r, 600))
      const seen = JSON.parse(await w.webContents.executeJavaScript(HOT))
      await w.webContents.executeJavaScript(
        '(()=>{const b=[...document.querySelectorAll(".pdf-bar button")]'
          + '.find(x=>x.textContent.trim()==="高亮");if(b)b.click();return 1})()'
      )
      await new Promise((r) => setTimeout(r, 400))
      return { pressed, seen }
    })()
    log('citations while highlighting', marking)
    expect(
      'a citation stands down while highlighting is on',
      marking.pressed === 1 && marking.seen.n >= 1 && marking.seen.pe === 'none',
      marking
    )

    // The page the list is on is the list: every line of it opens with a
    // number in brackets, and ringing all of them would leave a page where
    // every number looks like a citation.
    if (wantCites.refPage !== hot.page) {
      await w.webContents.executeJavaScript(
        `(()=>{const i=document.querySelector(".pdf-bar input");if(!i)return 0;`
          + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
          + `set.call(i,${JSON.stringify(String(wantCites.refPage))});`
          + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
      )
      await new Promise((r) => setTimeout(r, 2000))
      const onRef = JSON.parse(await w.webContents.executeJavaScript(HOT))
      citeInfo.refHots = onRef.n
      expect(
        'the reference list itself is not ringed in citations',
        onRef.n === 0,
        onRef
      )
    }

  }
  log('citations in a paper', citeInfo)

  // Reading is a view of its own: the paper gets the whole window instead of
  // a column beside the table, and one key goes back.  Worth asserting
  // because "the reader is a tab in a pane" is the arrangement a catalogue
  // wants and the one this program grew into, and nothing else in the suite
  // would notice if it went back to being that.
  const readerInfo = await (async () => {
    const pressed = Number(
      await w.webContents.executeJavaScript(
        '(()=>{const b=[...document.querySelectorAll(".toolbar button")]'
        + '.find(x=>x.textContent.trim()==="阅读");if(!b||b.disabled)return 0;'
        + 'b.click();return 1})()'
      )
    )
    await new Promise((r) => setTimeout(r, 2500))
    const inReader = JSON.parse(
      await w.webContents.executeJavaScript(
        '(()=>{const b=document.querySelector(".body.reading");'
        + 'return JSON.stringify({reading:!!b,pdf:!!(b&&b.querySelector(".pdf-pane")),'
        + 'table:!!document.querySelector(".pane-mid")})})()'
      )
    )
    await w.webContents.executeJavaScript(
      '(()=>{window.dispatchEvent(new KeyboardEvent("keydown",'
      + '{key:"Escape",bubbles:true,cancelable:true}));return 1})()'
    )
    await new Promise((r) => setTimeout(r, 900))
    const back = JSON.parse(
      await w.webContents.executeJavaScript(
        '(()=>JSON.stringify({reading:!!document.querySelector(".body.reading"),'
        + 'table:!!document.querySelector(".pane-mid")}))()'
      )
    )
    return { pressed, inReader, back }
  })()
  log('reading view', readerInfo)
  expect(
    'reading gives the paper the whole window',
    readerInfo.pressed === 1 &&
      readerInfo.inReader.reading === true &&
      readerInfo.inReader.pdf === true &&
      readerInfo.inReader.table === false,
    readerInfo
  )
  expect(
    'Esc leaves the reader and brings the table back',
    readerInfo.back.reading === false && readerInfo.back.table === true,
    readerInfo.back
  )

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
  // The reader's clipboard is put back through the same door it was read
  // through.  What was on it is not this run's to judge — it can be an image,
  // a path, or a fragment of a spreadsheet — and a rejected invoke here ends
  // the whole run, which is the wrong price for leaving it as it was found.
  await w.webContents
    .executeJavaScript(`window.api.copyText(${JSON.stringify(String(clipBefore ?? ''))})`)
    .catch((e) => log('the clipboard was not put back', String(e)))

  // The row menu.  Right clicking has to (a) open it where the pointer is,
  // (b) act on the row under the pointer, and (c) close on the next click —
  // a menu that survives its own action is the usual way these go wrong.
  const menuInfo = async () =>
    w.webContents.executeJavaScript(
      // the read is inside its own try: a script that throws ends the run
        // rather than failing the check, and a run that stops half way leaves
        // the config for the next one to trip over
      '(()=>{try{const m=document.querySelector(".row-menu");'
      + 'if(!m)return JSON.stringify({open:0});'
      + 'const r=m.getBoundingClientRect();'
      + 'return JSON.stringify({open:1,head:(document.querySelector(".row-menu-head")||{}).textContent||null,'
      // the box itself, and the window it has to fit in: "outside the window"
      // is four different faults (off the top, off the bottom, off either
      // side) and a red that only says which one it is saves a whole run
      + 'rect:{l:Math.round(r.left),t:Math.round(r.top),r:Math.round(r.right),'
      + 'b:Math.round(r.bottom),w:innerWidth,h:innerHeight},'
      + 'items:[...document.querySelectorAll(".row-menu-item")].map(b=>b.textContent),'
      + 'seps:document.querySelectorAll(".row-menu-sep").length,'
      + 'inWindow:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})'
      + '}catch(e){return JSON.stringify({open:0,err:String(e)})}'
      + '})()'
    )
  // and parsed the same careful way: a page that answers with something that
  // is not JSON is a page to be reported, not a run to be ended
  const menuRead = async (): Promise<{
    open: number
    head?: string | null
    rect?: { l: number; t: number; r: number; b: number; w: number; h: number }
    items?: string[]
    seps?: number
    inWindow?: boolean
    err?: string
  }> => {
    const raw = await menuInfo()
    try {
      return JSON.parse(String(raw ?? 'null')) as {
        open: number
        head?: string | null
        rect?: { l: number; t: number; r: number; b: number; w: number; h: number }
        items?: string[]
        seps?: number
        inWindow?: boolean
        err?: string
      }
    } catch (e) {
      return { open: 0, err: `unreadable: ${String(e)}` }
    }
  }
  await w.webContents.executeJavaScript(
    '(()=>{const r=[...document.querySelectorAll("div.row")]'
      + '.filter(e=>e.querySelector(".pdf-dot:not(.no-pdf)"))'
      // A row the reader cannot see is not one they can right click.  The
      // virtual list keeps a few rows past the fold, so the first row in the
      // document is not always the first one on the screen: asked for above
      // the top edge, the menu opens above the window, which is a fault in
      // the asking and not in the menu.
      + '.filter(e=>{const b=e.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight});'
      + 'if(!r.length)return 0;const b=r[0].getBoundingClientRect();'
      + 'r[0].dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,'
      + 'clientX:Math.round(b.left+40),clientY:Math.round(b.top+8)}));return 1})()'
  )
  // Waited for rather than read after half a second.  A right click on a row
  // does two things at once: it selects the row, which puts that paper's PDF
  // in the right pane, and it asks for the menu.  The menu is cheap and the
  // PDF is not, and a menu read while the paper is still opening reads a
  // window that has not drawn it yet — which looks like a right click the app
  // ignored, and sends the next person looking for a bug in the menu.
  await until(
    '(()=>{return document.querySelector(".row-menu")?"yes":"no"})()',
    (v) => v === 'yes',
    6000
  )
  // and a moment for it to be placed: the card measures itself and pulls
  // itself back inside the window, so the box read straight after it appears
  // is the box before that, which is sometimes a box outside the window
  await new Promise((r) => setTimeout(r, 300))
  const mi = await menuRead()
  log('row menu', JSON.stringify(mi))
  expect('a right click opens the row menu', mi.open === 1, mi)
  // `|| []` rather than a bare read: a menu that did not open answers with no
  // list at all, and reading `.length` off that throws, which ends the run
  // before the config is put back — one red line turning into a dozen more on
  // every later run, because the next run starts from what this one left.
  expect(
    'the row menu offers actions and separators',
    (mi.items || []).length >= 4 && (mi.seps || 0) >= 1,
    mi
  )
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
  expect('the menu closes after an item is chosen', (await menuRead()).open === 0, mi)
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
  //
  // Page one is where it is asked, because the check before this one leaves
  // the reader wherever its own jump landed: a paper with no outline sends it
  // to a page chosen at random, and a figure page has no words on it to look
  // for.  A query taken from a page with no text on it is an empty query, and
  // an empty query finds nothing — which is a red about the page, not about
  // find.
  await w.webContents.executeJavaScript(
    `(()=>{const i=document.querySelector(".pdf-bar input");if(!i)return 0;`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
      + `set.call(i,"1");i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
  )
  await new Promise((r) => setTimeout(r, 1500))
  log('click 查找', await clickBar('查找'))
  await new Promise((r) => setTimeout(r, 300))
  // The word is the one the page repeats most often, not the first one on it.
  //
  // Taking the first span made the next assertion depend on which paper
  // happened to be first in the list: a word that occurs once cannot step,
  // and `stepping moves the find caret` was gated on there being more than
  // one hit, so a paper whose first span is a rare term silently lost the
  // check — and "silently" is the whole of the problem, because a check that
  // did not run looks exactly like one that passed.  Counting first and
  // taking the most frequent makes the gate depend on the page rather than
  // on luck, and the runners-up are kept so a future skip can say what was
  // available to look for.
  //
  // Wait on this very expression, not on a separate span count taken
  // earlier. 157 waited for `.tx-layer span.tx` *before* pressing 查找, but
  // opening the find bar redraws the text layer — and this run comes
  // straight out of the continuous-mode test, which redraws it again. On
  // 158 r1 the earlier check passed with 66 spans while this one returned
  // `[]`, query "", and six assertions went red saying nothing about find.
  // A premise has to be asserted at the moment the thing it guards is read,
  // not one DOM-changing action earlier.
  const FIND_WORDS =
    '(()=>{const sp=[...document.querySelectorAll(".tx-layer span.tx")]'
    + '.map(s=>(s.textContent||"").trim()).filter(t=>t.length>=4);'
    + 'const n=new Map();for(const t of sp)n.set(t,(n.get(t)||0)+1);'
    + 'return JSON.stringify([...n.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4)'
    + '.map(([t,c])=>({t:t,c:c})))})()'
  const findWordsRaw = await until(
    FIND_WORDS,
    (v) => {
      try {
        const k = JSON.parse(String(v ?? '[]'))
        return Array.isArray(k) && k.length > 0
      } catch {
        return false
      }
    },
    12000
  )
  const findWords = JSON.parse(String(findWordsRaw ?? '[]')) as {
    t: string
    c: number
  }[]
  log('find word candidates', findWords)
  expect('the page has words to look for before find is asked', findWords.length > 0, {
    candidates: findWords.length,
    occurrences: findWords.reduce((n, x) => n + x.c, 0)
  })
  let query = ''
  let findInfo = '{}'
  for (const cand of findWords) {
    query = cand.t
    await w.webContents.executeJavaScript(
      '(()=>{const i=document.querySelector(".pdf-find input");if(!i)return 0;'
      + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
      + `set.call(i,${JSON.stringify(query)});i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
    // the scan walks every page and only finishes when it reaches the last one
    await new Promise((r) => setTimeout(r, 4000))
    findInfo = await w.webContents.executeJavaScript(
      '(()=>{const d=document.documentElement.dataset;'
      + 'const marks=[...document.querySelectorAll(".find-hit")];'
      + 'const cur=document.querySelector(".find-hit.cur");'
      + 'return JSON.stringify({hits:d.findHits,page:d.findPage,marks:marks.length,'
      + 'current:!!cur,count:(document.querySelector(".find-count")||{}).textContent||null,'
      + 'box:marks[0]?{w:Math.round(marks[0].getBoundingClientRect().width),'
      + 'h:Math.round(marks[0].getBoundingClientRect().height)}:null})})()'
    )
    log('find', { word: query, info: findInfo })
    if (Number((JSON.parse(findInfo) as { hits?: number }).hits ?? 0) > 1) break
  }
  log('find query', JSON.stringify(query))
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
  } else {
    // One hit is not nothing to check, and it is not a reason to check
    // nothing: the stepping assertion used to be skipped in this case, which
    // is how a whole check came to be missing from the run without a word
    // about it.  With nowhere to step to, what has to hold is that the caret
    // stays on the one hit and the hit is not lost.
    expect(
      'stepping with nowhere to go keeps the one hit',
      Number((JSON.parse(stepped) as { hits?: number }).hits ?? 0) === 1 && stepped !== '',
      { word: query, words: findWords, fi, stepped }
    )
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
      + 'pos:added[0]?added[0].pos:null,text:added[0]?added[0].text:null})})()'
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
  // A highlight that only remembers where it is cannot be read anywhere but
  // on that one page: the sidebar has nothing to name it by, an export has
  // nothing to quote, and if the PDF is ever lost the rectangle points at
  // nothing.  Only asked when a mark was really made — this is a real paper,
  // and a page with no text layer has no words to remember.
  if (made.added > 0) {
    expect(
      'a highlight remembers the words it covers',
      String(made.text ?? '').trim().length > 0,
      made
    )
  }

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
      + 'const idx=n=>fs.findIndex(f=>lab(f)===n);'
      + 'const absF=at("摘要");const ta=absF?absF.querySelector("textarea"):null;'
      + 'return JSON.stringify({labels:fs.map(lab),type:kind("类型"),'
      + 'abs:{at:idx("摘要"),tags:idx("标签（逗号分隔）"),'
      + 'note:fs.findIndex(f=>lab(f).indexOf("笔记")===0),'
        + 'len:ta?(ta.value||"").length:0,'
        + 'h:ta?Math.round(ta.getBoundingClientRect().height):0,'
        + 'sh:ta?ta.scrollHeight:0,ch:ta?ta.clientHeight:0},'
      + 'volume:!!at("卷"),issue:!!at("期"),pages:!!at("页码"),'
      + 'publisher:!!at("出版社 / 机构"),keywords:!!at("关键词（逗号分隔）"),'
      + 'url:!!at("链接")})})()'
    )
  )
  log('details fields', detFields)
  // The abstract is the field the decision to read a paper is made on, and it
  // used to sit below the tags, the note and the two switches — so the one
  // thing worth reading was the one thing that needed a scroll to reach.
  expect(
    'the abstract is not buried under the tags and the note',
    detFields.abs.at >= 0 && detFields.abs.at < detFields.abs.tags &&
      detFields.abs.at < detFields.abs.note,
    detFields.abs
  )
  // And it has to be readable where it is: a box three lines tall is a box
  // that has to be scrolled inside, which is the panel asking the reader to
  // do the panel's job.  The box grows to fit what is in it and stops at the
  // height it is allowed to take, so what is asked is that it is at least as
  // tall as its contents need, up to that cap.
  //
  // Measured rather than inferred from the length of the abstract: a fixed
  // box happens to fit a short one, so asking only of a long abstract would
  // have made the case that looks like a pass the case that is not checked.
  expect(
    'the abstract can be read without scrolling inside its box',
    detFields.abs.ch > 0 && detFields.abs.ch >= Math.min(detFields.abs.sh, 258),
    detFields.abs
  )
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
  // The day has to be on screen, not only wired in the source. `title` is
  // the exact ISO moment from the library cache, so the short value can be
  // checked against a real record rather than against a made-up date (180).
  const addedAt = JSON.parse(
    await w.webContents.executeJavaScript(
      `(()=>{const fs=[...document.querySelectorAll('.details .field')];`
      + `const f=fs.find(x=>((x.querySelector('label')||{}).textContent||'').trim()==='加入时间');`
      + `if(!f)return JSON.stringify({found:0});`
      + `const i=f.querySelector('input');`
      + `return JSON.stringify({found:1,value:i?i.value:'',title:i?i.title:'',`
      + `readOnly:i?i.readOnly:null})})()`
    )
  )
  const createdSet = new Set(
    (loadLibrary()?.docs ?? []).map((d) => d.created).filter((s): s is string => !!s)
  )
  log('details added-at', addedAt)
  expect(
    'the details pane names the day the paper joined the library',
    addedAt.found === 1 &&
      addedAt.readOnly === true &&
      (addedAt.value === '未知' || /^\d{4}-\d{2}-\d{2}$/.test(addedAt.value)) &&
      (addedAt.title === '' || createdSet.has(addedAt.title)),
    { ...addedAt, knownMoments: createdSet.size }
  )
  expect(
    'the type is chosen from the vocabulary the API accepts',
    !!detFields.type?.select &&
      ['journal', 'thesis', 'generic'].every((t) => (detFields.type?.opts ?? []).includes(t)) &&
      (detFields.type?.opts ?? []).length === 14,
    detFields.type
  )
  // A lookup started under paper A used to come back on paper B's panel: the
  // candidate box showed A's title and clicking one patched B's cloud record
  // with A's metadata. Hold the lookup open with a controlled promise so the
  // paper really changes while it is in flight (174).
  // contextBridge exposes `api` with configurable=false and writable=false,
  // so neither its properties nor the window binding can be replaced from
  // the renderer. Hold the two IPC handlers in the main process instead:
  // save the exact listeners Electron registered, put controlled ones in
  // their place, and put those same listeners back afterwards. A handler
  // that could not be swapped would make the UI assertions pass vacuously,
  // so the first assertion is part of their premise.
  const invokeHandlers = (
    ipcMain as unknown as {
      _invokeHandlers?: Map<string, (...args: unknown[]) => unknown>
    }
  )._invokeHandlers
  const savedMeta = invokeHandlers?.get('meta:lookup')
  const savedPatch = invokeHandlers?.get('doc:patch')
  const heldOk = !!savedMeta && !!savedPatch
  expect(
    'the smoke run can reach the two invoke handlers it is about to hold open',
    heldOk,
    { meta: !!savedMeta, patch: !!savedPatch, hasMap: !!invokeHandlers }
  )
  const held: { resolve?: (v: MetaCandidate[]) => void } = {}
  const heldLookup = new Promise<MetaCandidate[]>((r) => {
    held.resolve = r
  })
  const patchCalls: { id: string; body: Record<string, unknown> }[] = []
  if (heldOk) {
    ipcMain.removeHandler('meta:lookup')
    ipcMain.removeHandler('doc:patch')
    ipcMain.handle('meta:lookup', async () => heldLookup)
    // A held patch throws instead of writing: the old panel would still call
    // it — that is exactly the failure being looked for — while the test
    // touches neither the cloud record nor the library state.
    ipcMain.handle('doc:patch', async (_e, id: string, body: Record<string, unknown>) => {
      patchCalls.push({ id, body })
      throw new Error('smoke: patch held')
    })
  }
  let metaRace: Record<string, unknown> = {}
  try {
    if (heldOk) {
      const first = JSON.parse(
        await w.webContents.executeJavaScript(
          '(async()=>{'
          + 'const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));'
          + 'const rows=[...document.querySelectorAll("div.row")];'
          + 'const sel=()=>{const r=document.querySelector("div.row.sel");return r?(r.dataset.id||""):""};'
          + 'const meta=()=>[...document.querySelectorAll(".meta-actions button")]'
          + '.find(b=>(b.textContent||"").indexOf("补全元数据")>=0);'
          + 'if(rows.length<2)return JSON.stringify({error:"not enough rows",rows:rows.length});'
          + 'window.__metaBefore=sel();'
          + 'rows[0].click();await frame();'
          + 'const a=sel();const btn=meta();'
          + 'if(!btn||btn.disabled)return JSON.stringify({error:"no enabled lookup button",a:a});'
          + 'btn.click();await frame();'
          + 'rows[1].click();await frame();'
          + 'const b=sel();'
          // The button changes its label while a lookup is running, so ask
          // whether any button says "查询中" rather than looking the button
          // up by the label it only has when idle (166: a detector that
          // cannot find the thing it is looking for also reports all clear).
          + 'const spinner=[...document.querySelectorAll(".meta-actions button")]'
          + '.some(b=>(b.textContent||"").indexOf("查询中")>=0);'
          + 'return JSON.stringify({a:a,b:b,spinner:spinner})})()'
        )
      ) as Record<string, unknown>
      // Resolve the held lookup from the main process, then let the renderer
      // collect the IPC answer and commit its state. A round trip through
      // that same handler is the barrier, not a guessed sleep.
      const candidate: MetaCandidate[] = [
        {
          from: 'crossref',
          score: 0.99,
          title: 'A 的标题',
          patch: { title: 'A 的标题', year: 1999 }
        }
      ]
      held.resolve?.(candidate)
      const second = JSON.parse(
        await w.webContents.executeJavaScript(
          '(async()=>{'
          + 'await window.api.lookupMeta("smoke-barrier");'
          + 'const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));'
          + 'await frame();await frame();'
          + 'const boxes=document.querySelectorAll(".cand-box").length;'
          + 'const row=document.querySelector(".cand-box .cand-row");'
          + 'if(row)row.click();'
          + 'await frame();await frame();'
          + 'const restore=[...document.querySelectorAll("div.row")]'
          + '.find(r=>(r.dataset.id||"")===window.__metaBefore);'
          + 'if(restore)restore.click();await frame();'
          // clicking a row can move the right pane back to the PDF tab; the
          // notes assertions that follow need the details pane back where it was
          + 'const back=[...document.querySelectorAll(".pane-right button")]'
          + '.find(x=>(x.textContent||"").trim()==="详情");'
          + 'if(back)back.click();await frame();'
          + 'return JSON.stringify({boxes:boxes,restored:!!restore,details:!!back,'
          + 'noteBox:!!document.querySelector("textarea.note-box")})})()'
        )
      ) as Record<string, unknown>
      metaRace = { ...first, ...second, calls: patchCalls.slice() }
    }
  } finally {
    if (heldOk && savedMeta && savedPatch) {
      ipcMain.removeHandler('meta:lookup')
      ipcMain.removeHandler('doc:patch')
      ipcMain.handle('meta:lookup', savedMeta as Parameters<typeof ipcMain.handle>[1])
      ipcMain.handle('doc:patch', savedPatch as Parameters<typeof ipcMain.handle>[1])
    }
  }
  log('metadata lookup across a paper change', metaRace)
  expect(
    'a lookup started under the previous paper cannot appear on the new one',
    heldOk &&
      metaRace.error === undefined &&
      typeof metaRace.a === 'string' && metaRace.a !== '' &&
      typeof metaRace.b === 'string' && metaRace.b !== '' &&
      metaRace.a !== metaRace.b &&
      metaRace.boxes === 0 &&
      Array.isArray(metaRace.calls) && metaRace.calls.length === 0,
    metaRace
  )
  expect(
    'the new paper does not inherit the previous lookup spinner',
    heldOk && metaRace.spinner === false && metaRace.noteBox === true,
    { spinner: metaRace.spinner, noteBox: metaRace.noteBox, heldOk }
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
  // and it is that cause and not the other one: a reader who changed the page
  // budget must not be told an update did it, which needs the two of them to
  // be told apart at this end as well
  expect(
    'an index an older app wrote is not called a budget change',
    ftStat0.voided === 'format',
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

  // The other answer a search can give, and the one that decides whether the
  // reader trusts the one above it.  The index reads the first few pages of
  // each paper, so "not found here" is not "not in your library" — and read
  // the other way round it sends somebody off to import a paper they already
  // have, which is worse than a search that says nothing.  What is checked is
  // that the difference is stated: how far the index reads, that this does
  // not prove absence, and one press that widens it.
  await setInput('.toolbar input', 'zzzz-not-a-word-anywhere-zzzz')
  await new Promise((r) => setTimeout(r, 1200))
  const ftNoHit = JSON.parse(
    await w.webContents.executeJavaScript(
      'JSON.stringify({rows:document.querySelectorAll(".ft-row").length,'
      + 'text:(document.querySelector(".pane-mid .empty")||{}).textContent||null,'
      + 'btns:[...document.querySelectorAll(".pane-mid .empty button")].map(b=>b.textContent)})'
    )
  )
  log('ft with nothing found', ftNoHit)
  expect(
    'a search that finds nothing says how far the index reads',
    ftNoHit.rows === 0 &&
      /没找到/.test(ftNoHit.text ?? '') &&
      new RegExp(`前 ${ftStat1.pages} 页`).test(ftNoHit.text ?? ''),
    ftNoHit
  )
  expect(
    'and says that this is not the same as the library not having it',
    /不等于/.test(ftNoHit.text ?? '') && /每篇索引页数/.test(ftNoHit.text ?? ''),
    ftNoHit
  )
  expect(
    'the wider index is one press away',
    (ftNoHit.btns ?? []).some((t: string) => /打开设置/.test(t)),
    ftNoHit
  )
  // and the press has to land on the number, not merely on the sheet holding
  // it: a settings box that opens at the top makes "去设置里改" into a hunt
  // through four screens of scrolling for a row the reader cannot name
  await w.webContents.executeJavaScript(
    '(()=>{const b=[...document.querySelectorAll(".pane-mid .empty button")]'
    + '.find(x=>/打开设置/.test(x.textContent||""));if(!b)return 0;b.click();return 1})()'
  )
  await new Promise((r) => setTimeout(r, 700))
  const ftSet = JSON.parse(
    await w.webContents.executeJavaScript(
      '(()=>{const m=document.querySelector(".modal.settings");if(!m)return JSON.stringify({open:0});'
      + 'const b=m.getBoundingClientRect();'
      + 'const sec=[...m.querySelectorAll(".set-sec")].find(s=>(s.textContent||"").trim()==="全文检索");'
      + 'const sb=sec?sec.getBoundingClientRect():null;'
      + 'return JSON.stringify({open:1,focus:m.dataset.focus||null,'
      + 'secs:[...m.querySelectorAll(".set-sec")].map(s=>(s.textContent||"").trim()),'
      + 'seen:sb?sb.top>=b.top-2&&sb.bottom<=b.bottom+2:false})})()'
    )
  )
  log('settings from the full-text panel', ftSet)
  expect(
    'the press opens the settings on the page budget',
    ftSet.open === 1 && ftSet.focus === '全文检索' && ftSet.seen === true,
    ftSet
  )
  await w.webContents.executeJavaScript(
    'window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'
  )
  await new Promise((r) => setTimeout(r, 500))
  // put the word back: everything below reads hits off the screen
  await setInput('.toolbar input', 'the')
  await new Promise((r) => setTimeout(r, 1200))

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
  // Full-text is a mode of the same box, so it gets the same way out — and it
  // is offered with an empty box too, because what is being left is the mode,
  // whose only other exit is the toggle that got in.
  const xInFt = await w.webContents.executeJavaScript(
    'document.querySelectorAll(".search-clear").length'
  )
  expect('the way out is offered in full-text mode as well', xInFt === 1, xInFt)
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
    // A group is a decision between papers, and a list that only describes
    // them asks for that decision to be made on the titles.  Opening one has
    // to be one press, and the row being looked at has to be knowable —
    // three rows under one heading with the same title cannot be told apart
    // any other way.
    //
    // Which paper opened is read back off the row that claims to be open
    // rather than off the pane: the pane shows a PDF or a set of fields and
    // neither of them names the paper in a way this run can compare against
    // the row that was pressed.  The mark is driven by the same selection
    // the pane is, so it is the same fact read from the cheaper end.
    const dupeRow = JSON.parse(
      await w.webContents.executeJavaScript(
        '(()=>{const r=[...document.querySelectorAll(".dupe-group .trash-row")];'
        + 'if(!r.length)return JSON.stringify({rows:0});'
        + 'const id=r[0].dataset.id||"";r[0].click();return JSON.stringify({rows:r.length,id:id})})()'
      )
    )
    await new Promise((r) => setTimeout(r, 2500))
    const dupeOpened = JSON.parse(
      await w.webContents.executeJavaScript(
        'JSON.stringify({open:[...document.querySelectorAll(".dupe-group .trash-row.open")]'
        + '.map(r=>r.dataset.id||""),'
        + 'pdf:!!document.querySelector(".pane-right .pdf-bar input, .pdf-bar input"),'
        + 'det:!!document.querySelector(".pane-right .det, .pane-right .details, .pane-right table"),'
        + 'empty:(document.querySelector(".pane-right .empty")||{}).textContent||null})'
      )
    )
    log('opened from a duplicate group', { pressed: dupeRow, opened: dupeOpened })
    expect(
      'a row in a duplicate group opens that paper',
      dupeRow.rows > 0 &&
        dupeOpened.open.length === 1 &&
        dupeOpened.open[0] === dupeRow.id &&
        dupeOpened.empty === null &&
        (dupeOpened.pdf === true || dupeOpened.det === true),
      { pressed: dupeRow, opened: dupeOpened }
    )
    // The row is also a button host: pressing 设为保留 must not open the
    // paper it belongs to, or a reader comparing two entries loses whichever
    // one they had up every time they change their mind about the keeper.
    const dupeKeep = JSON.parse(
      await w.webContents.executeJavaScript(
        '(()=>{const r=[...document.querySelectorAll(".dupe-group .trash-row")]'
        + '.filter(x=>!x.classList.contains("keeper"));'
        + 'if(!r.length)return JSON.stringify({rows:0});'
        + 'const b=[...r[0].querySelectorAll("button")]'
        + '.find(x=>x.textContent.trim()==="设为保留");'
        + 'if(!b)return JSON.stringify({rows:r.length,btn:0});'
        + 'b.click();return JSON.stringify({rows:r.length,btn:1,id:r[0].dataset.id||""})})()'
      )
    )
    await new Promise((r) => setTimeout(r, 1200))
    const dupeAfterKeep = JSON.parse(
      await w.webContents.executeJavaScript(
        'JSON.stringify({open:[...document.querySelectorAll(".dupe-group .trash-row.open")]'
        + '.map(r=>r.dataset.id||""),'
        + 'keeper:[...document.querySelectorAll(".dupe-group .trash-row.keeper")]'
        + '.map(r=>r.dataset.id||"")})'
      )
    )
    log('设为保留 pressed inside a group', { pressed: dupeKeep, after: dupeAfterKeep })
    expect(
      'pressing 设为保留 does not open that paper instead',
      dupeKeep.btn === 1 &&
        dupeAfterKeep.open.length === 1 &&
        dupeAfterKeep.open[0] === dupeRow.id &&
        dupeAfterKeep.keeper.includes(dupeKeep.id),
      { pressed: dupeKeep, after: dupeAfterKeep, before: dupeOpened }
    )
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

  // 148.  The bin used to be a list of names: the only way to see one of
  //  those papers was to restore it first and go find it in five thousand.
  //  The rows are the same .trash-row the duplicate group uses, and that
  //  group gained an open press in 147 — leaving the bin inert would be the
  //  same bug in the other half of the same class.
  //
  //  Whether this account has anything in its bin is not the run's to
  //  decide, and an assertion that quietly does nothing on an empty bin is
  //  the 146 lesson all over again.  So the client's trash read is given
  //  papers of its own.  The real trash:list handler still runs — including
  //  the title-based pass that attaches local PDF paths — so this also
  //  checks the one thing that makes "open PDF" possible for a record that
  //  is no longer in the library at all.
  const trashLib = loadLibrary()
  const trashPdfDoc = trashLib?.docs.find((d) => d.localPdf)
  if (!trashPdfDoc) {
    expect('the bin has a paper with a local file to open', false, {
      why: 'no library document carries localPdf; the 148 fixture cannot be built'
    })
  } else {
    const aId = 'smoke-trash-with-pdf'
    const cId = 'smoke-trash-bare-record'
    const bId = 'smoke-trash-without-pdf'
    const fixture: Doc[] = [
      // A keeps its path, so "clicking opens a PDF" does not depend on the
      // title matcher happening to agree.
      { ...trashPdfDoc, id: aId },
      // C comes back bare, the way a cloud trash record does.  Whether the
      // handler puts a path back on it is the assertion below.
      (() => {
        const bare: Doc = { ...trashPdfDoc, id: cId }
        delete bare.localPdf
        return bare
      })(),
      {
        id: bId,
        title: 'ZZZ 冒烟用：回收站里没有本地文件的那篇 ZZZ',
        authors: [{ last_name: 'Smoke' }],
        year: 1999
      }
    ]
    const trashClient = ensureClient()
    const original = {
      list: trashClient.listTrash,
      restore: trashClient.restoreDocument,
      purge: trashClient.purgeDocument
    }
    trashClient.listTrash = async () => fixture.map((d) => ({ ...d }))
    trashClient.restoreDocument = async (id: string) => ({ id } as Doc)
    trashClient.purgeDocument = async () => undefined
    try {
      await openMenu('更多')
      await new Promise((r) => setTimeout(r, 300))
      // openMenu toggles; a menu left open by an earlier press would leave
      // clickMenu with nothing to press and the whole block would time out
      let menuHere = await w.webContents.executeJavaScript(
        '!!document.querySelector(".menu-pop .menu-item")'
      )
      if (!menuHere) {
        await openMenu('更多')
        await new Promise((r) => setTimeout(r, 300))
        menuHere = await w.webContents.executeJavaScript(
          '!!document.querySelector(".menu-pop .menu-item")'
        )
      }
      log('menu for 回收站', menuHere)
      log('click 回收站', await clickMenu('回收站'))
      const binReady = await until(
        '(document.querySelectorAll(".trash-list .trash-row").length===3?"yes":"no")',
        (v) => v === 'yes',
        10000
      )
      const binInfo = () =>
        w.webContents.executeJavaScript(
          'JSON.stringify({'
          + 'rows:[...document.querySelectorAll(".trash-list .trash-row")]'
          + '.map(r=>({id:r.dataset.id||"",n:(r.querySelector(".n")||{}).textContent||""})),'
          + 'open:[...document.querySelectorAll(".trash-list .trash-row.open")].map(r=>r.dataset.id||""),'
          + 'head:(document.querySelector(".pane-mid .pane-head")||{}).textContent||"",'
          + 'pdf:!!document.querySelector(".pane-right .pdf-bar input"),'
          + 'trashDoc:!!document.querySelector(".pane-right .trash-doc"),'
          + 'banner:(document.querySelector(".pane-right .trash-doc-banner")||{}).textContent||null,'
          + 'editable:[...document.querySelectorAll(".pane-right .meta-actions button")]'
          + '.some(b=>b.textContent.trim()==="移入回收站"),'
          + 'empty:(document.querySelector(".pane-right .empty")||{}).textContent||null})'
        )
      const t0 = JSON.parse(await binInfo())
      log('the bin as given', { binReady, ...t0 })
      expect(
        'the bin lists the papers it was given',
        binReady === 'yes' &&
          t0.rows.length === 3 &&
          [aId, cId, bId].every((id) => t0.rows.some((r: { id: string }) => r.id === id)) &&
          /3\s*\/\s*3/.test(t0.head),
        { binReady, rows: t0.rows, head: t0.head }
      )
      const rowN = (info: { rows: { id: string; n: string }[] }, id: string) =>
        (info.rows.find((r) => r.id === id)?.n ?? '')
      expect(
        'a bare trashed record is matched back to its local PDF',
        rowN(t0, cId).includes('有PDF') && rowN(t0, bId).includes('无PDF'),
        { bare: rowN(t0, cId), none: rowN(t0, bId) }
      )
      // The row with a file opens as a PDF.  Which paper opened is read off
      // the row that claims to be open, the same way 147 reads it: the pane
      // shows pages or fields and neither names the paper in a way this run
      // can compare against a row.
      await w.webContents.executeJavaScript(
        `(()=>{const r=document.querySelector('.trash-list .trash-row[data-id=${JSON.stringify(aId)}]');if(r)r.click();return 1})()`
      )
      await until(
        '(document.querySelector(".pane-right .pdf-bar input")?"yes":"no")',
        (v) => v === 'yes',
        10000
      )
      const tPdf = JSON.parse(await binInfo())
      log('opened the row with a file', tPdf)
      expect(
        'a row in the bin opens that paper as a PDF',
        tPdf.open.length === 1 &&
          tPdf.open[0] === aId &&
          tPdf.pdf === true &&
          tPdf.empty === null &&
          tPdf.trashDoc === false,
        tPdf
      )
      // A record with no file falls to the read-only view rather than an
      // empty reader.  The editing form must not be handed a document that
      // is not in the library: its 移入回收站 button would be a
      // contradiction and its saves would PATCH a document that is gone.
      await w.webContents.executeJavaScript(
        `(()=>{const r=document.querySelector('.trash-list .trash-row[data-id=${JSON.stringify(bId)}]');if(r)r.click();return 1})()`
      )
      await new Promise((r) => setTimeout(r, 900))
      const tDetails = JSON.parse(await binInfo())
      log('opened the row without a file', tDetails)
      expect(
        'a row with no local file opens the read-only details',
        tDetails.open.length === 1 &&
          tDetails.open[0] === bId &&
          tDetails.trashDoc === true &&
          /回收站/.test(tDetails.banner ?? '') &&
          tDetails.editable === false &&
          tDetails.empty === null,
        tDetails
      )
      // Both buttons live inside a row that now opens a paper.  Pressing one
      // must not move the right pane off whichever paper was being read:
      // 147 learned this with 设为保留, and the bin has two of them.
      await w.webContents.executeJavaScript(
        `(()=>{const r=document.querySelector('.trash-list .trash-row[data-id=${JSON.stringify(aId)}]');`
        + 'if(!r)return 0;const b=[...r.querySelectorAll("button")]'
        + '.find(x=>x.textContent.trim()==="彻底删除");if(!b)return 0;b.click();return 1})()'
      )
      await new Promise((r) => setTimeout(r, 700))
      const tAsk = JSON.parse(
        await w.webContents.executeJavaScript(
          'JSON.stringify({modal:!!document.querySelector(".confirm-modal"),'
          + 'text:(document.querySelector(".confirm-modal")||{}).textContent||null,'
          + 'open:[...document.querySelectorAll(".trash-list .trash-row.open")].map(r=>r.dataset.id||"")})'
        )
      )
      log('彻底删除 pressed inside a row', tAsk)
      expect(
        'pressing 彻底删除 asks first and does not switch papers',
        tAsk.modal === true && /不可恢复/.test(tAsk.text ?? '') &&
          tAsk.open.length === 1 && tAsk.open[0] === bId,
        tAsk
      )
      await w.webContents.executeJavaScript(
        '(()=>{const b=[...document.querySelectorAll(".modal-acts button")]'
        + '.find(x=>x.textContent.trim()==="取消");if(b)b.click();return 1})()'
      )
      await new Promise((r) => setTimeout(r, 500))
      await w.webContents.executeJavaScript(
        `(()=>{const r=document.querySelector('.trash-list .trash-row[data-id=${JSON.stringify(aId)}]');`
        + 'if(!r)return 0;const b=[...r.querySelectorAll("button")]'
        + '.find(x=>x.textContent.trim()==="恢复");if(!b)return 0;b.click();return 1})()'
      )
      await new Promise((r) => setTimeout(r, 900))
      const tRestored = JSON.parse(await binInfo())
      log('恢复 pressed inside a row', tRestored)
      expect(
        'pressing 恢复 does not switch papers either',
        tRestored.rows.length === 2 &&
          !tRestored.rows.some((r: { id: string }) => r.id === aId) &&
          tRestored.open.length === 1 &&
          tRestored.open[0] === bId,
        tRestored
      )
    } finally {
      trashClient.listTrash = original.list
      trashClient.restoreDocument = original.restore
      trashClient.purgeDocument = original.purge
    }
    await w.webContents.executeJavaScript(
      '(()=>{const b=[...document.querySelectorAll(".pane-head button")]'
      + '.find(x=>x.textContent.trim()==="返回库");if(b)b.click();return 1})()'
    )
    await new Promise((r) => setTimeout(r, 400))
  }

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

  // A blank click is the way out of a selection, and a row click must not be
  // mistaken for one. Everything here is put back at the end so the settings
  // checks that follow start from the row that was selected before (177).
  const blankClick = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>{'
      + 'const wait=(m)=>new Promise(r=>setTimeout(r,m));'
      + 'const wrap=document.querySelector(".table-wrap");'
      + 'if(!wrap)return JSON.stringify({error:"no table wrap"});'
      + 'const rows=()=>[...document.querySelectorAll("div.row")];'
      + 'const before=(document.querySelector("div.row.sel")||{}).dataset?.id||"";'
      + 'if(!rows().length)return JSON.stringify({error:"no rows"});'
      + 'rows()[0].click();await wait(400);'
      + 'const picked={sel:document.querySelectorAll("div.row.sel").length,'
      + 'bar:!!document.querySelector(".batch-bar")};'
      + 'wrap.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));'
      + 'await wait(400);'
      + 'const blanked={sel:document.querySelectorAll("div.row.sel").length,'
      + 'multi:document.querySelectorAll("div.row.multi").length,'
      + 'bar:!!document.querySelector(".batch-bar"),'
      + 'empty:(document.body.innerText.match(/选中左侧一条文献查看详情或 PDF/)||[])[0]||""};'
      + 'rows()[0].click();await wait(400);'
      + 'const onRow={sel:document.querySelectorAll("div.row.sel").length};'
      + 'const second=rows()[1];'
      + 'if(second)second.dispatchEvent(new MouseEvent("click",{bubbles:true,shiftKey:true}));'
      + 'await wait(400);'
      + 'const multiBefore=document.querySelectorAll("div.row.multi").length;'
      + 'wrap.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));'
      + 'await wait(400);'
      + 'const blankedAfterMulti={sel:document.querySelectorAll("div.row.sel").length,'
      + 'multi:document.querySelectorAll("div.row.multi").length};'
      + 'const restore=(before?rows().find(r=>(r.dataset.id||"")===before):null)||rows()[0];'
      + 'if(restore)restore.click();await wait(400);'
      + 'return JSON.stringify({before,picked,blanked,onRow,multiBefore,'
      + 'blankedAfterMulti,restored:!!restore})})()'
    )
  )
  log('blank click in the table', blankClick)
  expect(
    'a click on blank space drops the single selection and empties the pane',
    blankClick.error === undefined &&
      blankClick.picked?.sel === 1 &&
      blankClick.blanked?.sel === 0 &&
      blankClick.blanked?.bar === false &&
      /选中左侧一条文献查看详情或 PDF/.test(blankClick.blanked?.empty ?? ''),
    blankClick
  )
  expect(
    'a click on a row is not mistaken for blank space',
    blankClick.onRow?.sel === 1,
    { onRow: blankClick.onRow }
  )
  expect(
    'a blank click also drops a multi-selection',
    blankClick.multiBefore >= 2 &&
      blankClick.blankedAfterMulti?.sel === 0 &&
      blankClick.blankedAfterMulti?.multi === 0,
    { multiBefore: blankClick.multiBefore, after: blankClick.blankedAfterMulti }
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
  // 设置 is a menu now, so the panel is two presses away: the button opens
  // the menu and the first item opens the panel.  A check that still pressed
  // the button once would find no panel and report it as a bug in the panel.
  log('click 设置', await openMenu('设置'))
  await new Promise((r) => setTimeout(r, 300))
  log('click 设置…', await clickMenu('设置…'))
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
  // Raising the budget throws away the index that was read for the old one,
  // and for a long time the panel said an update had changed how the index is
  // stored.  Those are not the same event and only one of them is something
  // the reader did: told an update ate their six-minute build they go looking
  // for a version to roll back, when what is wanted is a number put back.
  // Both numbers are asked for, because "the range changed" is a claim and
  // "3 → 5" is something to look at.
  const voidedStat = JSON.parse(
    await w.webContents.executeJavaScript(
      '(async()=>JSON.stringify(await window.api.ftStatus()))()'
    )
  )
  log('index after the budget changed', {
    legacy: voidedStat.legacy,
    voided: voidedStat.voided,
    voidedPages: voidedStat.voidedPages,
    pages: voidedStat.pages
  })
  expect(
    'a budget the reader changed is not blamed on an update',
    voidedStat.legacy === true &&
      voidedStat.voided === 'budget' &&
      voidedStat.voidedPages > 0 &&
      voidedStat.voidedPages !== voidedStat.pages,
    voidedStat
  )
  // put it back the way it was, so the next run starts from the same place
  await w.webContents.executeJavaScript(
    `window.api.setConfig({ftPages:${JSON.parse(cfgBefore).ftPages ?? 3}})`
  )
  await new Promise((r) => setTimeout(r, 400))
  // 171. The pure rule is checked above; this is the same claim at the
  // window: an over-budget value has to be written back into the field, not
  // just into the config. The old sheet kept showing the number typed.
  await w.webContents.executeJavaScript(
    '(()=>{const m=document.querySelector(".settings");'
    + 'const inp=[...m.querySelectorAll("input")].find(i=>i.type!=="checkbox");if(!inp)return 0;'
    + 'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(inp,"999");inp.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return 1})()'
  )
  const clampedField = String(
    (await until(
      '(async()=>{const m=document.querySelector(".settings");'
      + 'const inp=[...m.querySelectorAll("input")].find(i=>i.type!=="checkbox");'
      + 'const c=await window.api.getConfig();'
      + 'return JSON.stringify({shown:inp?inp.value:null,ftPages:c.ftPages??null})})()',
      (v) => {
        const s = String(v)
        return (
          s.includes('"shown":"' + FULL_TEXT_MAX_PAGES + '"') &&
          s.includes('"ftPages":' + FULL_TEXT_MAX_PAGES)
        )
      },
      8000
    )) ?? '{}'
  )
  log('field after committing an over-budget value', clampedField)
  expect(
    'an over-budget page count is written back into the field',
    clampedField.includes('"shown":"' + FULL_TEXT_MAX_PAGES + '"') &&
      clampedField.includes('"ftPages":' + FULL_TEXT_MAX_PAGES),
    clampedField
  )
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
  restoreSmokeConfig()

  if (fails.length) {
    log('FAILED CHECKS', fails.join(' | '))
    app.exit(1)
    return
  }
  log('all checks passed')
  app.exit(0)
}
