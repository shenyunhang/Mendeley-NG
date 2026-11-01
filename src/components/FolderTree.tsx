import { useEffect, useMemo, useState } from 'react'
import type { Folder, SavedSearch } from '../../shared/types'
import { buildTree, isSelfOrDescendant } from '../lib/tree'

interface Props {
  folders: Folder[]
  counts: Map<string, number>
  total: number
  selected: string | null
  /** named filters, stored locally; Mendeley has no server-side equivalent */
  saved?: SavedSearch[]
  savedCounts?: Map<string, number>
  activeSearch?: string | null
  onSelectSearch?: (s: SavedSearch) => void
  onDeleteSearch?: (id: string) => void
  onSelect: (id: string | null) => void
  /** documents dropped onto a folder.  A list, because what travels is the
   *  selection and not the row the drag started on. */
  onDrop?: (folderId: string, docIds: string[]) => void
  onRename?: (id: string, name: string) => void
  onDelete?: (id: string) => void
  /** a folder dropped onto another folder becomes its child */
  onMove?: (id: string, parentId: string | null) => void
  /**
   * Ask for the rename box on `id`.  Carries a counter rather than being a
   * plain id, because pressing F2 twice in a row has to be two requests: with
   * an id alone the second press would find the state unchanged and the box
   * would not come back after the first one was dismissed.
   */
  renameRequest?: { id: string; n: number } | null
}

/**
 * The documents a drag is carrying.  Several travel as one JSON list because
 * the gesture means the selection, not the row it started on; a single one is
 * still written under the old key, which older drop targets read.
 */
function draggedDocs(dt: DataTransfer): string[] {
  const many = dt.getData('text/doc-ids')
  if (many) {
    try {
      const ids: unknown = JSON.parse(many)
      if (Array.isArray(ids)) return ids.filter((x): x is string => typeof x === 'string')
    } catch {
      /* not our payload, or truncated; fall back to the single id */
    }
  }
  const one = dt.getData('text/doc-id')
  return one ? [one] : []
}

export default function FolderTree({
  folders,
  counts,
  total,
  selected,
  saved,
  savedCounts,
  activeSearch,
  onSelectSearch,
  onDeleteSearch,
  onSelect,
  onDrop,
  onRename,
  onDelete,
  onMove,
  renameRequest
}: Props) {
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const tree = useMemo(() => buildTree(folders), [folders])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out: { folder: Folder; depth: number }[] = []

    const visit = (f: Folder, depth: number) => {
      if (!q || f.name.toLowerCase().includes(q)) out.push({ folder: f, depth })
      // when filtering, children of a match still need to be reachable, so we
      // always descend even if the parent itself was filtered out
      const kids = tree.children.get(f.id) ?? []
      if (collapsed.has(f.id) && !q) return
      for (const c of kids) visit(c, depth + 1)
    }

    // the tree arrives in name order; sorting here by how many papers a
    // folder holds made the column readable and the positions unstable, so a
    // folder moved every time a paper did
    for (const r of tree.roots) visit(r, 0)
    return out
  }, [tree, filter, collapsed])

  // The request arrives from a key press handled somewhere else, so it is
  // answered here rather than in the event: the box belongs to a row and only
  // this component knows which row that is.  A folder currently filtered out
  // of the column is not offered for renaming either — there would be nowhere
  // to put the box, and a box that opens somewhere else is worse than none.
  useEffect(() => {
    if (!renameRequest) return
    const f = folders.find((x) => x.id === renameRequest.id)
    if (!f) return
    if (!rows.some((r) => r.folder.id === f.id)) return
    setDraft(f.name)
    setEditing(f.id)
    // `rows` is deliberately not a dependency: it is derived state, and
    // re-running this because the column changed would reopen the box over a
    // reader who had just closed it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest])

  const commitRename = (id: string) => {
    const name = draft.trim()
    setEditing(null)
    if (name) onRename?.(id, name)
  }

  return (
    <>
      <div style={{ padding: '6px 8px', flex: '0 0 auto' }}>
        <input
          style={{ width: '100%' }}
          placeholder="筛选文件夹"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="folders" onDragOver={(e) => e.preventDefault()}>
        <div
          className={'folder-row' + (selected === null ? ' sel' : '')}
          onClick={() => onSelect(null)}
        >
          <span className="name">全部文献</span>
          <span className="n">{total}</span>
        </div>

        {rows.map(({ folder: f, depth }) => {
          const kids = tree.children.get(f.id) ?? []
          const dragging = dragOver === f.id
          return (
            <div
              key={f.id}
              className={
                'folder-row' +
                (selected === f.id ? ' sel' : '') +
                (dragging ? ' drag' : '')
              }
              style={{ paddingLeft: 8 + depth * 14 }}
              // the gesture has no other affordance, and a reader who does not
              // know it is there will not discover it by accident
              title={`${f.name} · 可以把文献拖到这里`}
              onClick={() => onSelect(f.id)}
              draggable={editing !== f.id}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/folder-id', f.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              // dropping a folder here would nest it; dropping a document adds it
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(f.id)
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                const ids = draggedDocs(e.dataTransfer)
                const folderId = e.dataTransfer.getData('text/folder-id')
                if (ids.length) {
                  onDrop?.(f.id, ids)
                } else if (folderId && folderId !== f.id) {
                  // a folder cannot become a child of its own descendant
                  if (!isSelfOrDescendant(tree, folderId, f.id)) onMove?.(folderId, f.id)
                }
              }}
            >
              <span
                className="twisty"
                onClick={(e) => {
                  e.stopPropagation()
                  if (!kids.length) return
                  setCollapsed((s) => {
                    const n = new Set(s)
                    if (n.has(f.id)) n.delete(f.id)
                    else n.add(f.id)
                    return n
                  })
                }}
              >
                {kids.length ? (collapsed.has(f.id) ? '▸' : '▾') : ''}
              </span>

              {editing === f.id ? (
                <input
                  className="rename"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(f.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(f.id)
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="name">{f.name}</span>
              )}

              <span className="n">{counts.get(f.id) ?? 0}</span>

              <span className="acts">
                <button
                  className="mini"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDraft(f.name)
                    setEditing(f.id)
                  }}
                >
                  ✎
                </button>
                <button
                  className="mini"
                  title="删除文件夹（其中的文献不会被删）"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete?.(f.id)
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          )
        })}

        {saved?.length ? (
          <>
            <div className="group-head">保存的搜索</div>
            {saved.map((s) => (
              <div
                key={s.id}
                className={'folder-row' + (activeSearch === s.id ? ' sel' : '')}
                title={[s.query, s.starred ? '只看星标' : ''].filter(Boolean).join(' · ')}
                onClick={() => onSelectSearch?.(s)}
              >
                <span className="name">🔍 {s.name}</span>
                <span className="n">{savedCounts?.get(s.id) ?? 0}</span>
                <span className="acts">
                  <button
                    className="mini"
                    title="删除这个保存的搜索"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteSearch?.(s.id)
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </>
        ) : null}

        {!rows.length && <div className="empty">没有匹配的文件夹</div>}

        {/* dropping a folder on empty space moves it back to the top level */}
        <div
          className="drop-root"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const folderId = e.dataTransfer.getData('text/folder-id')
            if (folderId) onMove?.(folderId, null)
          }}
        />
      </div>
    </>
  )
}

