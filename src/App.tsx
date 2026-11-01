import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Annotation,
  Doc,
  Folder,
  FtHit,
  FtStatus,
  Library,
  SavedSearch,
  SavedView,
  SyncStatus,
  UpdateState
} from '../shared/types'
import { DEFAULT_FT_PAGES, DEFAULT_PDF_TEMPLATE } from '../shared/types'
import FolderTree from './components/FolderTree'
import TrashView from './components/TrashView'
import DupesView from './components/DupesView'
import ImportView from './components/ImportView'
import AddByIdView from './components/AddByIdView'
import AskDialog from './components/AskDialog'
import ConfirmDialog from './components/ConfirmDialog'
import DocTable from './components/DocTable'
import SearchResults from './components/SearchResults'
import ColumnPicker from './components/ColumnPicker'
import FilterMenu from './components/FilterMenu'
import MenuButton from './components/MenuButton'
import FullTextView from './components/FullTextView'
import {
  DEFAULT_SORT,
  migrateCols,
  normaliseCols,
  normaliseSort,
  type ColKey,
  type SortKey
} from './lib/columns'
import {
  FILTER_LABEL,
  FILTER_TEST,
  LIST_FILTERS,
  type ListFilter
} from './lib/filters'
import {
  CITE_STYLES,
  DEFAULT_CITE_STYLE,
  formatCitation,
  isCiteStyle,
  type CiteStyle
} from './lib/cite'
import DetailsPanel from './components/DetailsPanel'
import PdfViewer from './components/PdfViewer'
import RowMenu, { type RowMenuItem } from './components/RowMenu'
import NotesView from './components/NotesView'
import BatchEdit, { type BatchOp } from './components/BatchEdit'
import Settings from './components/Settings'
import SetupGuide from './components/SetupGuide'
import Splitter from './components/Splitter'
import { extractIds } from './lib/pdfmeta'
import { toBibtex, toEndnoteXml, toRis } from './lib/export'
import { buildTree, byName } from './lib/tree'
import { findDuplicates, type DupeGroup } from './lib/dupes'
import { parseAny, type Entry } from './lib/import'


/**
 * How two titles are ordered when the sorted column cannot separate them.
 *
 * One collator for the life of the app, not `String.prototype.localeCompare`
 * per comparison: the latter builds a collator every time it is called, and
 * over a library of a few thousand papers a single sort reaches it tens of
 * thousands of times.  Same order, a great deal less work.
 */
const TITLE_ORDER = new Intl.Collator(undefined, { numeric: false, sensitivity: 'variant' })

/**
 * One step of undo.  `run` is a closure rather than a description of the
 * change, because the operations being undone are all cloud calls whose
 * inverse is another cloud call; there is no shared state to diff against.
 */
interface UndoEntry {
  id: string
  label: string
  run: () => Promise<void>
}

/**
 * Pane widths, and the room every pane is guaranteed.
 *
 * The list keeps at least `MID_MIN`: a table squeezed to a couple of columns
 * is worse than a reader that is a little narrower, and without a floor a
 * drag to the far right would leave the middle pane with nothing.
 */
const DEFAULT_LEFT_W = 240
const DEFAULT_RIGHT_PCT = 46
const LEFT_MIN = 140
const LEFT_MAX = 520
const RIGHT_MIN = 22
const RIGHT_MAX = 70
const MID_MIN = 260

const clampNum = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo

const clampLeft = (v: number) => Math.round(clampNum(v, LEFT_MIN, LEFT_MAX))
const clampRight = (v: number) =>
  Math.round(clampNum(v, RIGHT_MIN, RIGHT_MAX) * 10) / 10

/**
 * Toolbar wording for each updater phase; null means "say nothing".
 *
 * Every phase names the version that is running, and the ones that have a
 * version to offer name that too.  "已是最新版本" without a number answers a
 * question nobody asked — compared to what? — and a reader who was told a
 * build is fixed has no way to tell whether the number in front of them is
 * the fixed one or the one they reported.
 */
