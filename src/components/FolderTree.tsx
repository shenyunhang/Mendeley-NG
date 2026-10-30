import { useMemo, useState } from 'react'
import type { Folder } from '../../shared/types'

interface Props {
  folders: Folder[]
  counts: Map<string, number>
  total: number
  selected: string | null
  onSelect: (id: string | null) => void
  onDrop?: (folderId: string, docId: string) => void
}

export default function FolderTree({
  folders,
  counts,
  total,
  selected,
  onSelect,
  onDrop
}: Props) {
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return folders
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const ca = counts.get(a.id) ?? 0
        const cb = counts.get(b.id) ?? 0
        if (cb !== ca) return cb - ca
        return a.name.localeCompare(b.name)
      })
  }, [folders, counts, filter])

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
      <div
        className="folders"
        onDragOver={(e) => e.preventDefault()}
      >
        <div
          className={'folder-row' + (selected === null ? ' sel' : '')}
          onClick={() => onSelect(null)}
        >
          <span className="name">全部文献</span>
          <span className="n">{total}</span>
        </div>
        {rows.map((f) => (
          <div
            key={f.id}
            className={
              'folder-row' +
              (selected === f.id ? ' sel' : '') +
              (dragOver === f.id ? ' drag' : '')
            }
            title={f.name}
            onClick={() => onSelect(f.id)}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(f.id)
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(null)
              const did = e.dataTransfer.getData('text/doc-id')
              if (did) onDrop?.(f.id, did)
            }}
          >
            <span className="name">{f.name}</span>
            <span className="n">{counts.get(f.id) ?? 0}</span>
          </div>
        ))}
        {!rows.length && <div className="empty">没有匹配的文件夹</div>}
      </div>
    </>
  )
}
