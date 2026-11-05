import { useCallback, useEffect, useRef, useState } from 'react'
import type * as pdfjs from 'pdfjs-dist'
import type { MutableRefObject } from 'react'
import type { FindHit, TextRun } from '../pdfgeom'
import { findInPage } from '../pdffind'
import {
  answerBusy,
  answerHits,
  createFindScan,
  type FindScan,
  type ScanAnswer
} from '../findScan'

/** One stable empty list. Deriving `findHits` must not hand a new array to the
 *  keyboard listener and the DOM dataset effects on every render. */
const NO_HITS: FindHit[] = []

/**
 * Finding a word in the open paper.
 *
 * The word, the hits it came back with, which of them the caret is on, and
 * whether the box is open at all.  It hangs together because all of it is
 * about one question — where in this paper does that word appear — and none
 * of it is about zooming, paging, marking or the cloud.
 *
 * Two ways in, and they behave differently on purpose.  The reader typing in
 * the box is answered by jumping to the first hit.  A term that came from the
 * library search is *not* allowed to move the reader: a hit in the list
 * carries its own page and the reader is already on it, so only the caret is
 * placed, on the first hit of the page being read.  That is what `hitQuery`
 * is for, and it is why the scan runs even while the box is shut.
 */
export function usePdfFind(o: {
  pdf: pdfjs.PDFDocumentProxy | null
  numPages: number
  pageRef: MutableRefObject<number>
  /** Identifies the open document; a new one throws the text away. */
  docKey: string | undefined | null
  /** The word the library was searched for, marked on the paper. */
  hitQuery?: string
  /** The pane the keyboard shortcuts belong to. */
  paneRef: MutableRefObject<HTMLDivElement | null>
  /** Bring page `n` into view, in whichever mode is on. */
  onJump: (n: number) => void
}) {
  const { pdf, numPages, pageRef, hitQuery, paneRef } = o

  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [answer, setAnswer] = useState<ScanAnswer<string, FindHit> | null>(null)
  const [findAt, setFindAt] = useState(0)

  /** Text runs of every page already pulled, so a second query never asks
   *  pdf.js for the same page twice.  Thrown away on a document change. */
  const textCache = useRef(new Map<number, TextRun[]>())
  const findInput = useRef<HTMLInputElement>(null)

  /** The word the answer belongs to. A lower-cased word, because that is what
   *  `findInPage` was asked about. */
  const key = findQ.trim().toLowerCase()
  const findHits = answerHits(answer, key) ?? NO_HITS
  const findBusy = answerBusy(answer, key)

  /** Built once, like `useUndo`'s stack: a scan is started from an effect and
   *  outlives it, so the controller must not close over a stale render. */
  const scan = useRef<FindScan<string, FindHit> | null>(null)
  const finishRef = useRef<(_q: string, _hits: FindHit[]) => void>(() => {})
  if (scan.current === null) {
    scan.current = createFindScan<string, FindHit>(setAnswer, (q, hits) =>
      finishRef.current(q, hits)
    )
  }

  useEffect(() => {
    textCache.current.clear()
    scan.current?.cancel()
    setFindQ('')
    setFindAt(0)
    setFindOpen(false)
  }, [o.docKey])

  /**
   * Whether the marks now on the page were put there by the search term below
   * rather than by the reader opening find and typing.
   *
   * It decides two things: whether the scan runs while the find box is shut,
   * and whether dropping the term is allowed to take the marks with it — a
   * find the reader asked for is theirs, and this must not wipe it.
   */
  const queryDriven = useRef(false)

  /** Shutting the box takes its marks with it: an orange box left on the page
   *  with nothing saying which word it belongs to is worse than none.
   *
   *  The cancel matters as much as the clearing. A scan still walking the
   *  pages used to survive this and, on its last page, call `setFindOpen(true)`
   *  — the box the reader had just closed popped back open with the old
   *  word's marks. */
  const closeFind = useCallback(() => {
    scan.current?.cancel()
    queryDriven.current = false
    setFindQ('')
    setFindAt(0)
    setFindOpen(false)
  }, [])

  /**
   * The word the library was searched for, marked on the paper.
   *
   * A hit in the list is a claim about the paper, and the paper is where the
   * reader has to be able to check it: without this, finding the word again
   * inside a thirty-page PDF is exactly the work the search was meant to save.
   * It is the same scan the find box runs, so there is still only one of them
   * and only one cache of page text.
   *
   * The box itself is opened by the scan, not here, and only when the word is
   * actually in *this* paper.  A term can match a title, an author or a tag
   * and appear nowhere in the text, and a box announcing no matches on every
   * click is worse than no box.
   */
  useEffect(() => {
    const q = (hitQuery ?? '').trim()
    if (q.length < 2) {
      if (!queryDriven.current) return
      closeFind()
      return
    }
    queryDriven.current = true
    setFindQ(q)
  }, [hitQuery, o.docKey, closeFind])

  /** Bring hit `i` on screen.  Takes the list explicitly so a scan can jump to
   *  its first hit before that list has reached React state. */
  const gotoHit = (i: number, list?: FindHit[]) => {
    const l = list ?? findHits
    if (!l.length) return
    const at = ((i % l.length) + l.length) % l.length
    setFindAt(at)
    const h = l[at]
    // the column has to be moved as well; the page box alone only labels the
    // page, it does not bring it into view
    o.onJump(h.page)
  }

  /** The last page of a walk decides whether the bar opens.  It lives in a ref
   *  because the controller is built once, while the page being read and the
   *  jump function belong to the current render. */
  finishRef.current = (_q, hits) => {
    if (!hits.length) return
    setFindOpen(true)
    // A term from the library search must not move the reader: a hit in the
    // list carries its own page, and the reader is already on it.  Only the
    // caret is placed, on the first hit of the page being read, so that the
    // count and the ↑ ↓ mean something from where the reader is standing.
    if (queryDriven.current) {
      const onThis = hits.findIndex((h) => h.page === pageRef.current)
      setFindAt(onThis >= 0 ? onThis : 0)
      return
    }
    gotoHit(0, hits)
  }

  /**
   * Walk every page.  Hits are published as they are found rather than at the
   * end, so a long paper reports its first matches while the rest is still
   * being read.  Every publish and the final `finish` go through the scan
   * handle, so a word that has been replaced cannot write again.
   */
  const runFind = useCallback(
    async (q: string) => {
      const needle = q.trim().toLowerCase()
      if (!pdf || needle.length < 2) {
        // No state write: the word in the box is now too short for the old
        // answer to match, which is already an empty, non-busy view.
        scan.current?.cancel()
        setFindAt(0)
        return
      }
      const s = scan.current!.start(needle)
      const all: FindHit[] = []
      for (let n = 1; n <= numPages; n++) {
        if (!s.alive()) return
        try {
          const hits = await findInPage(pdf, textCache.current, n, needle)
          if (!s.alive()) return
          if (hits.length) {
            all.push(...hits)
            s.publish([...all])
          }
        } catch {
          /* a page that will not give up its text costs a hit, not the scan */
        }
      }
      if (!s.alive()) return
      s.finish(all)
    },
    [pdf, numPages]
  )

  // a query is worth a scan once the typing pauses; 250ms is long enough that
  // a four-character word costs one scan rather than four.  The box being shut
  // does not stop it when the term came from the library search: that scan is
  // what puts the marks on the page, and it opens the box itself if there is
  // something to report.
  useEffect(() => {
    if (!findOpen && !queryDriven.current) return
    const t = setTimeout(() => runFind(findQ), 250)
    return () => {
      clearTimeout(t)
      // Clearing the timer only stops a scan that has not started.  One that
      // is already walking the pages has to be invalidated too: otherwise it
      // keeps publishing the old word's hits during these 250ms and, on its
      // last page, opens the bar for a word no longer in the box.
      scan.current?.cancel()
    }
    // `findOpen` is left out on purpose.  The scan is what opens the box when
    // the term came from the library search, so having the box's own state in
    // here would start a second walk of every page the moment the first one
    // finished.  What starts a scan is a new term or a new document, both of
    // which arrive through `findQ` and `runFind`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQ, runFind])

  // the keyboard listener is installed once per state change, so it reaches
  // the jump through a ref rather than closing over a stale one
  const gotoRef = useRef(gotoHit)
  gotoRef.current = gotoHit

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || !!t.isContentEditable)
      const mine = !!t && !!paneRef.current && paneRef.current.contains(t)

      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        // The library search owns Ctrl+F only while the caret is in it.  While
        // the user is reading, the same key has to mean "find in this PDF",
        // which is what every other reader does.
        if (typing && !mine) return
        e.preventDefault()
        e.stopPropagation()
        setFindOpen(true)
        requestAnimationFrame(() => {
          findInput.current?.focus()
          findInput.current?.select()
        })
        return
      }
      if (!findOpen) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeFind()
        return
      }
      // only the find box answers Enter: the note box has its own meaning for
      // it, and swallowing that would silently stop notes from saving
      if (e.key === 'F3' || (e.key === 'Enter' && t === findInput.current)) {
        e.preventDefault()
        gotoRef.current(findAt + (e.shiftKey ? -1 : 1))
      }
    }
    // Capture, because App installs the library-wide Ctrl+F on window first and
    // a bubble listener would always run after it.
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [findOpen, findAt, findHits, closeFind])

  // exposed so the smoke run can assert on a hit count without screenshotting.
  // The page count is the one that says the whole file was walked: a mark on
  // the page being read is what a single-page scan would leave too.
  useEffect(() => {
    const d = document.documentElement.dataset
    d.findHits = String(findHits.length)
    d.findPages = String(new Set(findHits.map((h) => h.page)).size)
    d.findPage = findHits.length ? String(findHits[findAt]?.page ?? '') : ''
  }, [findHits, findAt])

  return {
    findOpen,
    setFindOpen,
    findQ,
    setFindQ,
    findHits,
    findAt,
    setFindAt,
    findBusy,
    findInput,
    closeFind,
    gotoHit,
    runFind
  }
}
