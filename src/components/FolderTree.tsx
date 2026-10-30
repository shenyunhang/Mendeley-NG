import { useMemo, useState } from 'react'
import type { Folder } from '../../shared/types'
import { buildTree, isSelfOrDescendant, type Tree } from '../lib/tree'

interface Props {
  folders: Folder[]
  counts: Map<string, number>
  total: number
  selected: string | null
  onSelect: (id: string | null) => void
  /** a document dropped onto a folder */
  onDrop?: (folderId: string, docId: string) => void
  onRename?: (id: string, name: string) => void
  onDelete?: (id: string) => void
  /** a folder dropped onto another folder becomes its child */
  onMove?: (id: string, parentId: string | null) => void
}

export default function FolderTree({
  folders,
  counts,
  total,
  selected,
  onSelect,
  onDrop,
  onRename,
  onDelete,
  onMove
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

    const top = [...tree.roots].sort(byCountThenName(counts, tree))
    for (const r of top) visit(r, 0)
    return out
  }, [tree, counts, filter, collapsed])

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
              title={f.name}
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
                const docId = e.dataTransfer.getData('text/doc-id')
                const folderId = e.dataTransfer.getData('text/folder-id')
                if (docId) {
                  onDrop?.(f.id, docId)
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

function byCountThenName(counts: Map<string, number>, tree: Tree) {
  return (a: Folder, b: Folder) => {
    const ca = countSubtree(counts, tree, a.id)
    const cb = countSubtree(counts, tree, b.id)
    if (cb !== ca) return cb - ca
    return a.name.localeCompare(b.name)
  }
}

/** A parent folder shows its own documents plus everything in its children. */
function countSubtree(counts: Map<string, number>, tree: Tree, id: string) {
  const ids = tree.subtree.get(id) ?? [id]
  let n = 0
  for (const i of ids) n += counts.get(i) ?? 0
  return n
}
