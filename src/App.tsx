import { clampToRange } from '../shared/clamp'
import { ignoreFailure, reportFailure, FAILURE } from '../shared/failures'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Annotation,
  Doc,
  SavedSearch,
  SavedView,
  UpdateState
} from '../shared/types'
import { DEFAULT_PDF_TEMPLATE } from '../shared/types'
import { clampFullTextPages } from '../shared/fullTextPages'
import { folderForOpenedDoc } from './lib/folderForDoc'
import { createBatchGate } from './lib/batchGate'
import { savedSearchMatches } from './lib/savedSearch'
import { createViewGeneration } from './lib/viewGeneration'
import FolderTree from './components/FolderTree'
import TrashView from './components/TrashView'
import TrashedDocPanel from './components/TrashedDocPanel'
import DupesView from './components/DupesView'
import ImportView from './components/ImportView'
import AddByIdView from './components/AddByIdView'
import AskDialog from './components/AskDialog'
import ConfirmDialog from './components/ConfirmDialog'
import DocTable from './components/DocTable'
import SearchResults from './components/SearchResults'
import MenuButton from './components/MenuButton'
import FullTextView from './components/FullTextView'
import {
  SORT_DEFAULT_DIR,
  TITLE_ORDER,
  normaliseCols,
  sortValue,
  type ColKey,
  type SortKey
} from './lib/columns'
import { DEFAULT_LEFT_W, DEFAULT_RIGHT_PCT } from './lib/panes'
import {
  ALL_HAVE_PDF_MESSAGE_VISIBLE_MS,
  BATCH_CLEAN_MESSAGE_VISIBLE_MS,
  BATCH_FAILED_MESSAGE_VISIBLE_MS,
  CITATION_COPIED_MESSAGE_VISIBLE_MS,
  COLUMN_WIDTH_PERSIST_DEBOUNCE_MS,
  DOWNLOAD_STOPPED_MESSAGE_VISIBLE_MS,
  FOLDER_NOOP_MESSAGE_VISIBLE_MS,
  IMPORT_FINISHED_MESSAGE_VISIBLE_MS,
  RENAME_RESULT_MESSAGE_VISIBLE_MS,
  STARTUP_UPDATE_CHECK_DELAY_MS,
  UPDATE_INSTALL_DELAY_MS
} from './lib/timing'
import {
  FILTER_LABEL,
  FILTER_TEST,
  LIST_FILTERS,
  type ListFilter
} from './lib/filters'
import { formatCitation, isCiteStyle, type CiteStyle } from './lib/cite'
import DetailsPanel from './components/DetailsPanel'
import PdfViewer from './components/PdfViewer'
import RowMenu, { type RowMenuItem } from './components/RowMenu'
import NotesView from './components/NotesView'
import BatchEdit, { type BatchOp } from './components/BatchEdit'
import Settings from './components/Settings'
import SetupGuide from './components/SetupGuide'
import Splitter from './components/Splitter'
import Toolbar from './components/Toolbar'
import { extractIds } from './lib/pdfmeta'
import { buildTree, byName } from './lib/tree'
import { docForRef, docForUrl, idIndex } from './lib/refly'
import { useConfig } from './lib/hooks/useConfig'
import { useFullText } from './lib/hooks/useFullText'
import { useUndo } from './lib/hooks/useUndo'
import { useLibrary } from './lib/hooks/useLibrary'
import { useSelection } from './lib/hooks/useSelection'
import { usePaneWidths } from './lib/hooks/usePaneWidths'
import { usePersistAfterMount } from './lib/hooks/usePersistAfterMount'
import { setConfigWriteReporter, writeConfig } from './lib/configWrite'
import { useExport } from './lib/hooks/useExport'
import { useFlashMessage } from './lib/hooks/useFlashMessage'
import { LIBRARY, type View } from './lib/view'


/**
 * Everything the search box looks at, in one lower-cased string.  Shared
 * with saved searches so a saved filter matches exactly what it saved.
 *
 * It covers what a reader actually remembers about a paper: the abstract
 * they read, the tag they gave it, the note they wrote.  Searching only
 * title / authors / journal / key / doi meant a paper could not be found by
 * anything the user themselves had entered, which is the source of "I know
 * I wrote something about this".
 */
function hay(d: Doc, note?: string): string {
  return [
    d.title,
    d.source,
    d.citation_key,
    d.doi,
    d.abstract,
    d.type,
    (d.authors ?? []).map((a) => `${a.first_name ?? ''} ${a.last_name ?? ''}`).join(' '),
    (d.keywords ?? []).join(' '),
    (d.tags ?? []).join(' '),
    note ?? ''
  ]
    .join(' ')
    .toLowerCase()
}

