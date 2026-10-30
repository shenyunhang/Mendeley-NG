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
import { DEFAULT_PDF_TEMPLATE } from '../shared/types'
import FolderTree from './components/FolderTree'
import TrashView from './components/TrashView'
import DupesView from './components/DupesView'
import ImportView from './components/ImportView'
import AddByIdView from './components/AddByIdView'
import AskDialog from './components/AskDialog'
import DocTable from './components/DocTable'
import ColumnPicker from './components/ColumnPicker'
import FullTextView from './components/FullTextView'
import { normaliseCols, type ColKey, type SortKey } from './lib/columns'
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
import { extractIds } from './lib/pdfmeta'
import { toBibtex, toEndnoteXml, toRis } from './lib/export'
import { buildTree } from './lib/tree'
import { findDuplicates, type DupeGroup } from './lib/dupes'
import { parseAny, type Entry } from './lib/import'


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

/** Toolbar wording for each updater phase; null means "say nothing". */
const UPD_TEXT: Record<UpdateState['phase'], ((s: UpdateState) => string) | null> = {
  idle: null,
  checking: () => '检查更新…',
  available: (s) => `发现新版本 ${s.version}，开始下载`,
  'not-available': () => '已是最新版本',
  downloading: (s) => `下载中 ${s.percent ?? 0}%`,
  downloaded: () => '安装并重启…',
  error: (s) => `更新失败：${s.message ?? '未知错误'}`,
  unsupported: (s) => s.message ?? '当前环境不支持更新'
}

/** Everything the search box looks at, in one lower-cased string.  Shared
 *  with saved searches so a saved filter matches exactly what it saved. */
function hay(d: Doc): string {
  return [
    d.title,
    d.source,
    d.citation_key,
    d.doi,
    (d.authors ?? []).map((a) => `${a.first_name ?? ''} ${a.last_name ?? ''}`).join(' ')
  ]
    .join(' ')
    .toLowerCase()
}

