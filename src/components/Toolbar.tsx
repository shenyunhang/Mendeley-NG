import { useRef, type RefObject } from 'react'
import {
  PROJECT_URL,
  type Doc,
  type FtStatus,
  type SavedView,
  type SyncStatus,
  type UpdateState
} from '../../shared/types'
import ColumnPicker from './ColumnPicker'
import FilterMenu from './FilterMenu'
import MenuButton, { type MenuItem } from './MenuButton'
import SortMenu from './SortMenu'
import { CITE_STYLES, isCiteStyle, type CiteStyle } from '../lib/cite'
import { findDuplicates } from '../lib/dupes'
import { parseAny, type Entry } from '../lib/import'
import type { ColKey, SortKey } from '../lib/columns'
import type { ListFilter } from '../lib/filters'
import { LIBRARY, type View } from '../lib/view'

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

interface Props {
  /** Focused by Ctrl+F from wherever the reader is typing. */
  searchRef: RefObject<HTMLInputElement>

  // Keeping: the only commands on this bar that need the network.
  busy: boolean
  onSync: (full: boolean) => void
  status: SyncStatus | null
  upd: UpdateState | null
  onSettings: () => void
  onImportRefs: (entries: Entry[]) => void
  onExportBib: () => void
  onExportRis: () => void
  onExportEndnote: () => void

  /**
   * Reading is one of the two things the program is for, so it has a button
   * on the bar.  It did not used to: find, outline and annotations all lived
   * inside the viewer, and the bar — which is how the program says what it
   * thinks it is for — had none of them.
   */
  canRead: boolean
  onRead: () => void

  // Getting things back out of the library.
  docs: Doc[]
  filtered: Doc[]
  target: Doc[]
  onCopyCitation: () => void
  citeStyle: CiteStyle
  onCiteStyle: (s: CiteStyle) => void

  // Finding.
  view: View
  onView: (v: View) => void
  query: string
  onQuery: (q: string) => void
  ftQuery: string
  onFtQuery: (q: string) => void
  /** End the search: empty the box and come back out of full-text mode.
   *  Folders and filters are not touched — they are not in this box. */
  onClearSearch: () => void
  onFtStatus: (s: FtStatus) => void
  filters: ListFilter[]
  filterCounts: Record<ListFilter, number>
  onToggleFilter: (k: ListFilter) => void
  onClearFilters: () => void
  // Which card is open stays with the window, not with this row.  Esc closes
  // one thing per press and in a fixed order — the sheet, then the columns,
  // then the sorting, then the filters, then the selection — and that order
  // is a property of the window: a row that dismissed its own card without
  // knowing what was stacked above it would close two layers on one key.
  showFilters: boolean
  onShowFilters: (v: boolean) => void
  showSort: boolean
  onShowSort: (v: boolean) => void
  showCols: boolean
  onShowCols: (v: boolean) => void
  sort: { key: SortKey; dir: 1 | -1 }
  onSort: (k: SortKey) => void
  cols: ColKey[]
  onCols: (c: ColKey[]) => void
  views: SavedView[]
  onSaveView: () => void
  onApplyView: (v: SavedView) => void
  onDeleteView: (id: string) => void

  // Incidental, and kept off the bar for that reason.
  onUndo: () => void
  undoLabel: string | null
  onNotes: () => void
  onTrash: () => void
  canSaveSearch: boolean
  onSaveSearch: () => void
  onErr: (m: string) => void

  // How it looks.
  fontSize: number
  onFont: (d: number) => void
  theme: 'dark' | 'light'
  onTheme: () => void
}

/**
 * The single row of commands across the top.
 *
 * It is its own component because it is a quarter of the window's markup and
 * because nothing below it needs to know a button was pressed.  Which of its
 * three cards is open is *not* its own state, for the reason given against
 * those props.
 *
 * Everything it acts on is handed to it as a callback.  That is a long list,
 * and it is long because a toolbar is nothing but ways to start something —
 * it is not passing state down only to have it passed back up.
 */
