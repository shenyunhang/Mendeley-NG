import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import {
  loadLibrary
} from './store'

import { setWin } from './window'
/**
 * `--perf` measures the same interactions the reader complains about, on the
 * real library, and prints the numbers.  It is how "it feels slow" becomes a
 * claim that can be checked: main-thread blocks (`longtask`) and dropped
 * frames (rAF intervals) are recorded while a specific thing is being done,
 * so a fix can be shown to have moved one of them.
 *
 * Nothing here fails the run.  A threshold that the machine it is measured on
 * decides would start failing on somebody else's laptop, and what is wanted
 * is the number before and after, not a gate.
 */
export async function runPerf() {
  const log = (...a: unknown[]) => console.log('[perf]', ...a)
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const cached = loadLibrary()
  log('library', cached ? cached.docs.length + ' docs' : 'empty')

  // Shown, because a hidden window is not composited: Chromium throttles
  // requestAnimationFrame to about one frame a second in a window nobody can
  // see, and the frame intervals are then a measurement of the throttle
  // rather than of the app.  `showInactive` because this is a measurement
  // running on somebody's desktop and must not steal the focus from it.
  const w = new BrowserWindow({
    width: 1500,
    height: 950,
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
  w.showInactive()
  await wait(3000)

  const js = (s: string) => w.webContents.executeJavaScript(s)

  await js(
    '(()=>{'
    + 'window.__lt=[];window.__fr=[];'
    + 'try{new PerformanceObserver(l=>{for(const e of l.getEntries())'
    + 'window.__lt.push(Math.round(e.duration))}).observe({entryTypes:["longtask"]});'
    + 'window.__ltOk=true}catch(e){window.__ltOk=String(e)};'
    + 'let last=performance.now();'
    + 'const tick=()=>{const n=performance.now();window.__fr.push(n-last);last=n;'
    + 'requestAnimationFrame(tick)};requestAnimationFrame(tick);'
    + 'return 1})()'
  )
  log('probe', await js('JSON.stringify({lt:window.__ltOk})'))

  const reset = () => js('(()=>{window.__lt.length=0;window.__fr.length=0;return 1})()')
  /** Blocks, and frames long enough to be seen as a stutter.
   *
   *  The slow-frame threshold is twice the median rather than a fixed 50ms:
   *  this window is composited without a GPU, so its steady state is already
   *  around 30ms a frame.  What counts as a stutter is a frame that stands
   *  out from *this* run's own rhythm. */
  const read = async () => {
    const r = JSON.parse(
      await js(
        'JSON.stringify({lt:window.__lt,fr:window.__fr.map(x=>Math.round(x))})'
      )
    ) as { lt: number[]; fr: number[] }
    const sorted = [...r.fr].sort((a, b) => a - b)
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
    return {
      blocks: r.lt.length,
      blockedMs: r.lt.reduce((a, b) => a + b, 0),
      worstBlock: r.lt.length ? Math.max(...r.lt) : 0,
      medianFrame: median,
      slowFrames: r.fr.filter((x) => x > median * 2).length,
      worstFrame: r.fr.length ? Math.max(...r.fr) : 0
    }
  }
  const report = async (what: string) => {
    const r = await read()
    log(what, r)
    return r
  }
  const setInput = (sel: string, v: string) =>
    js(
      `(()=>{const i=document.querySelector(${JSON.stringify(sel)});if(!i)return 0;`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
      + `set.call(i,${JSON.stringify(v)});`
      + `i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`
    )
  const rows = () => js('document.querySelectorAll(".row,.res-row").length')
  log('rows at rest', await rows())

  /**
   * How long one keystroke costs, measured as the time the event itself takes
   * to return.
   *
   * React flushes a discrete event like `input` before it hands control back,
   * so by the time `dispatchEvent` returns, everything the keystroke caused
   * has been computed and written to the DOM: the filter, the sort, the
   * counting for the switches, the cards.  It is a far finer instrument than
   * `longtask`, whose 50ms floor reports every keystroke as zero once the
   * work has been spread thin enough.
   */
  const timeInput = async (sel: string, v: string) => {
    const ms = await js(
      `(()=>{const i=document.querySelector(${JSON.stringify(sel)});if(!i)return -1;`
      + `const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;`
      + `const t0=performance.now();`
      + `set.call(i,${JSON.stringify(v)});`
      + `i.dispatchEvent(new Event("input",{bubbles:true}));`
      + `return Math.round((performance.now()-t0)*10)/10})()`
    )
    return Number(ms)
  }

  // -- typing one word into the search box, one character at a time.  What
  //    it costs is what every keystroke costs, and the box is where the
  //    reader spends their time.
  //
  //    Three words are typed, differing only in how many papers they leave,
  //    which is what separates the two suspects: scanning the whole library
  //    (the same 5,600 documents whatever the word is) from building the
  //    cards (one per paper the word left).  A word that matches nothing
  //    still pays for the first and pays nothing for the second.
  const type = async (word: string) => {
    await reset()
    const per: number[] = []
    for (let n = 1; n <= word.length; n++) {
      per.push(await timeInput('.toolbar input', word.slice(0, n)))
      await wait(220)
    }
    await wait(1200)
    const left = await js('document.querySelectorAll(".res-row").length')
    return {
      left,
      msPerKey: per,
      worstKey: Math.max(...per),
      ...(await report(`typing "${word}"`))
    }
  }
  const typingNone = await type('zzzzqqq')
  const typingSome = await type('network')
  const typingMany = await type('e')
  await setInput('.toolbar input', '')
  await wait(1200)

  // -- clearing it again: the list goes back to every document at once
  await reset()
  await setInput('.toolbar input', '')
  await wait(1500)
  const clearing = await report('clearing the search')

  // -- opening a paper with a PDF: pdf.js, the text layer, the overlays
  await reset()
  // A row that actually has a PDF, which is not the first row: the dot is
  // dimmed on a paper whose file is not here, and opening one of those is a
  // measurement of the details pane, not of the reader.
  const picked = await js(
    '(()=>{const r=[...document.querySelectorAll(".row,.res-row")]'
    + '.find(x=>x.querySelector(".pdf-dot:not(.no-pdf)"));'
    + 'if(!r)return 0;'
    + 'r.dispatchEvent(new MouseEvent("click",{bubbles:true}));return 1})()'
  )
  await wait(2500)
  const opening = await report(
    'opening a paper' + (Number(picked) === 1 ? '' : ' (nothing to click)')
  )

  // -- scrolling the list: the virtualiser has to keep up with the wheel.
  //    Three rounds rather than one, because the first carries the cost of
  //    laying out rows that have never been drawn and says nothing about
  //    whether scrolling *stays* smooth once they have.
  //    One frame per step, which is what a wheel does.  Twenty steps in a
  //    tight loop is a different measurement: the browser coalesces them into
  //    a single frame that has to draw twenty screens' worth of new rows, and
  //    what it reports is a batch no reader ever asks for.
  const scrollOnce = () =>
    js(
      '(async()=>{const el=document.querySelector(".table-wrap,.res-wrap");if(!el)return 0;'
      + 'for(let i=0;i<30;i++){el.scrollTop+=100;'
      + 'el.dispatchEvent(new Event("scroll",{bubbles:true}));'
      + 'await new Promise(r=>requestAnimationFrame(r))}return 1})()'
    )
  const rounds: Record<string, unknown> = {}
  await js('(()=>{const el=document.querySelector(".table-wrap,.res-wrap");'
    + 'if(el)el.scrollTop=0;return 1})()')
  for (const n of [1, 2, 3]) {
    await reset()
    await scrollOnce()
    await wait(1200)
    rounds['scroll' + n] = await report('scrolling the list, round ' + n)
  }
  const scrolling = rounds
  await js('(()=>{const el=document.querySelector(".table-wrap,.res-wrap");'
    + 'if(el)el.scrollTop=0;return 1})()')
  await wait(600)

  // -- re-sorting what is listed: every row is re-decided at once
  await reset()
  await js(
    '(()=>{const c=[...document.querySelectorAll(".col-head [data-col]")]'
    + '.find(x=>x.textContent.includes("年份"));if(!c)return 0;c.click();return 1})()'
  )
  await wait(1500)
  const sorting = await report('re-sorting the list')

  // -- clicking through rows: one row changes, the rest must not
  await reset()
  await js(
    '(()=>{const rs=[...document.querySelectorAll(".row,.res-row")].slice(0,10);'
    + 'for(const r of rs)r.dispatchEvent(new MouseEvent("click",{bubbles:true}));'
    + 'return rs.length})()'
  )
  await wait(1500)
  const selecting = await report('clicking ten rows')

  // -- what a result card actually says.  Kept because "the card stopped
  //    naming the field" is a regression that no timing figure will show.
  await setInput('.toolbar input', 'zhang')
  await wait(1200)
  log(
    'cards for "zhang"',
    await js(
      'JSON.stringify({cards:document.querySelectorAll(".res-row").length,'
      + 'labels:[...document.querySelectorAll(".res-row .res-label")].slice(0,6)'
      + '.map(e=>e.textContent),'
      + 'marks:document.querySelectorAll(".res-row mark").length,'
      + 'first:(document.querySelector(".res-row")||{}).innerText||null})'
    )
  )
  await setInput('.toolbar input', '')
  await wait(800)

  // -- turning pages in the PDF that is open, one page at a time
  const hasPdf = await js('document.querySelectorAll(".pdf-bar").length ? 1 : 0')
  let paging: Record<string, unknown> = { skipped: 'no PDF open' }
  if (Number(hasPdf) === 1) {
    await reset()
    for (const n of [3, 4, 5, 6, 7, 8, 9, 10]) {
      await setInput('.pdf-bar input', String(n))
      await wait(400)
    }
    await wait(1200)
    paging = await report('turning eight pages')
  }

  // -- selecting everything: the multi-selection is an array, and every row
  //    asks whether it is in it
  await reset()
  await js(
    '(()=>{document.dispatchEvent(new KeyboardEvent("keydown",'
    + '{key:"a",ctrlKey:true,bubbles:true}));'
    + 'window.dispatchEvent(new KeyboardEvent("keydown",'
    + '{key:"a",ctrlKey:true,bubbles:true}));return 1})()'
  )
  await wait(1500)
  const pickedAll = await js('document.querySelectorAll(".multi").length')
  const selectAll = await report('selecting every paper (' + pickedAll + ' marked)')
  await js(
    '(()=>{window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));'
    + 'return 1})()'
  )
  await wait(600)

  log('summary', {
    typingNone,
    typingSome,
    typingMany,
    clearing,
    opening,
    paging,
    scrolling,
    sorting,
    selecting,
    selectAll
  })
  app.exit(0)
}