export default function App() {
  const [lib, setLib] = useState<Library | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderId, setFolderId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selId, setSelId] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: 'year',
    dir: -1
  })
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [rightTab, setRightTab] = useState<'pdf' | 'details'>('details')
  const [err, setErr] = useState<string | null>(null)
  const [upd, setUpd] = useState<UpdateState | null>(null)
  const [trash, setTrash] = useState<Doc[] | null>(null)
  const [dupes, setDupes] = useState<DupeGroup[] | null>(null)
  const [importing, setImporting] = useState<Entry[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [onlyStarred, setOnlyStarred] = useState(false)
  const [multi, setMulti] = useState<string[]>([])
  const lastIdx = useRef<number | null>(null)
  const [saved, setSaved] = useState<SavedSearch[]>([])
  const [activeSearch, setActiveSearch] = useState<string | null>(null)
  const [ask, setAsk] = useState<{
    title: string
    initial: string
    onOk: (v: string) => void
  } | null>(null)
  const [pdfDir, setPdfDir] = useState('')
  const [fontSize, setFontSize] = useState(15)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [cols, setCols] = useState<ColKey[]>(() => normaliseCols(undefined))
  const [views, setViews] = useState<SavedView[]>([])
  const [showCols, setShowCols] = useState(false)
  const [nameTemplate, setNameTemplate] = useState(DEFAULT_PDF_TEMPLATE)
  const [citeStyle, setCiteStyle] = useState<CiteStyle>(DEFAULT_CITE_STYLE)
  const [ftMode, setFtMode] = useState(false)
  const [ftQuery, setFtQuery] = useState('')
  const [ftHits, setFtHits] = useState<FtHit[]>([])
  const [ftStat, setFtStat] = useState<FtStatus | null>(null)
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
  const [undo, setUndo] = useState<UndoEntry[]>([])
  const searchRef = useRef<HTMLInputElement>(null)
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
    window.api.getConfig().then((c) => {
      setPdfDir(c.pdfDir)
      setSaved(c.savedSearches ?? [])
      setViews(c.views ?? [])
      setCols(normaliseCols(c.cols))
      if (c.pdfNameTemplate) setNameTemplate(c.pdfNameTemplate)
      if (isCiteStyle(c.citeStyle)) setCiteStyle(c.citeStyle)
      setTheme(c.theme === 'light' ? 'light' : 'dark')
      if (c.fontSize) {
        fontRef.current = c.fontSize
        setFontSize(c.fontSize)
      }
    })
    const off = window.api.onSyncStatus(setStatus)
    const offUpd = window.api.onUpdateState(setUpd)
    const offFt = window.api.onFtProgress(setFtStat)
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

  const fontRef = useRef(15)
  const bumpFont = useCallback((d: number) => {
    const next = Math.min(24, Math.max(11, fontRef.current + d))
    fontRef.current = next
    setFontSize(next)
    window.api.setConfig({ fontSize: next })
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // Arrow keys, Enter and Delete belong to the table only when nothing
      // else has claimed them: inside a search box, a note box or a rename box
      // they have to keep doing what they do there, and on a focused button
      // Enter is a click.
      const t = e.target as HTMLElement | null
      const claimed =
        !!t &&
        (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(t.tagName) ||
          !!t.isContentEditable)
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
  }, [bumpFont])

  /** `full` re-pulls the whole library.  Incremental is the default because a
   *  5.6k-document pull takes long enough to be annoying, but deletions are
   *  only visible to a full one, which is why that stays one click away. */
  const doSync = useCallback(async (full = false) => {
    setBusy(true)
    setErr(null)
    const r = await window.api.sync(full)
    if (r && 'error' in r) {
      setErr(r.error)
    } else if (r) {
      setLib({ docs: r.docs, folders: r.folders, syncedAt: new Date().toISOString() })
      setFolders(r.folders)
    }
    setBusy(false)
  }, [])

  const docs = lib?.docs ?? []

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let out = docs
    if (onlyStarred) out = out.filter((d) => d.starred)
    if (folderId) {
      const ids = new Set(tree.subtree.get(folderId) ?? [folderId])
      out = out.filter((d) => (d.folder_uuids ?? []).some((f) => ids.has(f)))
    }
    if (q) out = out.filter((d) => hay(d).includes(q))
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
    return [...out].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      if (x === y) return (a.title ?? '').localeCompare(b.title ?? '')
      return (x < y ? -1 : 1) * dir
    })
  }, [docs, folderId, query, sort, onlyStarred])

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
  }, [ftMode, ftQuery])

  const selected = useMemo(
    () => filtered.find((d) => d.id === selId) ?? null,
    [filtered, selId]
  )

  /** Saving a search captures the three things that shape the list: the text,
   *  the folder and the starred filter.  Sort order is deliberately not part
   *  of it — it is a view of the same rows, not part of the question. */
  const saveSearch = () => {
    const parts = [
      query.trim() ? `“${query.trim()}”` : '',
      folderId ? folders.find((f) => f.id === folderId)?.name ?? '' : '',
      onlyStarred ? '★' : ''
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
        starred: onlyStarred
      }
    ]
    setSaved(next)
    setActiveSearch(next[next.length - 1].id)
    window.api.setConfig({ savedSearches: next })
  }

  const applySearch = (s: SavedSearch) => {
    setQuery(s.query)
    setFolderId(s.folderId)
    setOnlyStarred(s.starred)
    setActiveSearch(s.id)
    setMulti([])
  }

  const deleteSearch = (id: string) => {
    const next = saved.filter((s) => s.id !== id)
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

  const deleteView = (id: string) => {
    const next = views.filter((v) => v.id !== id)
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
          if (q && !hay(d).includes(q)) return false
          return true
        }).length
      )
    }
    return m
  }, [saved, docs, tree])

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
        const go = confirm(
          `按新模板要改名 ${plan.total} 个本地 PDF。\n\n` +
            plan.sample.join('\n') +
            (plan.total > plan.sample.length ? `\n…还有 ${plan.total - plan.sample.length} 个` : '') +
            '\n\n现在就改？（同名的会跳过，不会覆盖）'
        )
        if (!go) return
        const r = await window.api.renamePdfs(next, true)
        await window.api.loadLibrary().then((res) => {
          if (res && !('error' in res) && res.docs) setLib(res)
        })
        setErr(r.renamed ? `已重命名 ${r.renamed} 个文件${r.skipped ? `，跳过 ${r.skipped} 个` : ''}` : null)
      }
    })
  }

  const batchFolder = async (folderId: string) => {
    const list = multi.length > 1 ? docs.filter((d) => multi.includes(d.id)) : []
    if (!list.length) return
    let n = 0
    for (const d of list) {
      if ((d.folder_uuids ?? []).includes(folderId)) continue
      try {
        await window.api.addToFolder(folderId, d.id)
        n++
      } catch {
        /* one failure should not abandon the rest of the batch */
      }
    }
    setLib((l) =>
      l
        ? {
            ...l,
            docs: l.docs.map((d) =>
              multi.includes(d.id) && !(d.folder_uuids ?? []).includes(folderId)
                ? { ...d, folder_uuids: [...(d.folder_uuids ?? []), folderId] }
                : d
            )
          }
        : l
    )
    setBatchMsg(`已把 ${n} 条加入文件夹`)
    const added = list.filter((d) => !(d.folder_uuids ?? []).includes(folderId)).map((d) => d.id)
    if (n) {
      pushUndo(`把 ${n} 条加入文件夹`, async () => {
        for (const id of added) await window.api.removeFromFolder(folderId, id).catch(() => {})
        setLib((l) =>
          l
            ? {
                ...l,
                docs: l.docs.map((d) =>
                  added.includes(d.id)
                    ? { ...d, folder_uuids: (d.folder_uuids ?? []).filter((f) => f !== folderId) }
                    : d
                )
              }
            : l
        )
      })
    }
    setTimeout(() => setBatchMsg(null), 2500)
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
    let n = 0
    for (let i = 0; i < list.length; i++) {
      setBatchMsg(`批量修改 ${i + 1}/${list.length}…`)
      try {
        await setFlags(list[i]!, patchFor(list[i]!))
        n++
      } catch {
        /* skip and keep going; the counter below reports the truth */
      }
    }
    setBatchMsg(`已修改 ${n} / ${list.length} 条`)
    setTimeout(() => setBatchMsg(null), 2500)
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
    if (!confirm(`把选中的 ${list.length} 条移入回收站？可在回收站里恢复。`)) return
    const gone = new Set(list.map((d) => d.id))
    let n = 0
    for (const d of list) {
      try {
        await window.api.trashDoc(d.id)
        n++
      } catch {
        /* keep going; the ones that failed stay in the library */
      }
    }
    setLib((l) => (l ? { ...l, docs: l.docs.filter((d) => !gone.has(d.id)) } : l))
    setMulti([])
    setSelId(null)
    setBatchMsg(`已移入回收站 ${n} 条`)
    if (n) {
      pushUndo(`删除 ${n} 条`, async () => {
        for (const d of list) await readmit(d)
      })
    }
    setTimeout(() => setBatchMsg(null), 2500)
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
      { sep: true },
      {
        label: `移入回收站${tail}`,
        danger: true,
        run: () => void trashDocs(list)
      }
    ]
  }

  const exportBib = () => download(toBibtex(target), 'library.bib')
  const exportRis = () => download(toRis(target), 'library.ris')
  const exportEndnote = () => download(toEndnoteXml(target), 'library.xml')

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
        const ids = await extractIds(await f.arrayBuffer())
        const doc = await window.api.importPdf(f.name, await f.arrayBuffer(), ids)
        setLib((l) => (l ? { ...l, docs: [...l.docs, doc] } : l))
      } catch (err) {
        setErr(String(err))
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
        <button onClick={exportBib} disabled={!filtered.length}>
          导出 BibTeX
        </button>
        <button onClick={exportRis} disabled={!filtered.length}>
          导出 RIS
        </button>
        <button onClick={exportEndnote} disabled={!filtered.length}>
          导出 EndNote
        </button>
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
            const r = await window.api.importToken()
            if (r?.ok) await doSync()
            else if (r) setErr(r.error ?? '导入失败')
          }}
          title="选择 get-token 生成的 token.json"
        >
          导入 token
        </button>
        <button
          disabled={!!upd && ['checking', 'downloading', 'downloaded'].includes(upd.phase)}
          onClick={async () => {
            // one click does the whole thing: check, download, install, relaunch.
            // download only makes sense when there is actually a newer version;
            // calling it anyway is what produced "Please check update first"
            const r = await window.api.checkUpdate()
            if (r?.unsupported || r?.error || !r?.available) return
            await window.api.downloadUpdate()
          }}
          title="从 GitHub Releases 拉取最新版本并自动安装重启"
        >

          {upd?.phase === 'downloading' ? `下载中 ${upd.percent ?? 0}%` : '检查更新'}
        </button>
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
        <button
          onClick={() => setDupes(findDuplicates(docs))}
          disabled={!docs.length}
          title="按 DOI / arXiv id / 标题找重复条目"
        >
          查重
        </button>
        <button
          onClick={() => void openNotes()}
          title="列出全部标注，跨所有文献，点一条直接翻到那一页"
        >
          全部标注
        </button>
        <button
          onClick={async () => {
            const list = await window.api.listTrash()
            setTrash(list)
          }}
          title="浏览回收站并恢复"
        >
          回收站
        </button>
        <button
          onClick={saveSearch}
          disabled={!query.trim() && !folderId && !onlyStarred}
          title="把当前的文件夹 + 搜索词 + 星标筛选存成一个虚拟文件夹"
        >
          保存搜索
        </button>
        <button
          onClick={doUndo}
          disabled={!undo.length}
          title={
            undo.length
              ? `撤销：${undo[undo.length - 1].label}  (Ctrl+Z)`
              : '没有可撤销的操作'
          }
        >
          撤销{undo.length ? `（${undo[undo.length - 1].label}）` : ''}
        </button>
        <button
          className={onlyStarred ? 'primary' : ''}
          onClick={() => setOnlyStarred((v) => !v)}
          title="只看星标"
          style={{ color: onlyStarred ? undefined : 'var(--star-on)' }}
        >
          ★
        </button>
        <div style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            className={showCols ? 'primary' : ''}
            onClick={() => setShowCols((v) => !v)}
            title="选择要显示哪些列、按什么顺序，并可以存成视图"
          >
            列
          </button>
          {showCols && (
            <ColumnPicker
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
          ref={searchRef}
          style={{ width: 320 }}
          placeholder={
            ftMode
              ? '搜索 PDF 正文（只索引每篇前几页）  (Ctrl+F)'
              : '搜索标题 / 作者 / 期刊 / citation key  (Ctrl+F)'
          }
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
            title={upd.message ?? ''}
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

      {err && <div className="err">同步失败：{err}　（可能需要导入 token.json）</div>}
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

      <div className="body">
        <div className="pane pane-left">
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
            onDrop={async (fid, did) => {
              await window.api.addToFolder(fid, did)
              setLib((l) =>
                l
                  ? {
                      ...l,
                      docs: l.docs.map((d) =>
                        d.id === did
                          ? { ...d, folder_uuids: [...(d.folder_uuids ?? []), fid] }
                          : d
                      )
                    }
                  : l
              )
            }}
            onRename={async (fid, name) => {
              const f = await window.api.patchFolder(fid, { name })
              setFolders((fs) => fs.map((x) => (x.id === fid ? f : x)))
              setLib((l) => (l ? { ...l, folders: l.folders.map((x) => (x.id === fid ? f : x)) } : l))
            }}
            onDelete={async (fid) => {
              const f = folders.find((x) => x.id === fid)
              const kids = (tree.subtree.get(fid) ?? [fid]).length - 1
              const msg = kids
                ? `删除文件夹「${f?.name}」及其 ${kids} 个子文件夹？其中的文献不会被删除。`
                : `删除文件夹「${f?.name}」？其中的文献不会被删除。`
              if (!confirm(msg)) return
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
            onBuild={(rebuild) => {
              window.api.ftBuild(rebuild).then(setFtStat)
            }}
            onClear={() => window.api.ftClear().then(setFtStat)}
            onOpen={(d, p) => {
              setSelId(d.id)
              setRightTab('pdf')
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
        ) : trash ? (
          <TrashView
            docs={trash}
            onClose={() => setTrash(null)}
            onRestore={async (id) => {
              await window.api.restoreDoc(id)
              setTrash((t) => (t ? t.filter((d) => d.id !== id) : t))
            }}
            onPurge={async (id) => {
              await window.api.purgeDoc(id)
              setTrash((t) => (t ? t.filter((d) => d.id !== id) : t))
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
              onClick={async () => {
                const p = await window.api.pickPdfDir()
                if (p) {
                  setPdfDir(p)
                  await doSync()
                }
              }}
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
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <button className="danger" onClick={batchTrash}>
                移入回收站
              </button>
              <button onClick={exportBib}>导出 BibTeX</button>
              <button onClick={exportRis}>导出 RIS</button>
              <button onClick={exportEndnote}>导出 EndNote</button>
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
          <DocTable
            docs={filtered}
            fontSize={fontSize}
            cols={cols}
            sort={sort}
            onSort={(k) =>
              setSort((s) =>
                s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: 1 }
              )
            }
            multi={multi}
            selectedId={selId}
            onContextMenu={(d, e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, docId: d.id })
            }}
            onToggleStar={(d) => {
              setFlags(d, { starred: !d.starred }).catch((e) => setErr(String(e)))
            }}
            onSelect={onRowSelect}
          />
        </div>
        )}

        <div className="pane pane-right">
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
                await window.api.trashDoc(selected.id)
                setLib((l) => (l ? { ...l, docs: l.docs.filter((x) => x.id !== selected.id) } : l))
                setSelId(null)
              }}
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
              onLocalPdf={(id, p) =>
                setLib((l) =>
                  l ? { ...l, docs: l.docs.map((x) => (x.id === id ? { ...x, localPdf: p } : x)) } : l
                )
              }
            />
          )}
        </div>
      </div>
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

function download(text: string, name: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