const UPD_TEXT: Record<UpdateState['phase'], ((s: UpdateState) => string) | null> = {
  idle: null,
  checking: (s) => (s.current ? `检查更新…（当前 ${s.current}）` : '检查更新…'),
  available: (s) =>
    s.current && s.version
      ? `新版本 ${s.version}（当前 ${s.current}），开始下载`
      : `发现新版本 ${s.version ?? ''}，开始下载`,
  // the answer to "am I on the fixed one?" is the number, not the adjective
  'not-available': (s) => (s.current ? `已是最新版本（当前 ${s.current}）` : '已是最新版本'),
  downloading: (s) =>
    s.version ? `下载 ${s.version} ${s.percent ?? 0}%` : `下载中 ${s.percent ?? 0}%`,
  downloaded: (s) =>
    s.version && s.current
      ? `${s.version} 已就绪（当前 ${s.current}），重启安装`
      : s.version
        ? `${s.version} 已就绪，重启安装`
        : '安装并重启…',
  error: (s) => `更新失败：${s.message ?? '未知错误'}`,
  unsupported: (s) => s.message ?? '当前环境不支持更新'
}

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
  const [lib, setLib] = useState<Library | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderId, setFolderId] = useState<string | null>(null)
  /**
   * F2 asks for the rename box on the selected folder.  The counter is what
   * makes a second press a second request: with the id alone, pressing F2
   * again after dismissing the box would leave the state unchanged and the
   * box would not come back.
   */
  const [renameReq, setRenameReq] = useState<{ id: string; n: number } | null>(null)
  const [query, setQuery] = useState('')
  const [selId, setSelId] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>(DEFAULT_SORT)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [rightTab, setRightTab] = useState<'pdf' | 'details'>('details')
  const [err, setErr] = useState<string | null>(null)
  const [upd, setUpd] = useState<UpdateState | null>(null)
  const [trash, setTrash] = useState<Doc[] | null>(null)
  const [dupes, setDupes] = useState<DupeGroup[] | null>(null)
  const [importing, setImporting] = useState<Entry[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [filters, setFilters] = useState<ListFilter[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const toggleFilter = (k: ListFilter) =>
    setFilters((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]))
  const [multi, setMulti] = useState<string[]>([])
  const lastIdx = useRef<number | null>(null)
  const [saved, setSaved] = useState<SavedSearch[]>([])
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
    resolve: (v: boolean) => void
  } | null>(null)
  const askConfirm = useCallback(
    (req: { title: string; body?: string; ok?: string }) =>
      new Promise<boolean>((resolve) => setConfirm({ ...req, resolve })),
    []
  )
  const [pdfDir, setPdfDir] = useState('')
  /**
   * Whether a token has been found yet, or `null` while that is still being
   * asked.  Null is not the same as false: answering "no token" before the
   * question has come back would flash the guide at everyone on startup.
   */
  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [setupDone, setSetupDone] = useState(false)
  const [fontSize, setFontSize] = useState(15)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [cols, setCols] = useState<ColKey[]>(() => migrateCols(undefined))
  // widths the reader has dragged to; empty until something is dragged, so a
  // column that was never touched keeps the track its definition gives it
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [views, setViews] = useState<SavedView[]>([])
  const [showCols, setShowCols] = useState(false)
  const [nameTemplate, setNameTemplate] = useState(DEFAULT_PDF_TEMPLATE)
  const [citeStyle, setCiteStyle] = useState<CiteStyle>(DEFAULT_CITE_STYLE)
  const [ftMode, setFtMode] = useState(false)
  const [ftQuery, setFtQuery] = useState('')
  const [ftHits, setFtHits] = useState<FtHit[]>([])
  const [ftStat, setFtStat] = useState<FtStatus | null>(null)
  /**
   * Bumped whenever the corpus finishes changing, so that a search which came
   * back empty gets asked again.
   *
   * A search is only run when the words change, so building the index after
   * searching leaves the old answer on the screen: "正文里没找到" stays there
   * over a library that has since been read in full, and the reader is left
   * to conclude that the word is not in their papers.  The words did not
   * change, so only the index finishing can be what prompts the second look.
   */
  const [ftEpoch, setFtEpoch] = useState(0)
  const ftWasBuilding = useRef(false)
  /** Page to open the reader at.  The nonce re-triggers a jump to the same
   *  page on the same document, which a bare number could not. */
  const [jump, setJump] = useState<{ page: number; nonce: number } | null>(null)
  /** The open row menu, positioned where the right click landed. */
  const [menu, setMenu] = useState<{ x: number; y: number; docId: string } | null>(null)
  /** Every annotation in the store, for the cross-document list.  Loaded when
   *  the list is opened rather than kept in step: annotations are written by
   *  the reader, and a copy that goes stale would silently hide new ones. */
  const [allAnns, setAllAnns] = useState<Annotation[] | null>(null)
  const [batchEdit, setBatchEdit] = useState(false)
  const [settings, setSettings] = useState(false)
  const [version, setVersion] = useState('')
  const [ftPages, setFtPages] = useState(DEFAULT_FT_PAGES)
  /**
   * Pane widths.  The folder tree is a fixed width, because a tree does not
   * get wider when the window does; the reader is a share of the window,
   * because that is exactly what it should follow.  Both are remembered.
   */
  const [leftW, setLeftW] = useState(DEFAULT_LEFT_W)
  const [rightPct, setRightPct] = useState(DEFAULT_RIGHT_PCT)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [undo, setUndo] = useState<UndoEntry[]>([])
  /** Local notes, kept here only so the search box can look inside them.
   *  They are written by the details panel, which reports back after saving. */
  const [noteMap, setNoteMap] = useState<Record<string, string>>({})
  const searchRef = useRef<HTMLInputElement>(null)
  // The two cards that hang off the bar are placed against these, not against
  // their own parents: the bar may scroll sideways, and a box that scrolls on
  // one axis clips on the other.
  const filterBtn = useRef<HTMLButtonElement>(null)
  const colsBtn = useRef<HTMLButtonElement>(null)
  // the keydown listener is installed once, so it has to reach the undo stack
  // through a ref rather than closing over a stale one
  const undoRef = useRef<() => void>(() => {})
  /** Same reason, for the table navigation: the listener outlives every
   *  change to the filtered list it has to walk. */
  const navRef = useRef<{
    step: (d: number) => void
    edge: (end: boolean) => void
    open: () => void
    del: () => void
  }>({ step: () => {}, edge: () => {}, open: () => {}, del: () => {} })

  useEffect(() => {
    window.api.loadLibrary().then((r) => {
      if (r && !('error' in r) && r.docs) {
        setLib(r)
        setFolders(r.folders ?? [])
      }
    })
    window.api.appVersion().then(setVersion).catch(() => {})
    window.api.hasToken().then(setHasToken).catch(() => setHasToken(false))
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
      if (typeof c.ftPages === 'number' && c.ftPages > 0) setFtPages(c.ftPages)
      if (typeof c.paneLeft === 'number') setLeftW(clampLeft(c.paneLeft))
      if (typeof c.paneRight === 'number') setRightPct(clampRight(c.paneRight))
      setTheme(c.theme === 'light' ? 'light' : 'dark')
      if (c.fontSize) {
        fontRef.current = c.fontSize
        setFontSize(c.fontSize)
      }
    })
    window.api.loadNotes().then((n) => setNoteMap(n ?? {})).catch(() => {})
    const off = window.api.onSyncStatus(setStatus)
    const offUpd = window.api.onUpdateState(setUpd)
    // Progress arriving with `building` turned off is the run having ended;
    // the edge, rather than every update, because a build reports progress
    // once per paper and a search is not wanted a thousand times over.
    const offFt = window.api.onFtProgress((s) => {
      setFtStat(s)
      if (ftWasBuilding.current && !s.building) setFtEpoch((e) => e + 1)
      ftWasBuilding.current = !!s.building
    })
    return () => {
      off()
      offUpd()
      offFt()
    }
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

  // the point of the feature: no second click. once the installer is on disk we
  // quit and let it run, and it relaunches the app when it finishes
  useEffect(() => {
    if (upd?.phase !== 'downloaded') return
    const t = setTimeout(() => window.api.installUpdate(), 700)
    return () => clearTimeout(t)
  }, [upd?.phase])

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
    }, 4000)
    return () => clearTimeout(t)
  }, [])

  const fontRef = useRef(15)
  const bumpFont = useCallback((d: number) => {
    const next = Math.min(24, Math.max(11, fontRef.current + d))
    fontRef.current = next
    setFontSize(next)
    window.api.setConfig({ fontSize: next })
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
          return
        }
        if (showCols) {
          e.preventDefault()
          setShowCols(false)
          return
        }
        if (showFilters) {
          e.preventDefault()
          setShowFilters(false)
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
  }, [bumpFont, settings, showCols, showFilters, folderId])

  /** `full` re-pulls the whole library.  Incremental is the default because a
   *  5.6k-document pull takes long enough to be annoying, but deletions are
   *  only visible to a full one, which is why that stays one click away. */
  const doSync = useCallback(async (full = false) => {
    setBusy(true)
    setErr(null)
    const r = await window.api.sync(full)
    if (r && 'error' in r) {
      // the banner no longer says "sync failed" on every message, so the one
      // that is about syncing has to say so itself
      setErr('同步失败：' + r.error + '　（可能需要导入 token.json）')
    } else if (r) {
      setLib({ docs: r.docs, folders: r.folders, syncedAt: new Date().toISOString() })
      setFolders(r.folders)
    }
    setBusy(false)
  }, [])

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
    const val = (d: Doc): string | number => {
      if (key === 'authors') {
        const a = d.authors?.[0]
        return ((a?.last_name ?? '') + ' ' + (a?.first_name ?? '')).trim().toLowerCase()
      }
      if (key === 'title') return (d.title ?? '').toLowerCase()
      if (key === 'source') return (d.source ?? '').toLowerCase()
      if (key === 'citation_key') return (d.citation_key ?? '').toLowerCase()
      if (key === 'starred') return d.starred ? 1 : 0
      // ISO strings compare correctly as strings, and a missing date sorting
      // first is the least surprising place for it
      if (key === 'created') return d.created ?? ''
      return d.year ?? 0
    }
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

  // Full-text search runs in the main process against the whole corpus, so it
  // is debounced: typing a word should not start one scan per keystroke.
  useEffect(() => {
    if (!ftMode) return
    const q = ftQuery.trim()
    if (q.length < 2) {
      setFtHits([])
      return
    }
    const t = setTimeout(() => {
      window.api.ftSearch(q).then(setFtHits).catch(() => setFtHits([]))
    }, 250)
    return () => clearTimeout(t)
  }, [ftMode, ftQuery, ftEpoch])

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
    () => filtered.find((d) => d.id === selId) ?? docs.find((d) => d.id === selId) ?? null,
    [filtered, docs, selId]
  )

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
        starred: filters.includes('star')
      }
    ]
    setSaved(next)
    setActiveSearch(next[next.length - 1].id)
    window.api.setConfig({ savedSearches: next })
  }

  const applySearch = (s: SavedSearch) => {
    setQuery(s.query)
    setFolderId(s.folderId)
    setFilters(s.starred ? ['star'] : [])
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
    window.api.setConfig({ savedSearches: next })
  }

  /** A view is the column layout and nothing else: saving one must not quietly
   *  change which rows are on screen, which is what folding the sort or the
   *  filter into it would do. */
  const changeCols = (next: ColKey[]) => {
    setCols(next)
    window.api.setConfig({ cols: next })
  }

  /**
   * A press on a column header is a request about how to read the list, and
   * it is written through: finding the order reset to newest-first on
   * Monday after pressing a header twice on Friday is the kind of small
   * betrayal that makes a tool feel like it is not listening.  Pressing the
   * same header again flips the direction rather than starting over, which
   * is the only reason a second press is ever needed.
   */
  const sortBy = (k: SortKey) => {
    const next: { key: SortKey; dir: 1 | -1 } =
      sort.key === k ? { key: k, dir: (sort.dir * -1) as 1 | -1 } : { key: k, dir: 1 }
    setSort(next)
    window.api.setConfig({ sort: next })
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
  const widthsTouched = useRef(false)
  useEffect(() => {
    // the first run is the mount, not a change
    if (!widthsTouched.current) {
      widthsTouched.current = true
      return
    }
    const t = setTimeout(() => {
      void window.api.setConfig({ colWidths })
    }, 400)
    return () => clearTimeout(t)
  }, [colWidths])

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
        window.api.setConfig({ views: next })
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
    window.api.setConfig({ views: next })
  }

  const savedCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of saved) {
      const q = s.query.trim().toLowerCase()
      const ids = s.folderId ? new Set(tree.subtree.get(s.folderId) ?? [s.folderId]) : null
      m.set(
        s.id,
        docs.filter((d) => {
          if (s.starred && !d.starred) return false
          if (ids && !(d.folder_uuids ?? []).some((f) => ids.has(f))) return false
          if (q && !(haystack.get(d.id) ?? '').includes(q)) return false
          return true
        }).length
      )
    }
    return m
  }, [saved, docs, tree, haystack])

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
    if (mod.shift && lastIdx.current != null) {
      const a = Math.min(lastIdx.current, index)
      const b = Math.max(lastIdx.current, index)
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
    const next = Math.min(filtered.length - 1, Math.max(0, from + delta))
    if (next === cur) return
    selectOnly(next)
  }

  /** What an export or a batch action applies to: the multi-selection when
   *  there is one, else the single selected row, else the whole view. */
  const target = useMemo(() => {
    if (multi.length > 1) return docs.filter((d) => multi.includes(d.id))
    if (selected) return [selected]
    return filtered
  }, [multi, selected, filtered, docs])

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
      setBatchMsg(`${what} ${ok} 条`)
      setTimeout(() => setBatchMsg(null), 2500)
      return
    }
    setBatchMsg(`${what} ${ok} 条，${failed.length} 条失败`)
    setTimeout(() => setBatchMsg(null), 5000)
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
        {query.trim() && !ftMode ? (
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
  }, [docs.length, query, folderId, folders, filters, ftMode, ftStat, clearFilters])

  const [batchMsg, setBatchMsg] = useState<string | null>(null)

  /** Most recent last, capped: an undo stack that grows without bound is a
   *  memory leak dressed up as a feature. */
  const pushUndo = (label: string, run: () => Promise<void>) => {
    setUndo((s) =>
      [...s, { id: 'u' + Date.now().toString(36), label, run }].slice(-20)
    )
  }

  const doUndo = async () => {
    const top = undo[undo.length - 1]
    if (!top) return
    // pop first, so a failure cannot leave the same step to be retried
    // forever against a cloud that has already moved on
    setUndo((s) => s.slice(0, -1))
    try {
      await top.run()
    } catch (e) {
      setErr('撤销失败：' + String(e))
    }
  }
  undoRef.current = () => {
    void doUndo()
  }
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
  }

  /** The full-text page budget.  Written straight away: dropping the index is
   *  the point, and a setting that only takes effect after a restart reads as
   *  a setting that did nothing. */
  const changeFtPages = async (n: number) => {
    const next = Math.max(1, Math.min(50, Math.floor(n) || DEFAULT_FT_PAGES))
    setFtPages(next)
    await window.api.setConfig({ ftPages: next })
    setFtStat(await window.api.ftStatus())
  }

  /**
   * Dragging a pane edge.  Both are clamped against the same floor for the
   * middle pane, so neither drag can squeeze the document list out of
   * existence, and the clamp is recomputed from the live box because the
   * window can be resized between two drags.
   */
  const dragLeft = (x: number) => {
    const box = bodyRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return
    const rightPx = (box.width * rightPct) / 100
    const hi = Math.max(LEFT_MIN, Math.min(LEFT_MAX, box.width - rightPx - MID_MIN))
    setLeftW(Math.round(clampNum(x - box.left, LEFT_MIN, hi)))
  }

  const dragRight = (x: number) => {
    const box = bodyRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return
    // the right pane is a share of the window, so the drag is converted to a
    // percentage: the width the user chose then survives a resize
    const hi = ((box.width - leftW - MID_MIN) / box.width) * 100
    const pct = ((box.right - x) / box.width) * 100
    setRightPct(Math.round(clampNum(pct, RIGHT_MIN, Math.min(RIGHT_MAX, hi)) * 10) / 10)
  }

  /**
   * Remember the widths, but only once the drag has stopped.
   *
   * Saving from the drag's own "mouse up" instead of here is the obvious
   * version and it is wrong: that handler closes over the state of the render
   * it was created in, so releasing inside the same frame as the last move
   * saves the width from before the move.  Waiting on the state settles the
   * question, and the debounce means one write per drag rather than one per
   * frame, which is a hundred writes to a file nobody asked to touch.
   */
  const panesTouched = useRef(false)
  useEffect(() => {
    // the first run is the mount, not a change
    if (!panesTouched.current) {
      panesTouched.current = true
      return
    }
    const t = setTimeout(() => {
      void window.api.setConfig({ paneLeft: leftW, paneRight: rightPct })
    }, 400)
    return () => clearTimeout(t)
  }, [leftW, rightPct])

  const setLeft = (w: number) => {
    const next = clampLeft(w)
    setLeftW(next)
    void window.api.setConfig({ paneLeft: next })
  }
  const setRight = (p: number) => {
    const next = clampRight(p)
    setRightPct(next)
    void window.api.setConfig({ paneRight: next })
  }

  const askNameTemplate = () => {
    setAsk({
      title: 'PDF 文件名模板（可用 {title} {year} {authors} {journal} {key} {type} {doi}）',
      initial: nameTemplate,
      onOk: async (v) => {
        setAsk(null)
        const next = v.trim() || DEFAULT_PDF_TEMPLATE
        setNameTemplate(next)
        window.api.setConfig({ pdfNameTemplate: next })
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
          setBatchMsg(`已重命名 ${r.renamed} 个文件${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`)
          setTimeout(() => setBatchMsg(null), 3000)
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
      setBatchMsg(op === 'add' ? '这些文献已经在这个文件夹里' : '这些文献不在这个文件夹里')
      setTimeout(() => setBatchMsg(null), 2500)
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
      (done, total) => setBatchMsg(`正在${verb}文件夹 ${done}/${total}…`)
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
          if (op === 'add') await window.api.removeFromFolder(folderId, id).catch(() => {})
          else await window.api.addToFolder(folderId, id).catch(() => {})
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
      docs.filter((d) => multi.includes(d.id)),
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
      docs.filter((d) => multi.includes(d.id)),
      currentFolder.id,
      'remove'
    )
  }

  const batchTrash = () => trashDocs(docs.filter((d) => multi.includes(d.id)))

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
    const prev = list.map((d) => {
      const o: Record<string, unknown> = {}
      for (const k of keys) o[k] = d[k]
      return o
    })
    let n = 0
    for (const d of list) {
      try {
        await setFlags(d, patch)
        n++
      } catch {
        /* one failure should not abandon the rest of the batch */
      }
    }
    setBatchMsg(`${label} ${n} 条`)
    setTimeout(() => setBatchMsg(null), 2200)
    if (n) {
      pushUndo(`${label} ${n} 条`, async () => {
        await Promise.all(
          list.map((d, i) => window.api.patchDoc(d.id, prev[i]!).catch(() => null))
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
  const openNotes = async () => setAllAnns(await window.api.loadAnnotations())

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
    setAllAnns(next)
    // the cloud copy is deleted after the local one is safely written, and a
    // failure there leaves a stray cloud highlight rather than a lost local one
    if (gone?.remoteId) {
      await window.api.deleteRemoteAnnotation(gone.remoteId).catch(() => {})
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
    const list = docs.filter((d) => multi.includes(d.id))
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
      (done, total) => setBatchMsg(`批量修改 ${done}/${total}…`)
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
        await window.api.trashDoc(d.id)
      },
      (done, total) => setBatchMsg(`正在移入回收站 ${done}/${total}…`)
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
    if (multi.length > 1 && multi.includes(id)) {
      return docs.filter((d) => multi.includes(d.id))
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

  /**
   * Exports ask where the file should go instead of dropping it in the
   * downloads folder, where a second export would quietly arrive as
   * "library (1).bib".  The folder is remembered on the far side, so the next
   * export starts where the last one ended.  Cancelling is silent: the reader
   * changed their mind, nothing went wrong.
   */
  const exportAs = async (fmt: 'bib' | 'ris' | 'xml') => {
    const kind = fmt === 'bib' ? 'BibTeX' : fmt === 'ris' ? 'RIS' : 'EndNote XML'
    const text =
      fmt === 'bib' ? toBibtex(target) : fmt === 'ris' ? toRis(target) : toEndnoteXml(target)
    const r = await window.api.saveText(`library.${fmt}`, text, kind, fmt)
    if (r.error) setErr(`导出失败：${r.error}`)
    else if (r.path) {
      setBatchMsg(`已导出 ${target.length} 条到 ${r.path}`)
      setTimeout(() => setBatchMsg(null), 6000)
    }
  }
  const exportBib = () => void exportAs('bib')
  const exportRis = () => void exportAs('ris')
  const exportEndnote = () => void exportAs('xml')

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
    setBatchMsg(
      list.length > 1 ? `已复制 ${list.length} 条引文` : `已复制引文：${text.split('\n')[0]}`
    )
    setTimeout(() => setBatchMsg(null), 2400)
  }
  // the shortcut lives in a listener installed once, so it reads the current
  // selection through a ref instead of a stale closure
  const copyRef = useRef<(list?: Doc[]) => void>(() => {})
  copyRef.current = () => {
    void copyCitation(target)
  }

  const [dropping, setDropping] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.name.toLowerCase().endsWith('.pdf')
    )
    if (!files.length) return
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      setImportMsg(`导入 ${i + 1}/${files.length}：${f.name}`)
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
    setImportMsg(files.length > 1 ? `已导入 ${files.length} 篇` : '导入完成')
    setTimeout(() => setImportMsg(null), 2500)
  }

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
      <div className="toolbar">
        <button className="primary" onClick={() => doSync(false)} disabled={busy}>
          {busy ? '同步中…' : '同步云端'}
        </button>
        <button
          onClick={() => doSync(true)}
          disabled={busy}
          title="忽略上次同步时间，重新拉全库；也是发现云端删除的唯一办法"
        >
          全量
        </button>
        <MenuButton
          label="导出"
          title="把当前筛选结果写成 BibTeX / RIS / EndNote XML"
          disabled={!filtered.length}
          items={[
            { label: 'BibTeX', run: exportBib },
            { label: 'RIS', run: exportRis },
            { label: 'EndNote XML', run: exportEndnote }
          ]}
        />
        <span className="cite-box">
          <button
            onClick={() => copyCitation(target)}
            disabled={!target.length}
            title="把选中条目的格式化引文复制到剪贴板  (Ctrl+Shift+C)"
          >
            复制引文
          </button>
          <select
            value={citeStyle}
            onChange={(e) => {
              const s = e.target.value
              if (!isCiteStyle(s)) return
              setCiteStyle(s)
              void window.api.setConfig({ citeStyle: s })
            }}
            title="引文样式"
          >
            {CITE_STYLES.map((c) => (
              <option key={c.key} value={c.key} title={c.sample}>
                {c.label}
              </option>
            ))}
          </select>
        </span>


        <button
          onClick={async () => {
            const files = await window.api.openRefFiles()
            const all: Entry[] = []
            for (const f of files) all.push(...parseAny(f.name, f.text))
            setImporting(all)
          }}
          title="导入 BibTeX / RIS / EndNote XML"
        >
          导入文献
        </button>
        <button
          onClick={() => setAdding(true)}
          title="按 DOI / arXiv id / 标题添加条目，不需要 PDF"
        >
          按标识符添加
        </button>
        <button onClick={() => setSettings(true)} title="主题、字号、PDF 目录、命名模板、全文索引">
          设置
        </button>
        <MenuButton
          label="更多"
          primary={upd?.phase === 'available'}
          title="不常用的命令：导入 token、检查更新、查重、全部标注、回收站、保存搜索"
          items={[
            {
              label: '导入 token',
              title: '选择 get-token 生成的 token.json',
              run: () => {
                void window.api.importToken().then((r) => {
                  if (r?.ok) return doSync()
                  if (r) setErr('导入 token 失败：' + (r.error ?? '未选择文件'))
                })
              }
            },
            {
              label: upd?.phase === 'available' ? `更新到 ${upd.version}` : '检查更新',
              disabled: !!upd && ['checking', 'downloading', 'downloaded'].includes(upd.phase),
              title: upd?.current
                ? `当前 ${upd.current}。从 GitHub Releases 拉取最新版本并自动安装重启`
                : '从 GitHub Releases 拉取最新版本并自动安装重启',
              run: () => {
                void window.api.checkUpdate().then((r) => {
                  if (r?.unsupported || r?.error || !r?.available) return
                  void window.api.downloadUpdate()
                })
              }
            },
            {
              label: '查重',
              disabled: !docs.length,
              title: '按 DOI / arXiv id / 标题找重复条目',
              run: () => setDupes(findDuplicates(docs))
            },
            {
              label: '全部标注',
              title: '列出全部标注，跨所有文献，点一条直接翻到那一页',
              run: () => void openNotes()
            },
            {
              label: '回收站',
              title: '浏览回收站并恢复',
              run: () => {
                void window.api.listTrash().then(setTrash)
              }
            },
            {
              label: '保存搜索',
              disabled: !query.trim() && !folderId && !filters.length,
              title: '把当前的文件夹 + 搜索词 + 筛选存成一个虚拟文件夹',
              run: saveSearch
            }
          ]}
        />
        <button
          onClick={doUndo}
          disabled={!undo.length}
          title={
            undo.length
              ? `撤销：${undo[undo.length - 1].label}  (Ctrl+Z)`
              : '没有可撤销的操作'
          }
        >
          撤销
        </button>
        <div style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            ref={filterBtn}
            className={filters.length ? 'primary' : ''}
            onClick={() => setShowFilters((v) => !v)}
            title="按星标 / 未读 / 有没有 PDF / 归没归文件夹来收窄列表"
          >
            筛选{filters.length ? `（${filters.length}）` : ''}
          </button>
          {showFilters && (
            <FilterMenu
              anchor={filterBtn}
              on={filters}
              counts={filterCounts}
              onToggle={toggleFilter}
              onClear={() => setFilters([])}
              onClose={() => setShowFilters(false)}
            />
          )}
        </div>
        <div style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            ref={colsBtn}
            className={showCols ? 'primary' : ''}
            onClick={() => setShowCols((v) => !v)}
            title="选择要显示哪些列、按什么顺序，并可以存成视图"
          >
            列
          </button>
          {showCols && (
            <ColumnPicker
              anchor={colsBtn}
              cols={cols}
              onChange={changeCols}
              views={views}
              onSaveView={saveView}
              onApplyView={applyView}
              onDeleteView={deleteView}
              onClose={() => setShowCols(false)}
            />
          )}
        </div>
        <input
          className="search"
          ref={searchRef}
          placeholder={
            ftMode
              ? '搜索 PDF 正文（只索引每篇前几页）  (Ctrl+F)'
              : '搜索标题 / 作者 / 期刊 / 摘要 / 标签 / 笔记  (Ctrl+F)'
          }
          title="标题、作者、期刊、citation key、DOI、摘要、类型、关键词、标签，以及这篇上写的本地笔记"
          value={ftMode ? ftQuery : query}
          onChange={(e) => (ftMode ? setFtQuery(e.target.value) : setQuery(e.target.value))}
        />
        <button
          className={ftMode ? 'primary' : ''}
          onClick={async () => {
            const next = !ftMode
            setFtMode(next)
            if (next) {
              const s = await window.api.ftStatus()
              setFtStat(s)
              if (!ftQuery.trim()) setFtQuery(query.trim())
            }
          }}
          title="按 PDF 正文搜索，而不是只搜书目字段"
        >
          全文
        </button>
        <span className="grow" />
        {upd && UPD_TEXT[upd.phase] && (
          <span
            className="status"
            style={{ color: upd.phase === 'error' ? 'var(--err)' : 'var(--accent)' }}
            // the release notes are the interesting half when there is an
            // update; the two version numbers are already in the text
            title={upd.message ?? (upd.current ? `当前版本 ${upd.current}` : '')}
          >
            {UPD_TEXT[upd.phase]?.(upd)}
          </span>
        )}
        <button
          style={{ padding: '3px 9px' }}
          title="缩小界面字号"
          onClick={() => bumpFont(-1)}
        >
          A−
        </button>
        <span className="badge" title="界面字号（CSS px，系统缩放仍会再乘一次）">
          {fontSize}
        </span>
        <button
          style={{ padding: '3px 9px' }}
          title="放大界面字号"
          onClick={() => bumpFont(1)}
        >
          A+
        </button>
        <button
          style={{ padding: '3px 9px' }}
          title={theme === 'light' ? '切到深色' : '切到浅色'}
          onClick={() => {
            const next = theme === 'light' ? 'dark' : 'light'
            setTheme(next)
            window.api.setConfig({ theme: next })
          }}
        >
          {theme === 'light' ? '☀' : '☾'}
        </button>
        {status?.message && (
          <span className="status" title={status.message}>
            {status.message}
          </span>
        )}
        <span className="badge">{filtered.length} / {docs.length}</span>
      </div>

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

        {adding ? (
          <AddByIdView
            docs={docs}
            onClose={() => setAdding(false)}
            onAdded={(created) => {
              if (created.length) {
                setLib((l) => (l ? { ...l, docs: [...l.docs, ...created] } : l))
              }
            }}
          />
        ) : importing ? (
          <ImportView
            entries={importing}
            docs={docs}
            onClose={() => setImporting(null)}
            onImported={(created) => {
              if (created.length) {
                setLib((l) => (l ? { ...l, docs: [...l.docs, ...created] } : l))
              }
            }}
          />
        ) : ftMode ? (
          <FullTextView
            query={ftQuery}
            hits={ftHits}
            docs={docs}
            status={ftStat}
            onClose={() => setFtMode(false)}
            onBuild={async (rebuild) => {
              if (rebuild) {
                const go = await askConfirm({
                  title: '清空全文索引并从头重建？',
                  body: '会重新读取全部本地 PDF，几千篇要几分钟。中途可以停，已经读进去的会留着。',
                  ok: '重建'
                })
                if (!go) return
              }
              // The answer to `ftBuild` is the status the run starts with, not
              // the one it ends with, so the "was building" flag is set from
              // here as well as from the progress below: a run short enough
              // never to report progress still has to end the search's wait.
              window.api.ftBuild(rebuild).then((s) => {
                setFtStat(s)
                ftWasBuilding.current = !!s.building
              })
            }}
            onClear={async () => {
              const go = await askConfirm({
                title: '删除全文索引？',
                body: '搜索正文前需要重建一次。文献本身不受影响。',
                ok: '删除索引'
              })
              if (!go) return
              // the results go too: they are hits into text that is no longer
              // there, and leaving them up reads as a search that worked
              window.api.ftClear().then((s) => {
                setFtStat(s)
                setFtHits([])
              })
            }}
            onCancel={() => window.api.ftCancel().then(setFtStat)}
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
        ) : allAnns ? (
          <NotesView
            anns={allAnns}
            docs={docs}
            onClose={() => setAllAnns(null)}
            onOpen={(d, p) => {
              setAllAnns(null)
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
        ) : dupes ? (
          <DupesView
            groups={dupes}
            onClose={() => setDupes(null)}
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
              for (const o of others) await window.api.trashDoc(o.id)
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
              setDupes((p) => (p ? p.filter((x) => x.key !== g.key) : p))
              pushUndo(`合并 ${others.length} 条`, async () => {
                await revertFields(keeper.id, prev)
                for (const o of others) await readmit(o)
                setDupes((p) => (p ? [...p, g] : p))
              })
            }}
          />
        ) : setup ? (
          <SetupGuide
            step={setup}
            busy={busy}
            onImportToken={async () => {
              const r = await window.api.importToken()
              if (r?.ok) {
                setHasToken(true)
                await doSync()
              } else if (r) setErr('导入 token 失败：' + (r.error ?? '未选择文件'))
            }}
            onSync={() => void doSync(false)}
            onDismiss={() => setSetupDone(true)}
          />
        ) : trash ? (
          <TrashView
            docs={trash}
            onClose={() => setTrash(null)}
            onRestore={async (id) => {
              await window.api.restoreDoc(id)
              setTrash((t) => (t ? t.filter((d) => d.id !== id) : t))
            }}
            onPurge={async (id) => {
              const d = trash.find((x) => x.id === id)
              const go = await askConfirm({
                title: `彻底删除「${d?.title || '无标题'}」？`,
                body: '此操作不可恢复，云端那条记录也会一并删掉。',
                ok: '彻底删除'
              })
              if (!go) return
              await window.api.purgeDoc(id)
              setTrash((t) => (t ? t.filter((x) => x.id !== id) : t))
            }}
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
              <button onClick={() => copyCitation(docs.filter((d) => multi.includes(d.id)))}>
                复制引文
              </button>
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
                await window.api.trashDoc(selected.id)
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
            <PdfViewer
              doc={selected}
              jumpTo={jump}
              // the word in the search box, whichever of the two modes typed
              // it: a hit in the list is a claim about the paper, and the
              // paper is where it has to be checkable
              hitQuery={ftMode ? ftQuery : query}
              confirm={askConfirm}
              onLocalPdf={(id, p) =>
                setLib((l) =>
                  l ? { ...l, docs: l.docs.map((x) => (x.id === id ? { ...x, localPdf: p } : x)) } : l
                )
              }
            />
          )}
        </div>
      </div>
      {settings && (
        <Settings
          theme={theme}
          fontSize={fontSize}
          pdfDir={pdfDir}
          nameTemplate={nameTemplate}
          citeStyle={citeStyle}
          ft={ftStat}
          ftPages={ftPages}
          version={version}
          upd={upd}
          onCheckUpdate={() => void window.api.checkUpdate()}
          onDownloadUpdate={() => void window.api.downloadUpdate()}
          onInstallUpdate={() => void window.api.installUpdate()}
          onClose={() => setSettings(false)}
          onTheme={(t) => {
            setTheme(t)
            void window.api.setConfig({ theme: t })
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
            void window.api.setConfig({ citeStyle: s })
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

