import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Doc, Folder, Library, SyncStatus, UpdateState } from '../shared/types'
import FolderTree from './components/FolderTree'
import TrashView from './components/TrashView'
import DupesView from './components/DupesView'
import ImportView from './components/ImportView'
import AddByIdView from './components/AddByIdView'
import DocTable from './components/DocTable'
import DetailsPanel from './components/DetailsPanel'
import PdfViewer from './components/PdfViewer'
import { extractIds } from './lib/pdfmeta'
import { toBibtex, toRis } from './lib/export'
import { buildTree } from './lib/tree'
import { findDuplicates, type DupeGroup } from './lib/dupes'
import { parseAny, type Entry } from './lib/import'

type SortKey = 'title' | 'authors' | 'year' | 'source' | 'citation_key'

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

  const doSync = useCallback(async () => {
    setBusy(true)
    setErr(null)
    const r = await window.api.sync(true)
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
    if (folderId) {
      const ids = new Set(tree.subtree.get(folderId) ?? [folderId])
      out = out.filter((d) => (d.folder_uuids ?? []).some((f) => ids.has(f)))
    }
    if (q) {
      out = out.filter((d) => {
        const hay = [
          d.title,
          d.source,
          d.citation_key,
          d.doi,
          (d.authors ?? []).map((a) => `${a.first_name ?? ''} ${a.last_name ?? ''}`).join(' ')
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
    }
    const { key, dir } = sort
    const val = (d: Doc): string | number => {
      if (key === 'authors') {
        const a = d.authors?.[0]
        return ((a?.last_name ?? '') + ' ' + (a?.first_name ?? '')).trim().toLowerCase()
      }
      if (key === 'title') return (d.title ?? '').toLowerCase()
      if (key === 'source') return (d.source ?? '').toLowerCase()
      if (key === 'citation_key') return (d.citation_key ?? '').toLowerCase()
      return d.year ?? 0
    }
    return [...out].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      if (x === y) return (a.title ?? '').localeCompare(b.title ?? '')
      return (x < y ? -1 : 1) * dir
    })
  }, [docs, folderId, query, sort])

  const selected = useMemo(
    () => filtered.find((d) => d.id === selId) ?? null,
    [filtered, selId]
  )

  const exportBib = () => {
    const list = selected ? [selected] : filtered
    download(toBibtex(list), 'library.bib')
  }
  const exportRis = () => {
    const list = selected ? [selected] : filtered
    download(toRis(list), 'library.ris')
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
        <button className="primary" onClick={doSync} disabled={busy}>
          {busy ? '同步中…' : '同步云端'}
        </button>
        <button onClick={exportBib} disabled={!filtered.length}>
          导出 BibTeX
        </button>
        <button onClick={exportRis} disabled={!filtered.length}>
          导出 RIS
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

      <div className="body">
        <div className="pane pane-left">
          <div className="pane-head">
            <span>文件夹</span>
            <span className="grow" />
            <button
              style={{ padding: '2px 6px', fontSize: '0.733rem' }}
              onClick={async () => {
                const n = prompt('新文件夹名称')
                if (!n) return
                const f = await window.api.createFolder(n)
                setFolders((fs) => [...fs, f])
              }}
            >
              +
            </button>
          </div>
          <FolderTree
            folders={folders}
            counts={folderCount}
            total={docs.length}
            selected={folderId}
            onSelect={setFolderId}
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
          <DocTable
            docs={filtered}
            fontSize={fontSize}
            sort={sort}
            onSort={(k) =>
              setSort((s) =>
                s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: 1 }
              )
            }
            selectedId={selId}
            onSelect={(d) => {
              setSelId(d.id)
              setRightTab(d.localPdf ? 'pdf' : 'details')
            }}
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