export default function Toolbar(p: Props) {
  const filterBtn = useRef<HTMLButtonElement>(null)
  const sortBtn = useRef<HTMLButtonElement>(null)
  const colsBtn = useRef<HTMLButtonElement>(null)

  const searching = p.view.kind === 'fulltext' ? p.ftQuery : p.query
  // In full-text mode the × is offered with an empty box too: what is being
  // left is the mode, and the way out of it used to be finding the same
  // toggle that got in.
  const showClear = p.view.kind === 'fulltext' || searching.length > 0

  const more: MenuItem[] = [
    {
      label: '导入 token',
      title: '选择 get-token 生成的 token.json',
      run: () => {
        void window.api.importToken().then((r) => {
          if (r?.ok) return p.onSync(false)
          if (r) p.onErr('导入 token 失败：' + (r.error ?? '未选择文件'))
        })
      }
    },
    {
      label: p.upd?.phase === 'available' ? `更新到 ${p.upd.version}` : '检查更新',
      disabled: !!p.upd && ['checking', 'downloading', 'downloaded'].includes(p.upd.phase),
      title: p.upd?.current
        ? `当前 ${p.upd.current}。从 GitHub Releases 拉取最新版本并自动安装重启`
        : '从 GitHub Releases 拉取最新版本并自动安装重启',
      run: () => {
        void window.api.checkUpdate().then((r) => {
          if (r?.unsupported || r?.error || !r?.available) return
          void window.api.downloadUpdate()
        })
      }
    },
    {
      label: '按标识符添加',
      title: '按 DOI / arXiv id / 标题添加条目，不需要 PDF',
      run: () => p.onView({ kind: 'add' })
    },
    {
      label: '查重',
      disabled: !p.docs.length,
      title: '按 DOI / arXiv id / 标题找重复条目',
      run: () => p.onView({ kind: 'dupes', groups: findDuplicates(p.docs) })
    },
    {
      label: '全部标注',
      title: '列出全部标注，跨所有文献，点一条直接翻到那一页',
      run: () => void p.onNotes()
    },
    {
      label: '回收站',
      title: '浏览回收站并恢复',
      run: () => void p.onTrash()
    },
    {
      label: '保存搜索',
      disabled: !p.canSaveSearch,
      title: '把当前的文件夹 + 搜索词 + 筛选存成一个虚拟文件夹',
      run: p.onSaveSearch
    },
    {
      // the ↗ is the whole warning: this one leaves the app, which none of
      // the others do, and a menu item that opens a browser without saying so
      // is a surprise rather than a convenience
      label: '项目主页 ↗',
      title: '在默认浏览器里打开 GitHub 仓库：说明、源码、更新日志',
      run: () => void window.api.openExternal(PROJECT_URL)
    }
  ]

  return (
    <div className="toolbar">
      {/* Reading comes first because it is what the library was gathered for.
          Syncing used to own this spot and the highlight that went with it,
          which put the only action in the program that needs the network at
          the front of the bar. */}
      <button
        className={p.view.kind === 'reader' ? 'primary' : ''}
        onClick={p.onRead}
        disabled={!p.canRead}
        title="把这篇 PDF 放到整个窗口里读（Esc 回到列表）"
      >
        阅读
      </button>
      <button onClick={() => p.onSync(false)} disabled={p.busy}>
        {p.busy ? '同步中…' : '同步云端'}
      </button>
      <button
        onClick={() => p.onSync(true)}
        disabled={p.busy}
        title="忽略上次同步时间，重新拉全库；也是发现云端删除的唯一办法"
      >
        全量
      </button>
      <MenuButton
        label="导出"
        title="把当前筛选结果写成 BibTeX / RIS / EndNote XML"
        disabled={!p.filtered.length}
        items={[
          { label: 'BibTeX', run: p.onExportBib },
          { label: 'RIS', run: p.onExportRis },
          { label: 'EndNote XML', run: p.onExportEndnote }
        ]}
      />
      <span className="cite-box">
        <button
          onClick={() => p.onCopyCitation()}
          disabled={!p.target.length}
          title="把选中条目的格式化引文复制到剪贴板  (Ctrl+Shift+C)"
        >
          复制引文
        </button>
        <select
          value={p.citeStyle}
          onChange={(e) => {
            const s = e.target.value
            if (!isCiteStyle(s)) return
            p.onCiteStyle(s)
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
          p.onImportRefs(all)
        }}
        title="导入 BibTeX / RIS / EndNote XML"
      >
        导入文献
      </button>
      <button onClick={() => p.onSettings()} title="主题、字号、PDF 目录、命名模板、全文索引">
        设置
      </button>
      <MenuButton
        label="更多"
        title="不常用的命令：导入 token、检查更新、按标识符添加、查重、全部标注、回收站、保存搜索、项目主页"
        items={more}
      />
      <button
        onClick={p.onUndo}
        disabled={!p.undoLabel}
        title={
          p.undoLabel ? `撤销：${p.undoLabel}  (Ctrl+Z)` : '没有可撤销的操作'
        }
      >
        撤销
      </button>
      <div style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          ref={filterBtn}
          className={p.filters.length ? 'primary' : ''}
          onClick={() => p.onShowFilters(!p.showFilters)}
          title="按星标 / 未读 / 有没有 PDF / 归没归文件夹来收窄列表"
        >
          筛选{p.filters.length ? `（${p.filters.length}）` : ''}
        </button>
        {p.showFilters && (
          <FilterMenu
            anchor={filterBtn}
            on={p.filters}
            counts={p.filterCounts}
            onToggle={p.onToggleFilter}
            onClear={p.onClearFilters}
            onClose={() => p.onShowFilters(false)}
          />
        )}
      </div>
      <div style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          ref={sortBtn}
          className={p.showSort ? 'primary' : ''}
          onClick={() => p.onShowSort(!p.showSort)}
          title="按哪个字段排，以及从哪一头开始读"
        >
          排序
        </button>
        {p.showSort && (
          <SortMenu
            anchor={sortBtn}
            sort={p.sort}
            onPick={p.onSort}
            onClose={() => p.onShowSort(false)}
          />
        )}
      </div>
      <div style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          ref={colsBtn}
          className={p.showCols ? 'primary' : ''}
          onClick={() => p.onShowCols(!p.showCols)}
          title="选择要显示哪些列、按什么顺序，并可以存成视图"
        >
          列
        </button>
        {p.showCols && (
          <ColumnPicker
            anchor={colsBtn}
            cols={p.cols}
            onChange={p.onCols}
            views={p.views}
            onSaveView={p.onSaveView}
            onApplyView={p.onApplyView}
            onDeleteView={p.onDeleteView}
            onClose={() => p.onShowCols(false)}
          />
        )}
      </div>
      {/* the box and its × are one flex item on purpose: two of them would add
          a gap of their own and push the buttons at the far end of the bar */}
      <div className="search-wrap">
        <input
          className="search"
          ref={p.searchRef}
          placeholder={
            p.view.kind === 'fulltext'
              ? '搜索 PDF 正文（只索引每篇前几页）  (Ctrl+F)'
              : '搜索标题 / 作者 / 期刊 / 摘要 / 标签 / 笔记  (Ctrl+F)'
          }
          title="标题、作者、期刊、citation key、DOI、摘要、类型、关键词、标签，以及这篇上写的本地笔记"
          value={p.view.kind === 'fulltext' ? p.ftQuery : p.query}
          onChange={(e) => (p.view.kind === 'fulltext' ? p.onFtQuery : p.onQuery)(e.target.value)}
          // room for the ×, so a long term does not run underneath it
          style={showClear ? { paddingRight: 24 } : undefined}
        />
        {showClear && (
          <button
            className="search-clear"
            title={p.view.kind === 'fulltext' ? '退出全文搜索，回到书目字段' : '清空搜索'}
            aria-label="清空搜索"
            onClick={p.onClearSearch}
          >
            ×
          </button>
        )}
      </div>
      <button
        className={p.view.kind === 'fulltext' ? 'primary' : ''}
        onClick={async () => {
          const next = p.view.kind !== 'fulltext'
          p.onView(next ? { kind: 'fulltext' } : LIBRARY)
          if (next) {
            const s = await window.api.ftStatus()
            p.onFtStatus(s)
            if (!p.ftQuery.trim()) p.onFtQuery(p.query.trim())
          }
        }}
        title="按 PDF 正文搜索，而不是只搜书目字段"
      >
        全文
      </button>
      <span className="grow" />
      {p.upd && UPD_TEXT[p.upd.phase] && (
        <span
          className="status"
          style={{ color: p.upd.phase === 'error' ? 'var(--err)' : 'var(--accent)' }}
          // the release notes are the interesting half when there is an
          // update; the two version numbers are already in the text
          title={p.upd.message ?? (p.upd.current ? `当前版本 ${p.upd.current}` : '')}
        >
          {UPD_TEXT[p.upd.phase]?.(p.upd)}
        </span>
      )}
      <button style={{ padding: '3px 9px' }} title="缩小界面字号" onClick={() => p.onFont(-1)}>
        A−
      </button>
      <span className="badge" title="界面字号（CSS px，系统缩放仍会再乘一次）">
        {p.fontSize}
      </span>
      <button style={{ padding: '3px 9px' }} title="放大界面字号" onClick={() => p.onFont(1)}>
        A+
      </button>
      <button
        style={{ padding: '3px 9px' }}
        title={p.theme === 'light' ? '切到深色' : '切到浅色'}
        onClick={() => p.onTheme()}
      >
        {p.theme === 'light' ? '☀' : '☾'}
      </button>
      {p.status?.message && (
        <span className="status" title={p.status.message}>
          {p.status.message}
        </span>
      )}
      <span className="badge">
        {p.filtered.length} / {p.docs.length}
      </span>
    </div>
  )
}
