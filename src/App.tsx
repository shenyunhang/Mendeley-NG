import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Doc,
  Folder,
  Library,
  SavedSearch,
  SyncStatus,
  UpdateState
} from '../shared/types'
import FolderTree from './components/FolderTree'
import TrashView from './components/TrashView'
import DupesView from './components/DupesView'
import ImportView from './components/ImportView'
import AddByIdView from './components/AddByIdView'
import AskDialog from './components/AskDialog'
import DocTable from './components/DocTable'
import DetailsPanel from './components/DetailsPanel'
import PdfViewer from './components/PdfViewer'
import { extractIds } from './lib/pdfmeta'
import { toBibtex, toEndnoteXml, toRis } from './lib/export'
import { buildTree } from './lib/tree'
import { findDuplicates, type DupeGroup } from './lib/dupes'
import { parseAny, type Entry } from './lib/import'

type SortKey = 'title' | 'authors' | 'year' | 'source' | 'citation_key' | 'starred'

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
  const searchRef = useRef<HTMLInputElement>(null)

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
      if (c.fontSize) {
        fontRef.current = c.fontSize
        setFontSize(c.fontSize)
      }
    })
    const off = window.api.onSyncStatus(setStatus)
    const offUpd = window.api.onUpdateState(setUpd)
    return () => {
      off()
      offUpd()
    }
  }, [])

  // one knob scales the whole UI, because every size in styles.css is in rem
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-fs', fontSize + 'px')
  }, [fontSize])

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
      return d.year ?? 0
    }
    return [...out].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      if (x === y) return (a.title ?? '').localeCompare(b.title ?? '')
      return (x < y ? -1 : 1) * dir
    })
  }, [docs, folderId, query, sort, onlyStarred])

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

  /** What an export or a batch action applies to: the multi-selection when
   *  there is one, else the single selected row, else the whole view. */
  const target = useMemo(() => {
    if (multi.length > 1) return docs.filter((d) => multi.includes(d.id))
    if (selected) return [selected]
    return filtered
  }, [multi, selected, filtered, docs])

  const [batchMsg, setBatchMsg] = useState<string | null>(null)

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
    setTimeout(() => setBatchMsg(null), 2500)
  }

  const batchTrash = async () => {
    const list = multi.length > 1 ? docs.filter((d) => multi.includes(d.id)) : []
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
    setTimeout(() => setBatchMsg(null), 2500)
  }

  /** Starred / read / tags.  These are per-user flags rather than metadata,
   *  so they are patched straight away instead of waiting for a save button. */
  const setFlags = useCallback(async (d: Doc, patch: Partial<Doc>) => {
    const updated = await window.api.patchDoc(d.id, patch as Record<string, unknown>)
    const merged = { ...d, ...updated }
    setLib((l) => (l ? { ...l, docs: l.docs.map((x) => (x.id === d.id ? merged : x)) } : l))
  }, [])

  const exportBib = () => download(toBibtex(target), 'library.bib')
  const exportRis = () => download(toRis(target), 'library.ris')
  const exportEndnote = () => download(toEndnoteXml(target), 'library.xml')

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
          className={onlyStarred ? 'primary' : ''}
          onClick={() => setOnlyStarred((v) => !v)}
          title="只看星标"
          style={{ color: onlyStarred ? undefined : '#ffd43b' }}
        >
          ★
        </button>
        <input
          ref={searchRef}
          style={{ width: 320 }}
          placeholder="搜索标题 / 作者 / 期刊 / citation key  (Ctrl+F)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="grow" />
        {upd && UPD_TEXT[upd.phase] && (
          <span
            className="status"
            style={{ color: upd.phase === 'error' ? '#ff8080' : 'var(--accent)' }}
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
              setDupes((prev) => (prev ? prev.filter((x) => x.key !== g.key) : prev))
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
              <span style={{ flex: 1 }} />
              <button onClick={() => setMulti([])}>取消选择</button>
            </div>
          )}
          {batchMsg && <div className="pdf-msg">{batchMsg}</div>}
          <DocTable
            docs={filtered}
            fontSize={fontSize}
            sort={sort}
            onSort={(k) =>
              setSort((s) =>
                s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: 1 }
              )
            }
            multi={multi}
            selectedId={selId}
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
              onLocalPdf={(id, p) =>
                setLib((l) =>
                  l ? { ...l, docs: l.docs.map((x) => (x.id === id ? { ...x, localPdf: p } : x)) } : l
                )
              }
            />
          )}
        </div>
      </div>
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