export default function App() {
  const [folderId, setFolderId] = useState<string | null>(null)
  /**
   * F2 asks for the rename box on the selected folder.  The counter is what
   * makes a second press a second request: with the id alone, pressing F2
   * again after dismissing the box would leave the state unchanged and the
   * box would not come back.
   */
  const [renameReq, setRenameReq] = useState<{ id: string; n: number } | null>(null)
  const [query, setQuery] = useState('')
  const { selId, setSelId, pinned, setPinned, multi, setMulti, lastIdx } = useSelection()
  const [rightTab, setRightTab] = useState<'pdf' | 'details'>('details')
  const [err, setErr] = useState<string | null>(null)
  const [upd, setUpd] = useState<UpdateState | null>(null)
  // What the middle of the window is.  Six separate pieces of state used to
  // decide that between them, and the one that was non-null won, which meant
  // every new screen had to be slotted into a chain of ternaries and given a
  // precedence against screens it had nothing to do with.  See lib/view.ts.
  const [view, setView] = useState<View>(LIBRARY)
  /** An async open (trash / notes) must not drag the reader back to a view
   *  they have already left. Checked against the view that was on screen
   *  when the request started, not against a stale closure. */
  const viewRef = useRef(createViewGeneration(view.kind))
  viewRef.current.set(view.kind)
  // first, because the library decides whether to start a sync on from
  // `syncOnStart` and cannot be asked twice
  const {
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
    syncPdfsOnSync,
    setSyncPdfsOnSync,
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
    bumpFont,
    configHydrated
  } = useConfig()
  const {
    lib,
    setLib,
    folders,
    setFolders,
    status,
    busy,
    hasToken,
    version,
    sync: doSync,
    markToken
  } = useLibrary(syncOnStart, setErr)
  const [filters, setFilters] = useState<ListFilter[]>([])
  const toggleFilter = (k: ListFilter) =>
    setFilters((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]))
  // Which card the toolbar has open lives here even though only the toolbar
  // draws them: Esc closes one layer per press, in a fixed order that runs
  // from the settings sheet down to the selection, and a row that dismissed
  // its own card without knowing what was above it would close two at once.
  const [showFilters, setShowFilters] = useState(false)
  const [showSort, setShowSort] = useState(false)
  const [showCols, setShowCols] = useState(false)
  const [activeSearch, setActiveSearch] = useState<string | null>(null)
  const [ask, setAsk] = useState<{
    title: string
    initial: string
    onOk: (v: string) => void
  } | null>(null)
  /**
   * One confirmation box for the whole app, served through a promise so that
   * the caller reads the way it used to with `confirm()`:
   * `if (!(await confirm({ ... }))) return`.
   *
   * Every destructive action routes through it rather than through
   * `window.confirm`, which does not follow the theme, cannot say whether the
   * thing can be undone, and cannot be tested — the smoke run had to stub it
   * to always refuse, so the paths behind it were never exercised.
   */
  const [confirm, setConfirm] = useState<{
    title: string
    body?: string
    ok?: string
    cancel?: string
    resolve: (v: boolean) => void
  } | null>(null)
  const askConfirm = useCallback(
    (req: { title: string; body?: string; ok?: string; cancel?: string }) =>
      new Promise<boolean>((resolve) => setConfirm({ ...req, resolve })),
    []
  )
  /**
   * Whether a token has been found yet, or `null` while that is still being
   * asked.  Null is not the same as false: answering "no token" before the
   * question has come back would flash the guide at everyone on startup.
   */
  const [setupDone, setSetupDone] = useState(false)
  const {
    ftQuery,
    setFtQuery,
    ftHits,
    ftSearching,
    ftStat,
    setFtStat,
    build: buildIndex,
    cancel: cancelIndex,
    clear: clearIndex
    // the panel is searched only while it is the one on screen, and that is
    // the view's answer to give, not the search's
  } = useFullText(view.kind === 'fulltext')
  /** Page to open the reader at.  The nonce re-triggers a jump to the same
   *  page on the same document, which a bare number could not. */
  const [jump, setJump] = useState<{ page: number; nonce: number } | null>(null)
  /** The open row menu, positioned where the right click landed. */
  const [menu, setMenu] = useState<{ x: number; y: number; docId: string } | null>(null)
  const [batchEdit, setBatchEdit] = useState(false)
  const [settings, setSettings] = useState(false)
  /** Which section the settings sheet opens on, when it is opened because
   *  something else named a setting rather than because 设置 was pressed. */
  const [setSec, setSetSec] = useState<string | null>(null)
  /** Local notes, kept here only so the search box can look inside them.
   *  They are written by the details panel, which reports back after saving. */
  const [noteMap, setNoteMap] = useState<Record<string, string>>({})
  /** Highlights and their notes, held only so the export menu can tell
   *  whether there is anything to carry.  The reader writes them on its own,
   *  so the export itself reads the store again instead of trusting this. */
  const [anns, setAnns] = useState<Annotation[]>([])
  const searchRef = useRef<HTMLInputElement>(null)
  // The two cards that hang off the bar are placed against these, not against
  // their own parents: the bar may scroll sideways, and a box that scrolls on
  // one axis clips on the other.
  // the keydown listener is installed once, so it has to reach the undo stack
  // through a ref rather than closing over a stale one
  /** Same reason, for the table navigation: the listener outlives every
   *  change to the filtered list it has to walk. */
  const navRef = useRef<{
    step: (d: number) => void
    edge: (end: boolean) => void
    open: () => void
    del: () => void
  }>({ step: () => {}, edge: () => {}, open: () => {}, del: () => {} })

  useEffect(() => {
    window.api.loadNotes().then((n) => setNoteMap(n ?? {})).catch((e) => ignoreFailure(FAILURE.notesOptional, e))
    window.api.loadAnnotations().then((a) => setAnns(a ?? [])).catch((e) => ignoreFailure(FAILURE.annotationCacheOptional, e))
    // Every preference write routes through writeConfig, which cannot reach
    // the error banner by itself.  Hand it the setter once, here.
    setConfigWriteReporter(setErr)
    const offUpd = window.api.onUpdateState(setUpd)
    return () => {
      setConfigWriteReporter(null)
      offUpd()
    }
  }, [])

  // the point of the feature: no second click. once the installer is on disk we
  // quit and let it run, and it relaunches the app when it finishes
  useEffect(() => {
    if (upd?.phase !== 'downloaded') return
    const t = setTimeout(() => window.api.installUpdate(), UPDATE_INSTALL_DELAY_MS)
    return () => clearTimeout(t)
  }, [upd?.phase])

  /** Opening the trash and switching the theme, named because the toolbar
   *  asks for them rather than doing them. */
  const openTrash = () => {
    const from = viewRef.current.read()
    setPinned(null)
    void window.api.listTrash().then((docs) => {
      if (!viewRef.current.still(from)) return
      setView({ kind: 'trash', docs })
    })
  }
  /** Both the bin row and the read-only panel can put a paper back or remove
   *  it for good.  One implementation, so the two cannot drift into asking
   *  different questions about the same destructive action. */
  const restoreTrashed = async (id: string) => {
    await window.api.restoreDoc(id)
    setView((v) =>
      v.kind === 'trash' ? { ...v, docs: v.docs.filter((d) => d.id !== id) } : v
    )
    setPinned((p) => (p?.id === id ? null : p))
  }
  const purgeTrashed = async (id: string) => {
    const d = view.kind === 'trash' ? view.docs.find((x) => x.id === id) : undefined
    const go = await askConfirm({
      title: `彻底删除「${d?.title || '无标题'}」？`,
      body: '此操作不可恢复，云端那条记录也会一并删掉。',
      ok: '彻底删除'
    })
    if (!go) return
    const r = await window.api.purgeDoc(id)
    if (!r.ok) {
      setErr('彻底删除失败：云端没有确认，这条还留在回收站里。')
      return
    }
    setView((v) =>
      v.kind === 'trash' ? { ...v, docs: v.docs.filter((x) => x.id !== id) } : v
    )
    setPinned((p) => (p?.id === id ? null : p))
  }
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    void writeConfig({ theme: next })
  }

  // Look for an update without being asked.  Nothing did this before, so the
  // app stayed at whatever version it was installed at while releases piled
  // up behind it: four of them went out unread, and a reader running a two
  // week old build met behaviour that had already been changed and reported
  // it as a bug.  Only the check is automatic — downloading and restarting
  // still wait for the press, because a relaunch nobody asked for is worse
  // than a version behind.
  useEffect(() => {
    const t = setTimeout(() => {
      window.api
        .checkUpdate(true)
        .then((r) => {
          if (!r?.available) setUpd(null)
        })
        .catch(() => setUpd(null))
    }, STARTUP_UPDATE_CHECK_DELAY_MS)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // Esc closes whatever is floating over the library, and only that:
      // dismissing the sheet and the card under it on one press would make
      // the key do twice what it was asked.  Both of these used to need the
      // mouse, which is most jarring exactly where the key is most likely to
      // be pressed — while something is covering the window.
      if (e.key === 'Escape') {
        if (settings) {
          e.preventDefault()
          setSettings(false)
          // and the section it was opened on: a sheet asked for from the
          // full-text panel opens on 全文检索, and one asked for from the
          // toolbar has no business landing there the next time
          setSetSec(null)
          return
        }
        if (showCols) {
          e.preventDefault()
          setShowCols(false)
          return
        }
        if (showSort) {
          e.preventDefault()
          setShowSort(false)
          return
        }
        if (showFilters) {
          e.preventDefault()
          setShowFilters(false)
          return
        }
        // out of the reading view and back to the table, which is where the
        // key is pressed from and the only place it can mean "leave". It
        // comes after the cards so a press over an open card closes the card
        // instead of leaving the reader still underneath it.
        if (view.kind === 'reader') {
          e.preventDefault()
          setView(LIBRARY)
          return
        }
        // last: drop a multi-selection without touching the row that is
        // open.  It goes after the sheets because a press that means "close
        // this" and "drop the selection" at once does twice what was asked.
        if (multiRef.current.length > 1) {
          e.preventDefault()
          setMulti([])
          return
        }
      }
      // Arrow keys, Enter and Delete belong to the table only when nothing
      // else has claimed them: inside a search box, a note box or a rename box
      // they have to keep doing what they do there, and on a focused button
      // Enter is a click.
      const t = e.target as HTMLElement | null
      const claimed =
        !!t &&
        (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(t.tagName) ||
          !!t.isContentEditable)
      // Ctrl+A is the one shortcut with a meaning inside a text field, and
      // that meaning wins there: what is being asked for is the text that was
      // typed, not every paper in the library.
      // F2 is the key the rest of the desktop uses for "rename this", and a
      // folder is the only thing here that has a name and can be given
      // another.  It is refused while a text field or a button owns the key,
      // and while the focus sits anywhere but the sidebar: a press meant for
      // the document list must not rename whatever folder happens to be open.
      if (e.key === 'F2') {
        const a = document.activeElement as HTMLElement | null
        const inTree = !a || a === document.body || !!a.closest?.('.pane-left')
        if (!claimed && folderId && inTree) {
          e.preventDefault()
          setRenameReq((r) => ({ id: folderId, n: (r?.n ?? 0) + 1 }))
        }
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
        e.preventDefault()
        const all = filteredRef.current
        if (!all.length) return
        // everything the list is showing, which after a search or inside a
        // folder is not the whole library — that is the point of the key
        setMulti(all.map((d) => d.id))
        lastIdx.current = null
        return
      }
      if (!claimed && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          navRef.current.step(1)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          navRef.current.step(-1)
          return
        }
        if (e.key === 'Home') {
          e.preventDefault()
          navRef.current.edge(false)
          return
        }
        if (e.key === 'End') {
          e.preventDefault()
          navRef.current.edge(true)
          return
        }
        // Delete, not Backspace: Backspace is the browser's own Back on some
        // platforms and wresting it away surprises people
        if (e.key === 'Enter') {
          e.preventDefault()
          navRef.current.open()
          return
        }
        if (e.key === 'Delete') {
          e.preventDefault()
          navRef.current.del()
          return
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        bumpFont(1)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault()
        bumpFont(-1)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoRef.current()
      }
      // Ctrl+C stays the browser's own copy; Shift is what asks for a
      // formatted citation instead of whatever text happens to be selected
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault()
        copyRef.current()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
    // settings and showCols are read here, so the listener has to be rebuilt
    // when either moves: a closure captured at mount would still see them
    // as false and Esc would do nothing at all.  folderId is read by F2 for
    // the same reason.
    // `view.kind` has to be in here, not merely read: the handler is built
    // once per change, and a closure over the view from the render it was
    // built in would go on answering for a view that has since been left —
    // which is how Esc stopped leaving the reader.
  }, [bumpFont, settings, showCols, showFilters, showSort, folderId, view.kind])

  const docs = lib?.docs ?? []

  /**
   * One pre-built haystack per document.  Building them on every keystroke
   * over 5600 documents, several of which have a full abstract, is what
   * turns typing into a stutter; they only change when a document or a note
   * does.
   */
  const haystack = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of docs) m.set(d.id, hay(d, noteMap[d.id]))
    return m
  }, [docs, noteMap])

  /**
   * What has to happen before there is anything to look at, or null when
   * there is.  Only one thing is ever named, because being told about three
   * missing pieces at once is not an instruction.
   *
   * It is null while the token question is still in flight: answering before
   * that would flash the guide at everyone whose token is in fact sitting
   * right where the app looks for it.
   *
   * A library on disk settles the matter on its own — somebody with 5000
   * cached papers and an expired token is not a first run, and blocking them
   * behind a guide to get one would be worse than whatever the token was
   * for.  The token is only asked for when there is nothing else to show.
   */
  const setup = useMemo(() => {
    if (setupDone || hasToken === null || lib === null) return null
    if (docs.length) return null
    if (!hasToken) return 'token' as const
    return 'sync' as const
  }, [setupDone, hasToken, lib, docs.length])

  const tree = useMemo(() => buildTree(folders), [folders])

  /** rollup: a parent also counts and shows what is inside its children */
  const folderCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of docs) {
      for (const f of d.folder_uuids ?? []) m.set(f, (m.get(f) ?? 0) + 1)
    }
    const rolled = new Map<string, number>()
    for (const f of folders) {
      const ids = tree.subtree.get(f.id) ?? [f.id]
      let n = 0
      for (const i of ids) n += m.get(i) ?? 0
      rolled.set(f.id, n)
    }
    return rolled
  }, [docs, folders, tree])

  /**
   * One collator for the whole run.
   *
   * `String.prototype.localeCompare` builds a collator on every call, and
   * the tie-break below reaches it once per comparison -- tens of thousands
   * of times over a library this size, every keystroke.  Building it once
   * is the whole difference.
   */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let out = docs
    for (const k of filters) out = out.filter(FILTER_TEST[k])
    if (folderId) {
      const ids = new Set(tree.subtree.get(folderId) ?? [folderId])
      out = out.filter((d) => (d.folder_uuids ?? []).some((f) => ids.has(f)))
    }
    if (q) out = out.filter((d) => (haystack.get(d.id) ?? '').includes(q))
    const { key, dir } = sort
    const val = (d: Doc): string | number => sortValue(d, key)
    // The key is taken once per document and carried through the sort.
    // Calling `val` from inside the comparator is the expensive way round:
    // it runs about n·log n times rather than n, and each of those builds
    // a lower-cased string that is then thrown away.  Over five thousand
    // papers that is the difference between one pass and twelve.
    const rows = out.map((d) => ({ d, v: val(d) }))
    rows.sort((a, b) => {
      if (a.v === b.v) return TITLE_ORDER.compare(a.d.title ?? '', b.d.title ?? '')
      return (a.v < b.v ? -1 : 1) * dir
    })
    return rows.map((r) => r.d)
  }, [docs, folderId, query, sort, filters, haystack])

  /**
   * How many papers each switch would leave, counted on the list as it stands
   * with the folder and the search box applied but without the filters
   * themselves.  Shown next to each box, so "没有本地 PDF" can be judged
   * before it is pressed rather than by pressing it.
   */
  const filterCounts = useMemo(() => {
    const q = query.trim().toLowerCase()
    let base = docs
    if (folderId) {
      const ids = new Set(tree.subtree.get(folderId) ?? [folderId])
      base = base.filter((d) => (d.folder_uuids ?? []).some((f) => ids.has(f)))
    }
    if (q) base = base.filter((d) => (haystack.get(d.id) ?? '').includes(q))
    // One walk, counting as it goes.  `base.filter(FILTER_TEST[k]).length`
    // builds a fresh array of every surviving paper for each switch and then
    // throws it away after reading one number off it -- five arrays of a few
    // thousand entries, allocated and discarded on every keystroke, which the
    // collector then has to account for.
    const out = {} as Record<ListFilter, number>
    for (const k of LIST_FILTERS) out[k] = 0
    for (const d of base) {
      for (const k of LIST_FILTERS) if (FILTER_TEST[k](d)) out[k]++
    }
    return out
  }, [docs, folderId, query, haystack, tree])

  /**
   * The keydown listener is installed once, so it reaches the list and the
   * selection through refs: a closure captured at mount would still be
   * looking at the first render's empty list, and Ctrl+A would select
   * nothing.
   */
  const filteredRef = useRef<Doc[]>([])
  filteredRef.current = filtered
  const multiRef = useRef<string[]>([])
  multiRef.current = multi

  /**
   * The row the right-hand pane is showing, which is not always a row the
   * left-hand pane is listing.
   *
   * Full-text search answers from the whole corpus, not from what the current
   * query and folder happen to narrow the catalogue to: a paper found by a
   * word in its body is very often not in `filtered` at all, because that
   * word is in its text and not in its title.  Looking only there left the
   * pane empty after the click that was supposed to fill it — the hit was
   * selected, the selection resolved to nothing, and the pane asked to be
   * given a paper again.  A view that can offer a paper has to be able to
   * show it.
   */
  const selected = useMemo(
    () =>
      filtered.find((d) => d.id === selId) ??
      docs.find((d) => d.id === selId) ??
      (pinned?.id === selId ? pinned : null),
    [filtered, docs, selId, pinned]
  )
  /** A paper in the bin is not an editable library document: the panel has
   *  to say so, and the two buttons it offers are the two that mean anything
   *  there.  Keyed off the pinned record rather than off view.kind, so a
   *  library row can never be mistaken for a trashed one. */
  const pinnedSelected = !!pinned && !!selected && selected.id === pinned.id

  /** Saving a search captures the three things that shape the list: the text,
   *  the folder and the starred filter.  Sort order is deliberately not part
   *  of it — it is a view of the same rows, not part of the question. */
  const saveSearch = () => {
    const parts = [
      query.trim() ? `“${query.trim()}”` : '',
      folderId ? folders.find((f) => f.id === folderId)?.name ?? '' : '',
      ...filters.map((k) => FILTER_LABEL[k])
    ].filter(Boolean)
    if (!parts.length) return
    setAsk({
      title: '给这个搜索起个名字',
      initial: parts.join(' · '),
      onOk: (name) => {
        setAsk(null)
        if (!name) return
        addSearch(name)
      }
    })
  }

  const addSearch = (name: string) => {
    const next: SavedSearch[] = [
      ...saved,
      {
        id: 's' + Date.now().toString(36),
        name,
        query: query.trim(),
        folderId,
        starred: filters.includes('star'),
        filters: [...filters]
      }
    ]
    setSaved(next)
    setActiveSearch(next[next.length - 1].id)
    writeConfig({ savedSearches: next })
  }

  const applySearch = (s: SavedSearch) => {
    setQuery(s.query)
    setFolderId(s.folderId)
    // Before `filters` existed only the star switch survived a save, while
    // the name and the count still claimed "未读 / 没有本地 PDF" etc.
    setFilters(
      (s.filters?.filter((k) => LIST_FILTERS.includes(k as ListFilter)) as
        | ListFilter[]
        | undefined) ?? (s.starred ? ['star'] : [])
    )
    setActiveSearch(s.id)
    setMulti([])
  }

  const deleteSearch = async (id: string) => {
    const s = saved.find((x) => x.id === id)
    const go = await askConfirm({
      title: `删除保存的搜索「${s?.name}」？`,
      body: '保存的搜索没有回收站，删掉就没了。',
      ok: '删除'
    })
    if (!go) return
    const next = saved.filter((x) => x.id !== id)
    setSaved(next)
    if (activeSearch === id) setActiveSearch(null)
    writeConfig({ savedSearches: next })
  }

  /** A view is the column layout and nothing else: saving one must not quietly
   *  change which rows are on screen, which is what folding the sort or the
   *  filter into it would do. */
  const changeCols = (next: ColKey[]) => {
    setCols(next)
    writeConfig({ cols: next })
  }

  /**
   * A press on a column header is a request about how to read the list, and
   * it is written through: finding the order reset to newest-first on
   * Monday after pressing a header twice on Friday is the kind of small
   * betrayal that makes a tool feel like it is not listening.  Pressing the
   * same header again flips the direction rather than starting over, which
   * is the only reason a second press is ever needed.
   *
   * A key nobody has pressed yet starts in the direction that key is usually
   * wanted in — newest first for a year or a date, A→Z for a word.  Asking
   * for the year and getting 1974 first is being handed the answer to a
   * question nobody asked, and the second press it then costs to put right
   * is the same small betrayal one line up.
   */
  const sortBy = (k: SortKey) => {
    const next: { key: SortKey; dir: 1 | -1 } =
      sort.key === k
        ? { key: k, dir: (sort.dir * -1) as 1 | -1 }
        : { key: k, dir: SORT_DEFAULT_DIR[k] }
    setSort(next)
    writeConfig({ sort: next })
  }

  /**
   * Move one column to a gap between two others.
   *
   * `toIndex` counts the gaps in the order as it stands, so it is a position
   * a column can be dropped into rather than an index into the list — the
   * caller does not have to know which side of the gap the dragged column
   * started on, and the off-by-one that comes with guessing is avoided.
   */
  const moveCol = (key: ColKey, toIndex: number) => {
    const from = cols.indexOf(key)
    if (from < 0) return
    const at = toIndex > from ? toIndex - 1 : toIndex
    if (at === from) return
    const next = cols.filter((k) => k !== key)
    next.splice(at, 0, key)
    changeCols(next)
  }

  /**
   * One column's width, or null to hand it back to its default track.
   *
   * Only the state is touched: the drag calls this once per frame and a frame
   * is not a unit of anything worth writing down.
   */
  const setColWidth = useCallback((key: ColKey, w: number | null) => {
    setColWidths((prev) => {
      if (w == null) {
        if (prev[key] == null) return prev
        const next = { ...prev }
        delete next[key]
        return next
      }
      if (prev[key] === w) return prev
      return { ...prev, [key]: w }
    })
  }, [])

  /**
   * Written once the dragging has stopped.
   *
   * Not from the drag's own mouse-up, which still holds the width from before
   * the last move, and not on every frame, which would be a hundred writes to
   * a file nobody asked to touch.  The pane widths are remembered the same way
   * for the same two reasons.
   */
  usePersistAfterMount(
    [colWidths],
    () => {
      void writeConfig({ colWidths })
    },
    COLUMN_WIDTH_PERSIST_DEBOUNCE_MS,
    configHydrated
  )

  const saveView = () => {
    setAsk({
      title: '给这个视图起个名字',
      initial: cols.length + ' 列',
      onOk: (name) => {
        setAsk(null)
        if (!name) return
        const next: SavedView[] = [
          ...views,
          { id: 'v' + Date.now().toString(36), name, cols: [...cols] }
        ]
        setViews(next)
        writeConfig({ views: next })
      }
    })
  }

  const applyView = (v: SavedView) => changeCols(normaliseCols(v.cols))

  const deleteView = async (id: string) => {
    const v = views.find((x) => x.id === id)
    const go = await askConfirm({
      title: `删除视图「${v?.name}」？`,
      body: '视图只是一套列的排布，删掉不影响文献本身。',
      ok: '删除'
    })
    if (!go) return
    const next = views.filter((x) => x.id !== id)
    setViews(next)
    writeConfig({ views: next })
  }

  const savedCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of saved) {
      const ids = s.folderId ? new Set(tree.subtree.get(s.folderId) ?? [s.folderId]) : null
      m.set(
        s.id,
        docs.filter((d) =>
          savedSearchMatches(
            d,
            s,
            (k) => FILTER_TEST[k as ListFilter],
            haystack,
            ids
          )
        ).length
      )
    }
    return m
  }, [saved, docs, tree, haystack])

  // The anchor is an index into the current list, so anything that reshapes
  // the list invalidates it. Without this, clicking row 100 in a wide list
  // and then narrowing it to three rows with a search would span from an
  // index that no longer points at the paper it was set on.
  useEffect(() => {
    lastIdx.current = null
  }, [query, folderId, filters, sort])

  /**
   * Selection follows the file manager the user already knows: shift-click
   * spans a range, ctrl-click toggles one, a plain click replaces.  The last
   * clicked index is the anchor for the next range, and it is kept in a ref
   * because it is not something the table should re-render for.
   */
  const onRowSelect = (
    d: Doc,
    index: number,
    mod: { shift: boolean; add: boolean }
  ) => {
    const anchor = lastIdx.current
    if (mod.shift && anchor != null && anchor >= 0 && anchor < filtered.length) {
      const a = Math.min(anchor, index)
      const b = Math.max(anchor, index)
      setMulti(filtered.slice(a, b + 1).map((x) => x.id))
    } else if (mod.add) {
      setMulti((m) => (m.includes(d.id) ? m.filter((x) => x !== d.id) : [...m, d.id]))
    } else {
      setMulti([d.id])
    }
    lastIdx.current = index
    setSelId(d.id)
    setRightTab(d.localPdf ? 'pdf' : 'details')
  }

  /**
   * A click on the empty part of either list drops the selection, the way a
   * file manager answers it. Esc and the batch bar only drop the *multi*
   * selection and deliberately keep the paper that is open; a click on blank
   * space is the reader saying "nothing is selected now", so the right pane
   * goes back to its empty state too. The shift anchor is reset because the
   * next shift-click must not span from a row that is no longer selected.
   *
   * Nothing happens when there is nothing to clear: an idle click should not
   * re-render a virtualised list of thousands of rows.
   */
  const clearSelection = () => {
    if (!selId && !pinned && multi.length === 0) return
    setMulti([])
    setSelId(null)
    setPinned(null)
    lastIdx.current = null
  }

  /**
   * Move the selection without opening anything, which is what an arrow key
   * has to do.  Deliberately not `onRowSelect`: that also switches the right
   * pane, and walking down the list with the arrows would then open a PDF per
   * row.
   */
  const selectOnly = (index: number) => {
    const d = filtered[index]
    if (!d) return
    lastIdx.current = index
    setMulti([d.id])
    setSelId(d.id)
  }

  /** Where the arrows start from: the selected row, or just outside the list
   *  when nothing is selected yet, so the first press lands on the first row
   *  rather than the second. */
  const stepSel = (delta: number) => {
    if (!filtered.length) return
    const cur = filtered.findIndex((d) => d.id === selId)
    const from = cur < 0 ? (delta > 0 ? -1 : 0) : cur
    const next = clampToRange(from + delta, 0, filtered.length - 1)
    if (next === cur) return
    selectOnly(next)
  }

  /** Membership is asked about on every row and in every batch action. A
   *  linear `includes` over an array that Ctrl+A can fill with the whole
   *  library turns one selection into O(n·m) comparisons, several of them in
   *  a single render. One set and one filtered list serve every caller. */
  const multiSet = useMemo(() => new Set(multi), [multi])
  const selectedDocs = useMemo(
    () => docs.filter((d) => multiSet.has(d.id)),
    [docs, multiSet]
  )

  /** What an export or a batch action applies to: the multi-selection when
   *  there is one, else the single selected row, else the whole view. */
  const target = useMemo(() => {
    if (multi.length > 1) return selectedDocs
    if (selected) return [selected]
    return filtered
  }, [multi.length, selected, filtered, selectedDocs])

  /**
   * Run one cloud call per item and say afterwards what actually happened.
   *
   * A batch that quietly does less than it was asked is worse than one that
   * fails outright: two hundred documents, three of which did not make it,
   * reads as two hundred documents, and the three are discovered later as
   * "this thing does not work".  There is no transaction across PATCHes, so
   * partial success is the ordinary case and not an accident.
   *
   * Progress is reported in at most twenty steps, because setting state once
   * per document re-renders the table once per document.
   */
  const runBatch = async <T,>(
    items: T[],
    name: (t: T) => string,
    run: (t: T) => Promise<void>,
    onProgress: (done: number, total: number) => void
  ): Promise<{ ok: number; failed: string[] }> => {
    const failed: string[] = []
    let ok = 0
    const every = Math.max(1, Math.floor(items.length / 20))
    for (let i = 0; i < items.length; i++) {
      try {
        await run(items[i]!)
        ok++
      } catch {
        // one failure must not abandon the rest of the batch
        failed.push(name(items[i]!))
      }
      if (i % every === 0 || i === items.length - 1) onProgress(i + 1, items.length)
    }
    return { ok, failed }
  }

  /**
   * How a batch ends.  A clean run is a momentary note; a run that lost
   * something goes to the banner that stays, and names what was lost,
   * because "some of them failed" is not something anybody can act on.
   */
  const reportBatch = (what: string, ok: number, failed: string[]) => {
    if (!failed.length) {
      flashBatch(`${what} ${ok} 条`, BATCH_CLEAN_MESSAGE_VISIBLE_MS)
      return
    }
    flashBatch(`${what} ${ok} 条，${failed.length} 条失败`, BATCH_FAILED_MESSAGE_VISIBLE_MS)
    setErr(
      `${what}时有 ${failed.length} 条没成功（其余 ${ok} 条已生效）：\n` +
        failed.join('\n')
    )
  }

  /** Drop every condition that is narrowing the list, so an empty table is
   *  not a dead end. */
  const clearFilters = useCallback(() => {
    setQuery('')
    setFolderId(null)
    setActiveSearch(null)
    setFilters([])
  }, [])

  /**
   * What the × in the search box does.
   *
   * It ends the search and nothing else: the folder and the filter switches
   * stay where they are, because they are not in this box and a reader who
   * cleared a typo did not ask to be moved out of a folder.  Full-text mode is
   * left as well — it is a mode of this box, and the way out of it used to be
   * pressing the same 「全文」 toggle that got in.
   */
  const clearSearch = useCallback(() => {
    setQuery('')
    setFtQuery('')
    setActiveSearch(null)
    setView((v) => (v.kind === 'fulltext' ? LIBRARY : v))
    // focus goes back to the box: the reader was typing in it a moment ago and
    // a click on the × leaves nothing focused at all otherwise
    searchRef.current?.focus()
  }, [setFtQuery])

  /** Typing a new query is not the saved search that was highlighted: the
   *  name in the sidebar must not keep claiming a filter the box no longer
   *  matches. */
  const onQuery = (v: string) => {
    setQuery(v)
    setActiveSearch(null)
  }

  /**
   * What the empty table says.  "没有匹配的文献" covered an empty library, a
   * filter that excluded everything and a search that hit nothing, which are
   * three different situations and — for the last two — have three different
   * ways out.
   */
  const emptyState = useMemo(() => {
    if (!docs.length) {
      return (
        <div className="empty">
          <p>库里还没有文献。</p>
          <p className="sub">同步云端会把你 Mendeley 上那份拉下来，也可以直接把 PDF 拖进来。</p>
        </div>
      )
    }
    const bits: string[] = []
    if (query.trim()) bits.push(`「${query.trim()}」`)
    if (folderId) {
      const f = folders.find((x) => x.id === folderId)
      if (f) bits.push(`文件夹「${f.name}」`)
    }
    for (const k of filters) bits.push(FILTER_LABEL[k])
    return (
      <div className="empty">
        <p>{bits.length ? `${bits.join(' · ')} 之下没有文献` : '没有匹配的文献'}</p>
        {/*
          The most common of these is a term that is in the paper but not in
          its title or abstract, and the answer is in the same toolbar.  Saying
          so is worth more than the count of what did not match.
        */}
        {query.trim() && view.kind !== 'fulltext' ? (
          <p className="sub">
            搜的是书目字段：标题、作者、期刊、摘要、标签和你写的笔记。
            要搜 PDF 正文，点工具栏的「全文」
            {ftStat && ftStat.indexed === 0 ? '（要先建一次索引）' : ''}。
          </p>
        ) : null}
        {bits.length ? (
          <button style={{ marginTop: 10 }} onClick={clearFilters}>
            清空这些条件
          </button>
        ) : null}
      </div>
    )
  }, [docs.length, query, folderId, folders, filters, view.kind, ftStat, clearFilters])

  const { message: batchMsg, flash: flashBatch, show: showBatch } = useFlashMessage()

  const { undo, pushUndo, doUndo, undoRef } = useUndo(setErr)
  navRef.current = {
    step: stepSel,
    edge: (end) => selectOnly(end ? filtered.length - 1 : 0),
    // Enter means "open this one": the reader when there is a PDF, otherwise
    // the details, which is where a download would be started from
    open: () => {
      if (selected) setRightTab(selected.localPdf ? 'pdf' : 'details')
    },
    del: () => {
      if (selected) void trashDocs([selected])
    }
  }

  /** Bring a trashed document back, locally as well as in the cloud. */
  const readmit = async (d: Doc) => {
    let back: Doc = d
    try {
      back = (await window.api.restoreDoc(d.id)) ?? d
    } catch {
      /* the cloud call failed; the copy we already have is still the truth */
    }
    setLib((l) =>
      l
        ? {
            ...l,
            docs: l.docs.some((x) => x.id === d.id)
              ? l.docs
              : [...l.docs, { ...d, ...back }]
          }
        : l
    )
  }

  /** Put a record's fields back, one call each: a field the API refuses to
   *  clear must not stop the others from being restored. */
  const revertFields = async (id: string, prev: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) continue
      try {
        await window.api.patchDoc(id, { [k]: v })
      } catch {
        /* leave this one as the merge made it */
      }
    }
    setLib((l) =>
      l ? { ...l, docs: l.docs.map((d) => (d.id === id ? { ...d, ...prev } : d)) } : l
    )
  }

  /**
   * The file name template.  Setting it is harmless, but it only affects
   * downloads until the user says to rename what is already on disk, and
   * renaming is shown as a preview first because it moves real files.
   */
  /** Pick where PDFs live.  Changing it resyncs, because the whole point of
   *  the directory is which of the documents have a file on disk. */
  const pickDir = async () => {
    const p = await window.api.pickPdfDir()
    if (!p) return
    setPdfDir(p)
    await doSync()
    // A pull with no cloud changes skips attachPdfs; force the re-match
    // against the new directory instead of leaving stale paths on screen.
    const reattached = await window.api.reattachPdfs()
    if (reattached.length) setLib((l) => (l ? { ...l, docs: reattached } : l))
  }

  /** The full-text page budget.  Written straight away: dropping the index is
   *  the point, and a setting that only takes effect after a restart reads as
   *  a setting that did nothing. */
  const changeFtPages = async (n: number) => {
    const next = clampFullTextPages(n)
    setFtPages(next)
    await writeConfig({ ftPages: next })
    setFtStat(await window.api.ftStatus())
  }

  const { bodyRef, dragLeft, dragRight, setLeft, setRight } = usePaneWidths({
    leftW,
    rightPct,
    setLeftW,
    setRightPct,
    configHydrated
  })

  const askNameTemplate = () => {
    setAsk({
      title: 'PDF 文件名模板（可用 {title} {year} {authors} {journal} {key} {type} {doi}）',
      initial: nameTemplate,
      onOk: async (v) => {
        setAsk(null)
        const next = v.trim() || DEFAULT_PDF_TEMPLATE
        setNameTemplate(next)
        writeConfig({ pdfNameTemplate: next })
        const plan = await window.api.renamePdfs(next, false)
        if (!plan.total) return
        const go = await askConfirm({
          title: `按新模板要改名 ${plan.total} 个本地 PDF`,
          body:
            plan.sample.join('\n') +
            (plan.total > plan.sample.length ? `\n…还有 ${plan.total - plan.sample.length} 个` : '') +
            '\n\n同名的会跳过，不会覆盖。',
          ok: '改名'
        })
        if (!go) return
        const r = await window.api.renamePdfs(next, true)
        await window.api.loadLibrary().then((res) => {
          if (res && !('error' in res) && res.docs) setLib(res)
        })
        // a count of renamed files is not an error, and the red banner was
        // the only place it had to go, so it landed there reading as one
        if (r.renamed) {
          flashBatch(`已重命名 ${r.renamed} 个文件${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`, RENAME_RESULT_MESSAGE_VISIBLE_MS)
        }
      }
    })
  }

  /**
   * Put papers into a folder, or take them out of one.
   *
   * One routine for both directions and for all three ways of starting it —
   * the batch menu, the row menu and dropping a selection onto a folder —
   * so that all of them report what happened and can be undone.  Doing it
   * three times is how one of them ends up silent.
   */
  const folderBatch = async (list: Doc[], folderId: string, op: 'add' | 'remove') => {
    const inside = (d: Doc) => (d.folder_uuids ?? []).includes(folderId)
    const todo = list.filter((d) => (op === 'add' ? !inside(d) : inside(d)))
    if (!todo.length) {
      flashBatch(op === 'add' ? '这些文献已经在这个文件夹里' : '这些文献不在这个文件夹里', FOLDER_NOOP_MESSAGE_VISIBLE_MS)
      return
    }
    const verb = op === 'add' ? '加入' : '移出'
    const { ok: n, failed } = await runBatch(
      todo,
      (d) => d.title || d.id,
      async (d) => {
        if (op === 'add') await window.api.addToFolder(folderId, d.id)
        else await window.api.removeFromFolder(folderId, d.id)
      },
      (done, total) => showBatch(`正在${verb}文件夹 ${done}/${total}…`)
    )
    // only what actually landed, so a paper that failed is not recorded as
    // moved and then shown as undoable
    const moved = todo.filter((d) => !failed.includes(d.title || d.id)).map((d) => d.id)
    setLib((l) =>
      l
        ? {
            ...l,
            docs: l.docs.map((d) =>
              moved.includes(d.id)
                ? {
                    ...d,
                    folder_uuids:
                      op === 'add'
                        ? [...(d.folder_uuids ?? []), folderId]
                        : (d.folder_uuids ?? []).filter((f) => f !== folderId)
                  }
                : d
            )
          }
        : l
    )
    reportBatch(`已${verb}文件夹`, n, failed)
    if (n) {
      pushUndo(`把 ${n} 条${verb}文件夹`, async () => {
        for (const id of moved) {
          if (op === 'add') await window.api.removeFromFolder(folderId, id).catch((e) => reportFailure(FAILURE.undoFolderRemove, e))
          else await window.api.addToFolder(folderId, id).catch((e) => reportFailure(FAILURE.undoFolderAdd, e))
        }
        setLib((l) =>
          l
            ? {
                ...l,
                docs: l.docs.map((d) =>
                  moved.includes(d.id)
                    ? {
                        ...d,
                        folder_uuids:
                          op === 'add'
                            ? (d.folder_uuids ?? []).filter((f) => f !== folderId)
                            : [...(d.folder_uuids ?? []), folderId]
                      }
                    : d
                )
              }
            : l
        )
      })
    }
  }

  const batchFolder = (folderId: string) =>
    folderBatch(
      selectedDocs,
      folderId,
      'add'
    )

  /**
   * The folder being looked at, if any.  "Take these out of here" is only a
   * meaningful request while there is a here, so every entry point that offers
   * it is keyed off this rather than off a folder chosen from a list.
   */
  const currentFolder = folderId ? folders.find((f) => f.id === folderId) ?? null : null

  const batchUnfolder = () => {
    if (!currentFolder) return
    void folderBatch(
      selectedDocs,
      currentFolder.id,
      'remove'
    )
  }

  const batchTrash = () => trashDocs(selectedDocs)

  /** Which of a list are worth a download: the cloud has a file and the disk
   *  does not.  Counting them is the whole point of the number on the button
   *  — a batch that downloads three of the two hundred selected is a batch
   *  that did something other than what it said, unless it said so first. */
  const needsPdf = (list: Doc[]) => list.filter((d) => d.file_attached && !d.localPdf)

  /**
   * Pull the missing PDFs down, a few at a time.
   *
   * Three lanes, not two hundred at once: the files come from S3 presigned
   * URLs and a burst is refused rather than queued, so a wide batch would
   * fail *more* papers than a narrow one.  A failure costs the paper it
   * happened on and nothing else, because there is no transaction across
   * independent downloads and one broken attachment is not a reason to give
   * up on the rest.
   *
   * The paths are collected and written back in handfuls rather than one at a
   * time: every write re-runs the filter and the sort over the whole library,
   * and doing that once per downloaded paper is the kind of cost that shows
   * up as "the app went slow while it was downloading".
   */
  const dlStop = useRef(false)
  const dlRunning = useRef(createBatchGate())
  const [dlRun, setDlRun] = useState<{ done: number; total: number } | null>(null)
  const batchDownload = async (list: Doc[]) => {
    // Two syncs in a row (or sync plus the batch button) used to start two
    // downloads over the same list: duplicate requests, `xxx (2).pdf`, two
    // progress bars fighting over dlRun, and two contradictory reports.
    if (!dlRunning.current.tryStart()) return
    try {
      const need = needsPdf(list)
      if (!need.length) {
        flashBatch('这些本地都已经有 PDF 了', ALL_HAVE_PDF_MESSAGE_VISIBLE_MS)
        return
      }
      dlStop.current = false
      setDlRun({ done: 0, total: need.length })
      const got = new Map<string, string>()
      const failed: string[] = []
      let done = 0
      const flush = () => {
        if (!got.size) return
        const g = new Map(got)
        got.clear()
        setLib((l) =>
          l
            ? {
                ...l,
                docs: l.docs.map((x) => (g.has(x.id) ? { ...x, localPdf: g.get(x.id)! } : x))
              }
            : l
        )
      }
      const queue = need.slice()
      const lanes = Math.min(3, queue.length)
      const work = async () => {
        for (;;) {
          const d = queue.shift()
          if (!d || dlStop.current) return
          try {
            const r = await window.api.downloadPdf(d.id)
            if (!r.ok || !r.path) throw new Error(r.error ?? '下载失败')
            got.set(d.id, r.path)
          } catch {
            failed.push(d.title || '(无标题)')
          }
          done++
          setDlRun({ done, total: need.length })
          if (done % 10 === 0) flush()
        }
      }
      await Promise.all(Array.from({ length: lanes }, work))
      flush()
      const stopped = dlStop.current
      setDlRun(null)
      const okN = need.length - failed.length - queue.length
      if (stopped) {
        flashBatch(`已停止，下载了 ${okN} 篇`, DOWNLOAD_STOPPED_MESSAGE_VISIBLE_MS)
        return
      }
      reportBatch('已下载', okN, failed)
    } finally {
      dlRunning.current.finish()
    }
  }

  /**
   * A pull the reader asked for is also a request to bring the library's
   * files down. Metadata alone made "云端有 PDF" look like a promise the sync
   * button never kept.
   *
   * The quiet start-up pull goes straight to `window.api.sync` inside
   * `useLibrary` and never comes through here, so opening the app does not
   * start a hundred downloads. The list comes from the file the sync just
   * wrote rather than from React state, which has not necessarily committed
   * by the time this runs. `batchDownload` already owns the three lanes, the
   * progress bar, the stop button and the failure-is-local policy.
   */
  const syncAndFetchPdfs = async (full = false) => {
    const r = await doSync(full)
    if (!syncPdfsOnSync || !r || 'error' in r) return
    const fresh = await window.api.loadLibrary()
    const docs = fresh && !('error' in fresh) ? fresh.docs : []
    const need = needsPdf(docs)
    if (need.length) await batchDownload(need)
  }

  /** Starred / read / tags.  These are per-user flags rather than metadata,
   *  so they are patched straight away instead of waiting for a save button. */
  const setFlags = useCallback(async (d: Doc, patch: Partial<Doc>) => {
    const updated = await window.api.patchDoc(d.id, patch as Record<string, unknown>)
    const merged = { ...d, ...updated }
    setLib((l) => (l ? { ...l, docs: l.docs.map((x) => (x.id === d.id ? merged : x)) } : l))
  }, [])

  /** The same patch over a list.  One undo entry for the whole batch: twenty
   *  separate entries for one menu click is not undo, it is twenty chances to
   *  give up before getting back where one started.  The previous values are
   *  captured up front, so the undo needs no knowledge of the later state. */
  const setFlagsFor = async (list: Doc[], patch: Partial<Doc>, label: string) => {
    if (!list.length) return
    const keys = Object.keys(patch) as (keyof Doc)[]
    const prev = new Map<string, Record<string, unknown>>()
    for (const d of list) {
      const o: Record<string, unknown> = {}
      for (const k of keys) o[k] = d[k]
      prev.set(d.id, o)
    }
    const changedIds: string[] = []
    const { ok: n, failed } = await runBatch(
      list,
      (d) => d.title || d.id,
      async (d) => {
        await setFlags(d, patch)
        changedIds.push(d.id)
      },
      (done, total) => showBatch(`${label} ${done}/${total}…`)
    )
    reportBatch(label, n, failed)
    if (n) {
      // Only what actually landed is undoable. Titles repeat across records,
      // so filter by ids actually reported successful rather than by the
      // failed names, which would drop a successful namesake.
      const changed = list.filter((d) => changedIds.includes(d.id))
      pushUndo(`${label} ${n} 条`, async () => {
        await Promise.all(
          changed.map((d) => window.api.patchDoc(d.id, prev.get(d.id)!).catch(() => null))
        )
        // re-read rather than merging: the PATCH response does not always echo
        // every flag, and a row that still shows the old value looks like the
        // undo failed when it did not
        const r = await window.api.loadLibrary().catch(() => null)
        if (r && !('error' in r) && r.docs) setLib(r)
      })
    }
  }

  /**
   * The cross-document annotation list.  It reloads the store every time it
   * is opened rather than tracking it: the reader writes annotations on its
   * own, and a cached copy would quietly hide anything marked since.
   */
  const openNotes = async () => {
    const from = viewRef.current.read()
    const all = await window.api.loadAnnotations()
    if (!viewRef.current.still(from)) return
    setAnns(all)
    setView({ kind: 'annotations', anns: all })
  }

  const deleteAnnotation = async (id: string) => {
    const all = await window.api.loadAnnotations()
    const gone = all.find((a) => a.id === id)
    // An annotation is the one thing here that is gone for good: there is no
    // trash for it, and deleting it also deletes it in the cloud.  Everything
    // else that can be removed has a way back.
    const go = await askConfirm({
      title: '删除这条标注？',
      body: gone?.text
        ? `「${gone.text.slice(0, 60)}${gone.text.length > 60 ? '…' : ''}」\n\n不可恢复，云端那条也会一并删掉。`
        : '不可恢复，云端那条也会一并删掉。',
      ok: '删除标注'
    })
    if (!go) return
    const next = all.filter((a) => a.id !== id)
    await window.api.saveAnnotations(next)
    setAnns(next)
    setView((v) => (v.kind === 'annotations' ? { ...v, anns: next } : v))
    // the cloud copy is deleted after the local one is safely written, and a
    // failure there leaves a stray cloud highlight rather than a lost local one
    if (gone?.remoteId) {
      await window.api.deleteRemoteAnnotation(gone.remoteId).catch((e) => reportFailure(FAILURE.cloudHighlightRemoval, e))
    }
  }

  /**
   * One field, many documents.  Every field except `tags` is a plain
   * overwrite; `tags` has to be merged with what the document already has,
   * because a PATCH replaces the whole array rather than appending to it.
   *
   * A failure skips and counts rather than aborting, the same as the folder
   * batch: fifty documents against a rate-limited API will lose one sooner or
   * later, and losing one should not mean the other forty-nine silently did
   * not happen.
   */
  const applyBatchEdit = async (op: BatchOp, value: string) => {
    const list = selectedDocs
    if (!list.length) return
    const patchFor = (d: Doc): Record<string, unknown> => {
      switch (op) {
        case 'tag-add':
          return { tags: [...new Set([...(d.tags ?? []), value])] }
        case 'tag-del':
          return { tags: (d.tags ?? []).filter((t) => t !== value) }
        case 'type':
          return { type: value }
        case 'starred':
          return { starred: value === 'true' }
        case 'read':
          return { read: value === 'true' }
      }
    }
    const field = op === 'tag-add' || op === 'tag-del' ? 'tags' : op
    const prev = list.map((d) => (d as unknown as Record<string, unknown>)[field])
    const { ok: n, failed } = await runBatch(
      list,
      (d) => d.title || d.id,
      async (d) => {
        await setFlags(d, patchFor(d))
      },
      (done, total) => showBatch(`批量修改 ${done}/${total}…`)
    )
    reportBatch('已修改', n, failed)
    if (n) {
      pushUndo(`批量修改 ${n} 条的${field === 'tags' ? '标签' : '字段'}`, async () => {
        await Promise.all(
          list.map((d, i) =>
            window.api
              .patchDoc(d.id, { [field]: prev[i] ?? null })
              .catch(() => null)
          )
        )
        const r = await window.api.loadLibrary().catch(() => null)
        if (r && !('error' in r) && r.docs) setLib(r)
      })
    }
  }

  /** Move `list` to the trash.  Shared by the batch bar and the row menu. */
  const trashDocs = async (list: Doc[]) => {
    if (!list.length) return
    const go = await askConfirm({
      title: `把 ${list.length} 条文献移入回收站？`,
      body:
        (list.length === 1 ? `「${list[0]?.title || '无标题'}」` : `选中的 ${list.length} 条`) +
        '会移入回收站，可以在回收站里恢复。',
      ok: '移入回收站'
    })
    if (!go) return
    const { ok: n, failed } = await runBatch(
      list,
      (d) => d.title || d.id,
      async (d) => {
        const r = await window.api.trashDoc(d.id)
        if (!r.ok) throw new Error('the cloud refused to trash this document')
      },
      (done, total) => showBatch(`正在移入回收站 ${done}/${total}…`)
    )
    const goneIds = new Set(
      list.filter((d) => !failed.includes(d.title || d.id)).map((d) => d.id)
    )
    // only what actually left the library is taken out of it here; the rest
    // stay, which is the truthful outcome and the one that can be retried
    setLib((l) => (l ? { ...l, docs: l.docs.filter((d) => !goneIds.has(d.id)) } : l))
    setMulti([])
    setSelId(null)
    reportBatch('已移入回收站', n, failed)
    if (n) {
      pushUndo(`删除 ${n} 条`, async () => {
        for (const d of list.filter((x) => goneIds.has(x.id))) await readmit(d)
      })
    }
  }

  /**
   * What a row menu acts on.  Right clicking a row that is already part of the
   * multi-selection means the selection; right clicking any other row means
   * that row alone, or the menu would describe one document while the pane
   * showed another.
   */
  const menuTargets = (id: string): Doc[] => {
    if (multi.length > 1 && multiSet.has(id)) {
      return selectedDocs
    }
    const d = docs.find((x) => x.id === id)
    return d ? [d] : []
  }

  const rowMenuItems = (id: string): RowMenuItem[] => {
    const list = menuTargets(id)
    const many = list.length > 1
    const tail = many ? `（${list.length} 条）` : ''
    // a batch reads as "on" only when every row is already on, otherwise the
    // menu would offer to unstar a set that is only partly starred
    const starred = list.length > 0 && list.every((d) => !!d.starred)
    const unread = list.some((d) => d.read === false)
    return [
      {
        label: `复制引文${tail}`,
        title: '按工具条上选的样式',
        run: () => void copyCitation(list)
      },
      { label: '复制 BibTeX 条目', run: () => void copyCitation(list, 'bibtex') },
      {
        label: '复制标题',
        run: () => void window.api.copyText(list.map((d) => d.title ?? '').join('\n'))
      },
      { sep: true },
      {
        label: starred ? `取消星标${tail}` : `加星标${tail}`,
        run: () => void setFlagsFor(list, { starred: !starred }, starred ? '取消星标' : '加星标')
      },
      {
        label: unread ? `标为已读${tail}` : `标为未读${tail}`,
        run: () =>
          void setFlagsFor(list, { read: unread ? true : false }, unread ? '标为已读' : '标为未读')
      },
      { sep: true },
      // only offered for a single row, and only when the file is actually on
      // disk: revealing two files at once is not a thing, and an entry that
      // does nothing on click is worse than no entry
      {
        label: '在文件夹中显示',
        disabled: list.length !== 1 || !list[0]?.localPdf,
        title: list[0]?.localPdf ?? '这篇没有本地 PDF',
        run: () => void window.api.revealPdf(list[0]!.localPdf!)
      },
      {
        label: '用系统程序打开',
        disabled: list.length !== 1 || !list[0]?.localPdf,
        title: list[0]?.localPdf ?? '这篇没有本地 PDF',
        run: () => void window.api.openPdfExternally(list[0]!.localPdf!)
      },
      // taking a paper out of a folder is only offered while a folder is being
      // looked at, and only when at least one of the targets is actually in it;
      // the paper itself is never touched, so this needs no confirmation
      ...(currentFolder
        ? [
            { sep: true },
            {
              label: `移出「${currentFolder.name}」${tail}`,
              disabled: !list.some((d) => (d.folder_uuids ?? []).includes(currentFolder.id)),
              title: '从这个文件夹里去掉，文献本身保留',
              run: () => void folderBatch(list, currentFolder.id, 'remove')
            }
          ]
        : []),
      { sep: true },
      {
        label: `移入回收站${tail}`,
        danger: true,
        run: () => void trashDocs(list)
      }
    ]
  }

  const {
    exportBib,
    exportRis,
    exportEndnote,
    exportNotes,
    exportAnnotations,
    leaveLibrary,
    canExportNotes,
    canExportAnnotations
  } = useExport({ target, docs, noteMap, anns, setErr, flashBatch, showBatch, askConfirm })

  /**
   * Put a formatted citation on the clipboard.  This is the single most
   * frequent thing a reference manager is for — pick a paper, paste it into
   * the manuscript — and it used to need a whole-file export and a search.
   * The style is remembered, because it is a fact about how the user writes,
   * not about the document in front of them.
   */
  const copyCitation = async (list: Doc[], style: CiteStyle = citeStyle) => {
    if (!list.length) return
    const text = formatCitation(list, style)
    await window.api.copyText(text)
    flashBatch(
      list.length > 1 ? `已复制 ${list.length} 条引文` : `已复制引文：${text.split('\n')[0]}`,
      CITATION_COPIED_MESSAGE_VISIBLE_MS
    )
  }
  // the shortcut lives in a listener installed once, so it reads the current
  // selection through a ref instead of a stale closure
  const copyRef = useRef<(list?: Doc[]) => void>(() => {})
  copyRef.current = () => {
    void copyCitation(target)
  }

  const [dropping, setDropping] = useState(false)
  const { message: importMsg, flash: flashImport, show: showImport } = useFlashMessage()

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.name.toLowerCase().endsWith('.pdf')
    )
    if (!files.length) return
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      showImport(`导入 ${i + 1}/${files.length}：${f.name}`)
      try {
        // One read feeds both steps.  Reading the file twice was the whole
        // cost of the import for a large PDF, and it only looked necessary
        // because pdf.js detaches the buffer it is given — pdfmeta now hands
        // pdf.js a copy, so the bytes survive to be uploaded.
        const buf = await f.arrayBuffer()
        const ids = await extractIds(buf)
        const doc = await window.api.importPdf(f.name, buf, ids)
        setLib((l) => (l ? { ...l, docs: [...l.docs, doc] } : l))
      } catch (err) {
        setErr(`导入「${f.name}」失败：${String(err)}`)
      }
    }
    flashImport(files.length > 1 ? `已导入 ${files.length} 篇` : '导入完成', IMPORT_FINISHED_MESSAGE_VISIBLE_MS)
  }

  /**
   * The reader, whether it is being given the whole window or the pane beside
   * the table.  One element because there is one thing to say about how a
   * paper is opened, and the two places differ only in how much room they
   * give it.
   *
   * It is not shared between them at once — the reading view replaces the
   * panes rather than sitting next to them — so opening one does not leave
   * two readers arguing over where the paper was left.
   */
  /**
   * Which paper in the library a reference in a PDF is, and which paper a
   * link out of one points at.
   *
   * Both are answered from the library's own identifiers, indexed once: they
   * are asked for one at a time — on hover, and per link on a page that is
   * being read — and a column of thirty links is thirty questions, which is
   * not something to answer by walking five thousand papers each time.
   */
  const refIx = useMemo(() => idIndex(docs), [docs])
  const refDocFor = useCallback((entry: string) => docForRef(refIx, entry), [refIx])
  const linkDocFor = useCallback((url: string) => docForUrl(refIx, url), [refIx])

  const reader = selected ? (
    <PdfViewer
      doc={selected}
      jumpTo={jump}
      // the word in the search box, whichever of the two modes typed
      // it: a hit in the list is a claim about the paper, and the
      // paper is where it has to be checkable
      hitQuery={view.kind === 'fulltext' ? ftQuery : query}
      confirm={askConfirm}
      onLocalPdf={(id, p) =>
        setLib((l) =>
          l ? { ...l, docs: l.docs.map((x) => (x.id === id ? { ...x, localPdf: p } : x)) } : l
        )
      }
      // asked for when a citation is hovered, so a reference that is already
      // on the shelf can be opened from the paper that cites it
      refDoc={refDocFor}
      // and for every link out of the paper, so one that points at a paper
      // already on the shelf opens here instead of in a browser
      linkDoc={linkDocFor}
      onOpenDoc={(id) => {
        setSelId(id)
        setRightTab('pdf')
        // A reference that is already on the shelf opens in place. Bring the
        // folder tree with it: otherwise the tree keeps pointing at a folder
        // that may not even contain the paper now on screen. `folderId` is
        // both the highlight and the list filter, so moving it keeps what is
        // shown and what is selected the same thing (171).
        setFolderId(folderForOpenedDoc(docs.find((d) => d.id === id), folderId, folders))
        setActiveSearch(null)
      }}
    />
  ) : null

  return (
    <div
      className={'app' + (dropping ? ' dropping' : '')}
      onDragOver={(e) => {
        e.preventDefault()
        // Only a drag that is carrying files is a request to import.  A
        // document being dragged out of the table carries no files, and
        // telling the reader "松手即导入 PDF" for that is what made dragging
        // a paper into a folder look unsupported.  `files` is empty until the
        // drop lands, so `types` is the only thing readable all the way
        // through the drag.
        if (!Array.from(e.dataTransfer.types).includes('Files')) return
        setDropping(true)
      }}
      onDragLeave={(e) => {
        // ignore the bubbling leave events fired when crossing child nodes
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false)
      }}
      onDrop={onDrop}
    >
      <Toolbar
        searchRef={searchRef}
        busy={busy}
        onSync={syncAndFetchPdfs}
        status={status}
        upd={upd}
        onSettings={() => setSettings(true)}
        canRead={!!selected?.localPdf}
        onRead={() => setView({ kind: 'reader' })}
        onImportRefs={(entries) => setView({ kind: 'import', entries })}
        onExportBib={exportBib}
        onExportRis={exportRis}
        onExportEndnote={exportEndnote}
        onExportNotes={() => void exportNotes()}
        canExportNotes={canExportNotes}
        onExportAnnotations={() => void exportAnnotations()}
        canExportAnnotations={canExportAnnotations}
        onLeave={() => void leaveLibrary()}
        docs={docs}
        filtered={filtered}
        target={target}
        onCopyCitation={() => void copyCitation(target)}
        citeStyle={citeStyle}
        onCiteStyle={(s) => {
          setCiteStyle(s)
          void writeConfig({ citeStyle: s })
        }}
        view={view}
        onView={setView}
        query={query}
        onQuery={onQuery}
        ftQuery={ftQuery}
        onFtQuery={setFtQuery}
        onClearSearch={clearSearch}
        onFtStatus={setFtStat}
        filters={filters}
        filterCounts={filterCounts}
        onToggleFilter={toggleFilter}
        onClearFilters={clearFilters}
        showFilters={showFilters}
        onShowFilters={setShowFilters}
        showSort={showSort}
        onShowSort={setShowSort}
        showCols={showCols}
        onShowCols={setShowCols}
        sort={sort}
        onSort={sortBy}
        cols={cols}
        onCols={changeCols}
        views={views}
        onSaveView={saveView}
        onApplyView={applyView}
        onDeleteView={deleteView}
        onUndo={doUndo}
        undoLabel={undo.length ? undo[undo.length - 1].label : null}
        onNotes={() => void openNotes()}
        onTrash={openTrash}
        canSaveSearch={!!(query.trim() || folderId || filters.length)}
        onSaveSearch={saveSearch}
        onErr={setErr}
        fontSize={fontSize}
        onFont={bumpFont}
        theme={theme}
        onTheme={toggleTheme}
      />

      {err && (
        <div className="err">
          <span className="err-text">{err}</span>
          {/*
            The one banner that stays.  The others clear themselves after a
            couple of seconds, which is right for "copied" and wrong for a
            reason a sync failed: that is worth reading more than once, and
            it used to sit there until some later operation happened to
            push it off.  So it gets a way out instead of a timeout.
          */}
          <button className="err-close" title="关掉这条提示" onClick={() => setErr(null)}>
            ×
          </button>
        </div>
      )}
      {importMsg && <div className="pdf-msg">{importMsg}</div>}
      {dropping && <div className="drop-veil">松手即导入 PDF</div>}
      {ask && (
        <AskDialog
          title={ask.title}
          initial={ask.initial}
          onOk={ask.onOk}
          onCancel={() => setAsk(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          ok={confirm.ok}
          cancel={confirm.cancel}
          onOk={() => {
            confirm.resolve(true)
            setConfirm(null)
          }}
          onCancel={() => {
            confirm.resolve(false)
            setConfirm(null)
          }}
        />
      )}

      {view.kind === 'reader' && selected ? (
        <div className="body reading">
          <div className="pane-head">
            <button style={{ padding: '3px 10px' }} onClick={() => setView(LIBRARY)}>
              ← 回到列表
            </button>
            <span className="grow" />
            <span className="badge" title={selected.title ?? ''}>
              {(selected.title ?? '无标题').slice(0, 60)}
            </span>
          </div>
          {reader}
        </div>
      ) : (
      <div className="body" ref={bodyRef}>
        <div className="pane pane-left" style={{ flexBasis: leftW }}>
          <div className="pane-head">
            <span>文件夹</span>
            <span className="grow" />
            <button
              style={{ padding: '2px 6px', fontSize: '0.733rem' }}
              onClick={() =>
                setAsk({
                  title: '新文件夹名称',
                  initial: '',
                  onOk: async (n) => {
                    setAsk(null)
                    if (!n) return
                    const f = await window.api.createFolder(n)
                    setFolders((fs) => [...fs, f])
                  }
                })
              }
            >
              +
            </button>
          </div>
          <FolderTree
            folders={folders}
            counts={folderCount}
            total={docs.length}
            saved={saved}
            savedCounts={savedCounts}
            activeSearch={activeSearch}
            onSelectSearch={applySearch}
            onDeleteSearch={deleteSearch}
            selected={folderId}
            // picking a folder or "all" leaves the saved search
            onSelect={(id) => {
              setFolderId(id)
              setActiveSearch(null)
            }}
            onDrop={(fid, ids) => folderBatch(docs.filter((d) => ids.includes(d.id)), fid, 'add')}
            onRename={async (fid, name) => {
              const f = await window.api.patchFolder(fid, { name })
              setFolders((fs) => fs.map((x) => (x.id === fid ? f : x)))
              setLib((l) => (l ? { ...l, folders: l.folders.map((x) => (x.id === fid ? f : x)) } : l))
            }}
            renameRequest={renameReq}
            onDelete={async (fid) => {
              const f = folders.find((x) => x.id === fid)
              const kids = (tree.subtree.get(fid) ?? [fid]).length - 1
              const go = await askConfirm({
                title: kids
                  ? `删除文件夹「${f?.name}」及其 ${kids} 个子文件夹？`
                  : `删除文件夹「${f?.name}」？`,
                body: '其中的文献不会被删除，只是不再属于这个文件夹。',
                ok: '删除文件夹'
              })
              if (!go) return
              await window.api.deleteFolder(fid)
              const gone = new Set(tree.subtree.get(fid) ?? [fid])
              setFolders((fs) => fs.filter((x) => !gone.has(x.id)))
              setLib((l) => (l ? { ...l, folders: l.folders.filter((x) => !gone.has(x.id)) } : l))
              if (folderId && gone.has(folderId)) setFolderId(null)
            }}
            onMove={async (fid, parentId) => {
              const f = await window.api.patchFolder(fid, { parent_id: parentId })
              setFolders((fs) => fs.map((x) => (x.id === fid ? f : x)))
              setLib((l) => (l ? { ...l, folders: l.folders.map((x) => (x.id === fid ? f : x)) } : l))
            }}
          />
        </div>

        <Splitter
          onMove={dragLeft}
          onReset={() => setLeft(DEFAULT_LEFT_W)}
          onNudge={(d) => setLeft(leftW + d)}
          title="拖动改变文件夹栏宽度，双击复位"
        />

        {view.kind === 'add' ? (
          <AddByIdView
            docs={docs}
            onClose={() => setView(LIBRARY)}
            onAdded={(created) => {
              if (created.length) {
                setLib((l) => (l ? { ...l, docs: [...l.docs, ...created] } : l))
              }
            }}
          />
        ) : view.kind === 'import' ? (
          <ImportView
            entries={view.entries}
            docs={docs}
            onClose={() => setView(LIBRARY)}
            onImported={(created) => {
              if (created.length) {
                setLib((l) => (l ? { ...l, docs: [...l.docs, ...created] } : l))
              }
            }}
          />
        ) : view.kind === 'fulltext' ? (
          <FullTextView
            query={ftQuery}
            hits={ftHits}
            searching={ftSearching}
            docs={docs}
            sort={sort}
            status={ftStat}
            onClose={() => setView(LIBRARY)}
            onBuild={async (rebuild) => {
              if (rebuild) {
                const go = await askConfirm({
                  title: '清空全文索引并从头重建？',
                  body: '会重新读取全部本地 PDF，几千篇要几分钟。中途可以停，已经读进去的会留着。',
                  ok: '重建'
                })
                if (!go) return
              }
              buildIndex(rebuild)
            }}
            onClear={async () => {
              const go = await askConfirm({
                title: '删除全文索引？',
                body: '搜索正文前需要重建一次。文献本身不受影响。',
                ok: '删除索引'
              })
              if (!go) return
              clearIndex()
            }}
            onCancel={cancelIndex}
            onOpenSettings={() => {
              setSetSec('全文检索')
              setSettings(true)
            }}
            onOpen={(d, p) => {
              setSelId(d.id)
              // A hit is a hit into a file that was read, but the file can
              // still have gone since: the index keeps text for a paper whose
              // PDF was moved or deleted, and sending the pane to a reader
              // with nothing in it is worse than sending it to the details.
              setRightTab(d.localPdf ? 'pdf' : 'details')
              setJump({ page: p, nonce: Date.now() })
            }}
          />
        ) : view.kind === 'annotations' ? (
          <NotesView
            anns={view.anns}
            docs={docs}
            onClose={() => setView(LIBRARY)}
            onOpen={(d, p) => {
              setView(LIBRARY)
              setSelId(d.id)
              setRightTab(d.localPdf ? 'pdf' : 'details')
              setJump({ page: p, nonce: Date.now() })
            }}
            onDelete={(id) => void deleteAnnotation(id)}
            onCopy={(a, d) =>
              void window.api.copyText(
                [a.note || a.text || '', d ? `${d.title ?? ''} · p${a.pos?.[0]?.page ?? a.page}` : '']
                  .filter(Boolean)
                  .join('\n')
              )
            }
          />
        ) : view.kind === 'dupes' ? (
          <DupesView
            groups={view.groups}
            ignored={dupeIgnores}
            onIgnore={(ids) => {
              const next = [...dupeIgnores, ids]
              setDupeIgnores(next)
              writeConfig({ dupeIgnores: next })
            }}
            onRestore={(ids) => {
              const next = dupeIgnores.filter((e) => {
                if (e.length !== ids.length) return true
                const a = [...e].sort().join(' ')
                return a !== [...ids].sort().join(' ')
              })
              setDupeIgnores(next)
              writeConfig({ dupeIgnores: next })
            }}
            onClose={() => setView(LIBRARY)}
            onOpen={(d) => {
              setSelId(d.id)
              // a paper that has no file on disk opens on its details:
              // which of two entries has the PDF is very often exactly what
              // the reader came here to find out
              setRightTab(d.localPdf ? 'pdf' : 'details')
            }}
            openId={selId}
            onMerge={async (g, keeper) => {
              const others = g.docs.filter((d) => d.id !== keeper.id)
              const go = await askConfirm({
                title: `合并这 ${g.docs.length} 条？`,
                body:
                  `留下的那条是「${keeper.title || '无标题'}」，它的空字段会用其余几条补上。\n` +
                  `其余 ${others.length} 条会移入回收站，可以在回收站里恢复。`,
                ok: '合并'
              })
              if (!go) return
              // fill only what the keeper is missing, so merging never
              // overwrites a good field with a worse one
              const patch: Record<string, unknown> = {}
              const field = (d: Doc, f: string) =>
                (d as unknown as Record<string, unknown>)[f]
              for (const f of [
                'abstract',
                'source',
                'publisher',
                'volume',
                'issue',
                'pages',
                'citation_key',
                'keywords',
                'url'
              ]) {
                if (field(keeper, f)) continue
                const hit = others.find((o) => field(o, f))
                if (hit) patch[f] = field(hit, f)
              }
              if (!keeper.year) {
                const y = others.find((o) => o.year)?.year
                if (y) patch.year = y
              }
              if (!keeper.authors?.length) {
                const a = others.find((o) => o.authors?.length)?.authors
                if (a) patch.authors = a
              }
              const ident = { ...(keeper.identifiers ?? {}) }
              if (!ident.doi) {
                ident.doi = others.map((o) => o.identifiers?.doi ?? o.doi).find(Boolean)
              }
              if (!ident.arxiv) {
                ident.arxiv = others.map((o) => o.identifiers?.arxiv ?? o.arxiv).find(Boolean)
              }
              if (ident.doi || ident.arxiv) patch.identifiers = ident
              const updated = Object.keys(patch).length
                ? await window.api.patchDoc(keeper.id, patch)
                : keeper
              // remember what the keeper looked like, so undoing the merge can
              // put it back rather than only resurrecting the losers
              const prev: Record<string, unknown> = {}
              for (const f of Object.keys(patch)) prev[f] = field(keeper, f)
              for (const o of others) {
                const r = await window.api.trashDoc(o.id)
                if (!r.ok) {
                  setErr(`合并没能完成：「${o.title || '无标题'}」没有被移入回收站。`)
                  return
                }
              }
              const gone = new Set(others.map((o) => o.id))
              setLib((l) =>
                l
                  ? {
                      ...l,
                      docs: l.docs
                        .filter((d) => !gone.has(d.id))
                        .map((d) => (d.id === keeper.id ? { ...d, ...updated } : d))
                    }
                  : l
              )
              setView((v) =>
                v.kind === 'dupes' ? { ...v, groups: v.groups.filter((x) => x.key !== g.key) } : v
              )
              pushUndo(`合并 ${others.length} 条`, async () => {
                await revertFields(keeper.id, prev)
                for (const o of others) await readmit(o)
                setView((v) => (v.kind === 'dupes' ? { ...v, groups: [...v.groups, g] } : v))
              })
            }}
          />
        ) : setup ? (
          <SetupGuide
            step={setup}
            busy={busy}
            onAuthorize={async (clientId, clientSecret) => {
              const r = await window.api.authorize(clientId, clientSecret)
              // "取消了授权" is what closing the window says, and a reader who
              // closed it knows they closed it; putting it in red under the
              // fields would read as a failure of something they did right
              if (r?.ok) {
                markToken()
                await doSync()
                return null
              }
              return r?.error && r.error !== '取消了授权' ? r.error : null
            }}
            onImportToken={async () => {
              const r = await window.api.importToken()
              if (r?.ok) {
                markToken()
                await doSync()
              } else if (r) setErr('导入 token 失败：' + (r.error ?? '未选择文件'))
            }}
            onSync={() => void syncAndFetchPdfs(false)}
            onDismiss={() => setSetupDone(true)}
          />
        ) : view.kind === 'trash' ? (
          <TrashView
            docs={view.docs}
            onClose={() => {
              setPinned(null)
              setSelId(null)
              setView(LIBRARY)
            }}
            onOpen={(d) => {
              // a trashed record is not in `docs`; hold it so the right pane
              // has something to show.  A file that survived the trash opens
              // as a PDF, one that did not falls to the read-only details.
              setPinned(d)
              setSelId(d.id)
              setRightTab(d.localPdf ? 'pdf' : 'details')
            }}
            openId={pinned?.id ?? null}
            onRestore={(id) => void restoreTrashed(id)}
            onPurge={(id) => void purgeTrashed(id)}
          />
        ) : (
        <div className="pane pane-mid">
          <div className="pane-head">
            <span>文献</span>
            <span className="grow" />
            <span style={{ fontSize: '0.733rem' }}>
              {pdfDir ? 'PDF: ' + pdfDir.slice(-42) : '未设置 PDF 目录'}
            </span>
            <button
              style={{ padding: '2px 6px', fontSize: '0.733rem' }}
              onClick={() => void pickDir()}
            >
              改目录
            </button>
            <button
              style={{ padding: '2px 6px', fontSize: '0.733rem' }}
              title="设置下载与重命名 PDF 用的文件名模板"
              onClick={askNameTemplate}
            >
              命名
            </button>
          </div>
          {/*
            Not a guide and not a banner: a library without a PDF directory
            half works, and the half that is missing — downloading, and the
            full-text index, which can only read files on disk — is the half
            this app exists for.  It was one line of grey text in the pane
            header, which is how it stayed unset.
          */}
          {!pdfDir && (
            <div className="setup-hint">
              <span>
                还没设 PDF 目录。下载的 PDF 没有地方放，全文检索也只能读磁盘上的文件——
                这两件事都还不能用。
              </span>
              <button onClick={() => void pickDir()}>选择目录</button>
            </div>
          )}
          {multi.length > 1 && (
            <div className="batch-bar">
              <span>已选 {multi.length} 条</span>
              <select
                value=""
                onChange={(e) => {
                  const fid = e.target.value
                  e.currentTarget.value = ''
                  if (fid) batchFolder(fid)
                }}
                title="把选中的文献加入文件夹"
              >
                <option value="">＋ 加入文件夹…</option>
                {[...folders].sort(byName).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              {currentFolder && (
                <button
                  onClick={batchUnfolder}
                  title={`把选中的文献从「${currentFolder.name}」里去掉，文献本身保留`}
                >
                  移出「{currentFolder.name}」
                </button>
              )}
              <button className="danger" onClick={batchTrash}>
                移入回收站
              </button>
              <MenuButton
                label="导出"
                title="把选中的这些写成 BibTeX / RIS / EndNote XML"
                items={[
                  { label: 'BibTeX', run: exportBib },
                  { label: 'RIS', run: exportRis },
                  { label: 'EndNote XML', run: exportEndnote }
                ]}
              />
              <button onClick={() => copyCitation(selectedDocs)}>
                复制引文
              </button>
              {(() => {
                const need = needsPdf(selectedDocs).length
                return (
                  <button
                    disabled={!need || !!dlRun}
                    onClick={() => void batchDownload(selectedDocs)}
                    title={
                      need
                        ? `把选中的 ${need} 篇里本地还没有的 PDF 从云端下载下来`
                        : '选中的这些本地都已经有 PDF 了'
                    }
                  >
                    下载 PDF{need ? `（${need}）` : ''}
                  </button>
                )
              })()}
              <button
                onClick={() => setBatchEdit(true)}
                title="给选中的每一条统一加标签、改类型、设星标或已读"
              >
                改字段…
              </button>
              <span style={{ flex: 1 }} />
              <button onClick={() => setMulti([])}>取消选择</button>
            </div>
          )}
          {dlRun && (
            <div className="batch-bar">
              <span>
                正在下载 PDF {dlRun.done} / {dlRun.total}…
              </span>
              {/* which paper is the only honest answer to "is it stuck?": a
                  counter that has not moved for a minute looks exactly like a
                  hang, and a download that blocked the reader from doing
                  anything else while it ran would be the wrong trade */}
              <span style={{ flex: 1 }} />
              <button
                className="danger"
                style={{ padding: '2px 6px' }}
                title="停下。已经下载下来的会留着"
                onClick={() => {
                  dlStop.current = true
                }}
              >
                停止
              </button>
            </div>
          )}
          {batchMsg && <div className="pdf-msg">{batchMsg}</div>}
          {/*
            While there is something in the search box, the middle pane answers
            why each paper is on the list rather than just that it is.  A table
            can only say the second thing: the same fifty rows come back for a
            word in the title and for a word that appears once in the abstract,
            and the reader has to open them one at a time to tell which.

            The table is for comparing one column across many papers; these
            cards are for reading one paper at a time.  Both are wanted, so the
            query is what decides, and clearing the box gives the table back.
          */}
          {query.trim() ? (
            <SearchResults
              docs={filtered}
              query={query}
              noteMap={noteMap}
              fontSize={fontSize}
              multi={multi}
              selectedId={selId}
              empty={emptyState}
              onContextMenu={(d, e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, docId: d.id })
              }}
              onSelect={onRowSelect}
              onClearSelection={clearSelection}
            />
          ) : (
            <DocTable
              docs={filtered}
              fontSize={fontSize}
              cols={cols}
              colWidths={colWidths}
              onColWidth={setColWidth}
              onColMove={moveCol}
              sort={sort}
              onSort={sortBy}
              multi={multi}
              selectedId={selId}
              empty={emptyState}
              onContextMenu={(d, e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, docId: d.id })
              }}
              onToggleStar={(d) => {
                setFlags(d, { starred: !d.starred }).catch((e) =>
                  setErr('改星标失败：' + String(e))
                )
              }}
              onSelect={onRowSelect}
              onClearSelection={clearSelection}
            />
          )}
        </div>
        )}

        <Splitter
          onMove={dragRight}
          onReset={() => setRight(DEFAULT_RIGHT_PCT)}
          onNudge={(d) => setRight(rightPct - d / 10)}
          title="拖动改变阅读栏宽度，双击复位"
        />

        <div className="pane pane-right" style={{ flexBasis: `${rightPct}%` }}>
          <div className="pane-head">
            <button
              className={rightTab === 'details' ? 'primary' : ''}
              style={{ padding: '3px 10px', fontSize: '0.8rem' }}
              onClick={() => setRightTab('details')}
            >
              详情
            </button>
            <button
              className={rightTab === 'pdf' ? 'primary' : ''}
              style={{ padding: '3px 10px', fontSize: '0.8rem' }}
              onClick={() => setRightTab('pdf')}
            >
              PDF
            </button>
            <span className="grow" />
            {selected?.citation_key && (
              <span className="badge">{selected.citation_key}</span>
            )}
          </div>
          {!selected ? (
            <div className="empty">选中左侧一条文献查看详情或 PDF</div>
          ) : pinnedSelected && rightTab === 'details' ? (
            <TrashedDocPanel
              doc={selected}
              onRestore={() => void restoreTrashed(selected.id)}
              onPurge={() => void purgeTrashed(selected.id)}
              onOpenPdf={() => setRightTab('pdf')}
            />
          ) : rightTab === 'details' ? (
            <DetailsPanel
              doc={selected}
              folders={folders}
              onSaved={(d) =>
                setLib((l) =>
                  l ? { ...l, docs: l.docs.map((x) => (x.id === d.id ? d : x)) } : l
                )
              }
              onTrash={async () => {
                // the details pane is a quieter place to do this from than a
                // menu, which is exactly why it has to ask
                const go = await askConfirm({
                  title: '把这条文献移入回收站？',
                  body: `「${selected.title || '无标题'}」会移入回收站，可以在回收站里恢复。`,
                  ok: '移入回收站'
                })
                if (!go) return
                const r = await window.api.trashDoc(selected.id)
                if (!r.ok) {
                  setErr('移入回收站失败：云端没有确认，这条还在库里。')
                  return
                }
                setLib((l) => (l ? { ...l, docs: l.docs.filter((x) => x.id !== selected.id) } : l))
                setSelId(null)
              }}
              onNoteSaved={(id, text) =>
                setNoteMap((m) => {
                  const next = { ...m }
                  if (text) next[id] = text
                  else delete next[id]
                  return next
                })
              }
              onToggleFolder={async (fid, has) => {
                if (has) await window.api.removeFromFolder(fid, selected.id)
                else await window.api.addToFolder(fid, selected.id)
                setLib((l) =>
                  l
                    ? {
                        ...l,
                        docs: l.docs.map((x) =>
                          x.id === selected.id
                            ? {
                                ...x,
                                folder_uuids: has
                                  ? (x.folder_uuids ?? []).filter((f) => f !== fid)
                                  : [...(x.folder_uuids ?? []), fid]
                              }
                            : x
                        )
                      }
                    : l
                )
              }}
            />
          ) : (
            reader
          )}
        </div>
      </div>
      )}
      {settings && (
        <Settings
          theme={theme}
          fontSize={fontSize}
          pdfDir={pdfDir}
          nameTemplate={nameTemplate}
          citeStyle={citeStyle}
          syncOnStart={syncOnStart}
          syncPdfsOnSync={syncPdfsOnSync}
          ft={ftStat}
          ftPages={ftPages}
          version={version}
          focus={setSec}
          upd={upd}
          onCheckUpdate={() => void window.api.checkUpdate()}
          onDownloadUpdate={() => void window.api.downloadUpdate()}
          onInstallUpdate={() => void window.api.installUpdate()}
          onClose={() => {
            setSettings(false)
            setSetSec(null)
          }}
          onTheme={(t) => {
            setTheme(t)
            void writeConfig({ theme: t })
          }}
          onFont={(n) => bumpFont(n - fontSize)}
          onPickPdfDir={() => void pickDir()}
          onNameTemplate={() => {
            setSettings(false)
            askNameTemplate()
          }}
          onCiteStyle={(s) => {
            if (!isCiteStyle(s)) return
            setCiteStyle(s)
            void writeConfig({ citeStyle: s })
          }}
          onSyncOnStart={(v) => {
            setSyncOnStart(v)
            void writeConfig({ syncOnStart: v })
          }}
          onSyncPdfsOnSync={(v) => {
            setSyncPdfsOnSync(v)
            void writeConfig({ syncPdfsOnSync: v })
          }}
          onFtPages={(n) => void changeFtPages(n)}
        />
      )}
      {batchEdit && (
        <BatchEdit
          count={multi.length}
          onClose={() => setBatchEdit(false)}
          onApply={applyBatchEdit}
        />
      )}
      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          head={
            menuTargets(menu.docId).length > 1
              ? `${menuTargets(menu.docId).length} 条选中`
              : (docs.find((d) => d.id === menu.docId)?.title ?? '').slice(0, 40)
          }
          items={rowMenuItems(menu.docId)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

