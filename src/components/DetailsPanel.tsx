import { useEffect, useState } from 'react'
import type { Doc, Folder } from '../../shared/types'

interface Props {
  doc: Doc
  folders: Folder[]
  onSaved: (d: Doc) => void
  onToggleFolder: (folderId: string, has: boolean) => void
  onTrash?: () => void
}

const AUTHOR_SEP = '; '

function authorsToText(d: Doc): string {
  return (d.authors ?? [])
    .map((a) => [a.last_name, a.first_name].filter(Boolean).join(', '))
    .filter(Boolean)
    .join(AUTHOR_SEP)
}

function textToAuthors(s: string): { first_name?: string; last_name?: string }[] {
  return s
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (p.includes(',')) {
        const [last, first] = p.split(',').map((x) => x.trim())
        return { last_name: last, first_name: first }
      }
      const parts = p.split(/\s+/)
      return {
        last_name: parts[parts.length - 1],
        first_name: parts.slice(0, -1).join(' ')
      }
    })
}

export default function DetailsPanel({
  doc,
  folders,
  onSaved,
  onToggleFolder,
  onTrash
}: Props) {
  const [form, setForm] = useState({
    title: '',
    authors: '',
    year: '',
    source: '',
    citation_key: '',
    doi: '',
    abstract: ''
  })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    setForm({
      title: doc.title ?? '',
      authors: authorsToText(doc),
      year: doc.year != null ? String(doc.year) : '',
      source: doc.source ?? '',
      citation_key: doc.citation_key ?? '',
      doi: doc.doi ?? '',
      abstract: doc.abstract ?? ''
    })
    setMsg(null)
  }, [doc.id])

  const dirty =
    form.title !== (doc.title ?? '') ||
    form.authors !== authorsToText(doc) ||
    form.year !== (doc.year != null ? String(doc.year) : '') ||
    form.source !== (doc.source ?? '') ||
    form.citation_key !== (doc.citation_key ?? '') ||
    form.doi !== (doc.doi ?? '') ||
    form.abstract !== (doc.abstract ?? '')

  const save = async () => {
    setSaving(true)
    setMsg(null)
    const body: Record<string, unknown> = {
      title: form.title,
      authors: textToAuthors(form.authors),
      source: form.source,
      citation_key: form.citation_key
    }
    const y = parseInt(form.year, 10)
    body.year = Number.isFinite(y) ? y : null
    if (form.doi.trim()) body.doi = form.doi.trim()
    if (form.abstract.trim()) body.abstract = form.abstract.trim()
    try {
      const updated = await window.api.patchDoc(doc.id, body)
      onSaved({ ...doc, ...updated })
      setMsg('已保存到云端')
    } catch (e) {
      setMsg('保存失败：' + String(e))
    }
    setSaving(false)
  }

  const owned = new Set(doc.folder_uuids ?? [])

  return (
    <>
      <div className="details">
        <div className="field">
          <label>标题</label>
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <div className="field">
          <label>作者（姓, 名，分号分隔）</label>
          <input
            value={form.authors}
            onChange={(e) => setForm({ ...form, authors: e.target.value })}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field" style={{ flex: '0 0 90px' }}>
            <label>年份</label>
            <input
              value={form.year}
              onChange={(e) => setForm({ ...form, year: e.target.value })}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>发表处</label>
            <input
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>citation key</label>
            <input
              value={form.citation_key}
              onChange={(e) => setForm({ ...form, citation_key: e.target.value })}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>DOI</label>
            <input
              value={form.doi}
              onChange={(e) => setForm({ ...form, doi: e.target.value })}
            />
          </div>
        </div>
        <div className="field">
          <label>摘要</label>
          <textarea
            value={form.abstract}
            onChange={(e) => setForm({ ...form, abstract: e.target.value })}
          />
        </div>

        <div className="field">
          <label>文件夹归属（点击切换，会同步到云端）</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
            {folders
              .filter((f) => owned.has(f.id))
              .map((f) => (
                <button
                  key={f.id}
                  className="primary"
                  style={{ padding: '2px 8px', fontSize: 12 }}
                  onClick={() => onToggleFolder(f.id, true)}
                  title="点击移出"
                >
                  {f.name} ×
                </button>
              ))}
          </div>
          <select
            style={{ width: '100%', marginTop: 6 }}
            value=""
            onChange={(e) => {
              if (e.target.value) onToggleFolder(e.target.value, false)
            }}
          >
            <option value="">＋ 加入文件夹…</option>
            {folders
              .filter((f) => !owned.has(f.id))
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </div>

        <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 10 }}>
          id {doc.id}
          {doc.localPdf ? (
            <>
              <br />
              本地 PDF：{doc.localPdf}
            </>
          ) : null}
          {doc.doi ? (
            <>
              <br />
              <a
                href={'https://doi.org/' + doc.doi}
                onClick={(e) => {
                  e.preventDefault()
                  window.api.openExternal('https://doi.org/' + doc.doi)
                }}
                style={{ color: 'var(--accent)' }}
              >
                https://doi.org/{doc.doi}
              </a>
            </>
          ) : null}
        </div>
      </div>

      <div className="meta-actions">
        <button className="primary" onClick={save} disabled={!dirty || saving}>
          {saving ? '保存中…' : dirty ? '保存到云端' : '无改动'}
        </button>
        {msg && (
          <span style={{ fontSize: 12, color: msg.startsWith('已') ? 'var(--ok)' : '#ff8080' }}>
            {msg}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="danger"
          onClick={async () => {
            if (!confirm(`把「${doc.title || '这条文献'}」移入回收站？可在回收站里恢复。`)) return
            await onTrash?.()
          }}
          title="移入回收站，可在回收站恢复"
        >
          移入回收站
        </button>
      </div>
    </>
  )
}
