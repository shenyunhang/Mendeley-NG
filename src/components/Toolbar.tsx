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
import { updateLine } from '../lib/updateText'

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
  /** Notes are exported separately: they are not on a `Doc`, no bibliography
   *  format carries them, and Mendeley has nowhere to keep a copy. */
  onExportNotes: () => void
  canExportNotes: boolean
  /** The same for highlights and their notes, which live in their own store
   *  and are the other half of what cannot be fetched again. */
  onExportAnnotations: () => void
  canExportAnnotations: boolean
  /** All of it at once, into one folder: the way out, as one action. */
  onLeave: () => void

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

  /** What is left here is what has no home of its own.  It used to hold eight
   *  items, four of which were only here because nothing had claimed them:
   *  adding by identifier is another way of importing, importing a token is
   *  what makes syncing possible, and checking for updates and opening the
   *  project page are both about this program rather than about the library.
   *  A menu called 更多 grows by admitting that a command had nowhere to go,
   *  so the four that did have somewhere went there. */
  const more: MenuItem[] = [
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
    }
  ]

  /** The two ways a paper arrives, under the word that already covers both.
   *  Adding by identifier used to sit two menus away from the button called
   *  导入文献 while being the same job without a file — and it is the one a
   *  reader who has no PDF yet needs first. */
  const imports: MenuItem[] = [
    {
      label: '导入文件…',
      title: '导入 BibTeX / RIS / EndNote XML',
      run: async () => {
        const files = await window.api.openRefFiles()
        const all: Entry[] = []
        for (const f of files) all.push(...parseAny(f.name, f.text))
        p.onImportRefs(all)
      }
    },
    {
      label: '按标识符添加…',
      title: '按 DOI / arXiv id / 标题添加条目，不需要 PDF',
      run: () => p.onView({ kind: 'add' })
    }
  ]

  /** The program itself: how it is set up, whether it is current, and where
   *  it lives.  These four were in 更多 for want of anywhere else, not because
   *  they belong beside 查重 and 回收站.  The settings panel already carries a
   *  同步 section and its own update button, which is exactly where somebody
   *  who has just found out that they have no token goes looking. */
  const setup: MenuItem[] = [
    {
      label: '设置…',
      title: '主题、字号、PDF 目录、命名模板、全文索引',
      run: () => p.onSettings()
    },
    {
      label: '导入 token…',
      title: '选择 get-token 生成的 token.json',
      run: () => {
        void window.api.importToken().then((r) => {
          if (r?.ok) return p.onSync(false)
          if (r) p.onErr('导入 token 失败：' + (r.error ?? '未选择文件'))
        })
      }
    },
    { sep: true },
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
        className={'reading-button' + (p.view.kind === 'reader' ? ' primary' : '')}
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
        title="忽略上次同步时间，重新拉全库；每次同步都会对账云端回收站"
      >
        全量
      </button>
      <MenuButton
        label="导出"
        title="把当前筛选结果写成 BibTeX / RIS / EndNote XML，或把写在这里的笔记与标注导出成 Markdown"
        disabled={!p.filtered.length}
        items={[
          { label: 'BibTeX', run: p.onExportBib },
          { label: 'RIS', run: p.onExportRis },
          { label: 'EndNote XML', run: p.onExportEndnote },
          {
            label: '笔记（Markdown）',
            disabled: !p.canExportNotes,
            // said out loud because the disabled state alone does not say why:
            // a note is the one thing here with no other copy, so the way out
            // has to exist, and has to be visible even when there is nothing
            // to carry
            title: p.canExportNotes
              ? '笔记只存在本机（Mendeley 没有 /notes 接口），这是把它们带走的方式'
              : '当前这些文献没有写笔记',
            run: p.onExportNotes
          },
          {
            label: '标注（Markdown）',
            disabled: !p.canExportAnnotations,
            title: p.canExportAnnotations
              ? '高亮与批注按篇分组导出，带页码和被划的那句话'
              : '当前这些文献没有任何标注',
            run: p.onExportAnnotations
          },
          { sep: true },
          {
            // named by what the reader is really asking: not "导出" but "can I
            // take all of this somewhere else".  The count is in the label
            // because "整个库" would be a lie when a folder is selected, and a
            // menu item that silently exports something else than it says is
            // worse than one that never offers it
            label:
              p.target.length === p.docs.length
                ? '带走整个库…'
                : `带走这 ${p.target.length} 篇…`,
            title:
              '书目（BibTeX + RIS + EndNote XML）、笔记、标注、PDF，一次写进一个文件夹，' +
              '附一份说明哪个文件是什么、哪两样别处 import 不了',
            run: p.onLeave
          }
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

      <MenuButton
        label="导入"
        title="把条目弄进库里：读一个书目文件，或按 DOI / arXiv id / 标题添加（不需要 PDF）"
        items={imports}
      />
      <MenuButton
        label="设置"
        title="主题、字号、PDF 目录、命名模板、全文索引；导入 token、检查更新与项目主页也在这里"
        items={setup}
      />
      <MenuButton label="更多" title="查重、全部标注、回收站、保存搜索" items={more} />
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
      {p.upd && updateLine(p.upd, p.upd.current ?? '') && (
        <span
          className="status"
          style={{ color: p.upd.phase === 'error' ? 'var(--err)' : 'var(--accent)' }}
          // the release notes are the interesting half when there is an
          // update; the two version numbers are already in the text
          title={p.upd.message ?? (p.upd.current ? `当前版本 ${p.upd.current}` : '')}
        >
          {updateLine(p.upd, p.upd.current ?? '')}
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
