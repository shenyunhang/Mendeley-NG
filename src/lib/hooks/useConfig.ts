import { useCallback, useEffect, useRef, useState } from 'react'
import type { SavedSearch, SavedView } from '../../../shared/types'
import { DEFAULT_FT_PAGES, DEFAULT_PDF_TEMPLATE } from '../../../shared/types'
import {
  DEFAULT_SORT,
  migrateCols,
  normaliseSort,
  type ColKey,
  type SortKey
} from '../columns'
import { DEFAULT_CITE_STYLE, isCiteStyle, type CiteStyle } from '../cite'
import {
  DEFAULT_LEFT_W,
  DEFAULT_RIGHT_PCT,
  clampLeft,
  clampRight
} from '../panes'

/**
 * Everything that is written to disk and read back at startup.
 *
 * One hook, because the whole point of these values is that they survive the
 * app: the columns the reader laid out, the sort they pressed into, the pane
 * they dragged, the theme and the type size.  They have no behaviour in
 * common beyond that — they do not move together and nothing derives one from
 * another — so the hook is a bag of state and setters and stays honest about
 * being one rather than pretending to be a model.
 *
 * Writing is not centralised on purpose.  Each caller writes the one key it
 * changed (`setConfig({ sort: next })`), which is a file write of one line
 * rather than of the whole object, and which cannot clobber a key another
 * part of the app changed a moment earlier.  A `save()` that wrote everything
 * from a snapshot would be simpler to call and would quietly undo the last
 * thing the reader did somewhere else.
 *
 * The setters are handed out rather than wrapped for the same reason: the
 * handlers in `App` each have their own idea of which keys a change touches,
 * and a hook that guessed would be wrong half the time.
 */
export function useConfig() {
  const [pdfDir, setPdfDir] = useState('')
  const [saved, setSaved] = useState<SavedSearch[]>([])
  const [views, setViews] = useState<SavedView[]>([])
  const [cols, setCols] = useState<ColKey[]>(() => migrateCols(undefined))
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>(DEFAULT_SORT)
  // widths the reader has dragged to; empty until something is dragged, so a
  // column that was never touched keeps the track its definition gives it
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [nameTemplate, setNameTemplate] = useState(DEFAULT_PDF_TEMPLATE)
  const [citeStyle, setCiteStyle] = useState<CiteStyle>(DEFAULT_CITE_STYLE)
  const [dupeIgnores, setDupeIgnores] = useState<string[][]>([])
  const [syncOnStart, setSyncOnStart] = useState(true)
  const [ftPages, setFtPages] = useState(DEFAULT_FT_PAGES)
  /**
   * Pane widths.  The folder tree is a fixed width, because a tree does not
   * get wider when the window does; the reader is a share of the window,
   * because that is exactly what it should follow.  Both are remembered.
   */
  const [leftW, setLeftW] = useState(DEFAULT_LEFT_W)
  const [rightPct, setRightPct] = useState(DEFAULT_RIGHT_PCT)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [fontSize, setFontSize] = useState(15)
  /**
   * The type size as a ref as well as state.  The keyboard handler is
   * installed once, so stepping from 15 to 16 has to read the size it is
   * stepping from somewhere that is not a stale closure.
   */
  const fontRef = useRef(15)

  useEffect(() => {
    window.api.getConfig().then((c) => {
      setPdfDir(c.pdfDir)
      setSaved(c.savedSearches ?? [])
      setViews(c.views ?? [])
      setCols(migrateCols(c.cols))
      // how the reader left the list is part of how they read it; going back
      // to newest-first on every start undid the one press that matters most
      // right after opening the app
      setSort(normaliseSort(c.sort))
      if (c.colWidths) setColWidths(c.colWidths)
      if (c.pdfNameTemplate) setNameTemplate(c.pdfNameTemplate)
      if (isCiteStyle(c.citeStyle)) setCiteStyle(c.citeStyle)
      // entries with fewer than two papers are not a group and cannot have
      // been one: the filter also throws away anything a hand edited into the
      // file, which is better than carrying it into a comparison that would
      // then never match
      setDupeIgnores((c.dupeIgnores ?? []).filter((e) => Array.isArray(e) && e.length > 1))
      // on unless it was switched off: a library that is only refreshed when
      // somebody remembers to press the button is a library that is stale by
      // whatever was done on the other machine
      setSyncOnStart(c.syncOnStart !== false)
      if (typeof c.ftPages === 'number' && c.ftPages > 0) setFtPages(c.ftPages)
      if (typeof c.paneLeft === 'number') setLeftW(clampLeft(c.paneLeft))
      if (typeof c.paneRight === 'number') setRightPct(clampRight(c.paneRight))
      setTheme(c.theme === 'light' ? 'light' : 'dark')
      if (c.fontSize) {
        fontRef.current = c.fontSize
        setFontSize(c.fontSize)
      }
    })
  }, [])

  // one knob scales the whole UI, because every size in styles.css is in rem
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-fs', fontSize + 'px')
  }, [fontSize])

  // the palette is picked entirely by this attribute, including native
  // scrollbars and form controls through color-scheme
  useEffect(() => {
    if (theme === 'light') document.documentElement.dataset.theme = 'light'
    else delete document.documentElement.dataset.theme
  }, [theme])

  const bumpFont = useCallback((d: number) => {
    const next = Math.min(24, Math.max(11, fontRef.current + d))
    fontRef.current = next
    setFontSize(next)
    window.api.setConfig({ fontSize: next })
  }, [])

  return {
    pdfDir,
    setPdfDir,
    saved,
    setSaved,
    views,
    setViews,
    cols,
    setCols,
    sort,
    setSort,
    colWidths,
    setColWidths,
    nameTemplate,
    setNameTemplate,
    citeStyle,
    setCiteStyle,
    dupeIgnores,
    setDupeIgnores,
    syncOnStart,
    setSyncOnStart,
    ftPages,
    setFtPages,
    leftW,
    setLeftW,
    rightPct,
    setRightPct,
    theme,
    setTheme,
    fontSize,
    setFontSize,
    bumpFont
  }
}
