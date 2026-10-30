import { useState } from 'react'
import type { Doc, MetaCandidate } from '../../shared/types'

interface Props {
  docs: Doc[]
  onClose: () => void
  onAdded: (docs: Doc[]) => void
}

interface Found {
  query: string
  cands: MetaCandidate[]
  error?: string
}

/** Everything the paste box accepts.  A DOI, a doi.org link, an arXiv id, or
 *  a plain title; one per line. */
function splitQueries(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function alreadyHave(c: MetaCandidate, docs: Doc[]): boolean {
  const doi = c.patch.identifiers?.doi
  const arxiv = c.patch.identifiers?.arxiv
  const norm = (s: string) => s.trim().toLowerCase()
  if (doi) {
    const d = norm(doi)
    if (docs.some((x) => norm(x.identifiers?.doi ?? x.doi ?? '') === d)) return true
  }
  if (arxiv) {
    const a = norm(arxiv)
    if (docs.some((x) => norm(x.identifiers?.arxiv ?? x.arxiv ?? '') === a)) return true
  }
  const t = (c.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (t) {
    if (docs.some((x) => (x.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '') === t)) {
      return true
    }
  }
  return false
}

/**
 * "Add by identifier": paste a DOI or arXiv id and create the entry without
 * ever touching a PDF.  Mendeley Desktop had this behind the magic wand and it
 * is the fastest way to get a reading list in.
 *
 * Nothing is created until the user confirms, because a DOI resolves to
 * whatever the publisher last pushed and that is occasionally wrong.
 */
export default function AddByIdView({ docs, onClose, onAdded }: Props) {
  const [text, setText] = useState('')
  const [found, setFound] = useState<Found[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const key = (qi: number, ci: number) => `${qi}:${ci}`
  const toggle = (k: string) =>
    setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]))

  const resolve = async () => {
    const qs = splitQueries(text)
    if (!qs.length) return
    setBusy(true)
    setMsg(null)
    const out: Found[] = []
    const picks: string[] = []
    for (let i = 0; i < qs.length; i++) {
      try {
        const cands = await window.api.resolveIdentifier(qs[i])
        out.push({ query: qs[i], cands })
        // preselect the best non-duplicate candidate, so a single paste
        // followed by "add" does the obvious thing
        const first = cands.findIndex((c) => !alreadyHave(c, docs))
        if (first >= 0) picks.push(key(i, first))
      } catch (e) {
        out.push({ query: qs[i], cands: [], error: String(e) })
      }
    }
    setFound(out)
    setPicked(picks)
    setBusy(false)
  }

  const add = async () => {
    setBusy(true)
    const created: Doc[] = []
    let failed = 0
    for (const k of picked) {
      const [qi, ci] = k.split(':').map(Number)
      const c = found[qi]?.cands[ci]
      if (!c) continue
      try {
        // POST /documents rejects a body without `type`, and neither Crossref
        // nor arXiv always maps to one, so fall back to journal here rather
        // than letting the whole paste fail
        const body = { type: 'journal', ...c.patch }
        created.push(await window.api.createDoc(body))
      } catch {
        failed++
      }
    }
    setBusy(false)
    setMsg(`已添加 ${created.length} 条${failed ? `，失败 ${failed} 条` : ''}`)
    onAdded(created)
    setPicked([])
  }

  return (
    <div className="pane pane-mid">
      <div className="pane-head">
        <span>按标识符添加</span>
        <span className="grow" />
        {found.length > 0 && (
          <span style={{ color: 'var(--fg-dim)' }}>已选 {picked.length} 条</span>
        )}
        <button
          className="primary"
          style={{ padding: '2px 8px', fontSize: '0.733rem' }}
          disabled={busy || !picked.length}
          onClick={add}
        >
          {busy ? '添加中…' : '添加选中项'}
        </button>
        <button
          style={{ padding: '2px 6px', fontSize: '0.733rem' }}
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      <div className="cand-box">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={'每行一个：DOI、doi.org 链接、arXiv id 或标题\n10.1109/CVPR.2016.90\n1602.04938'}
        />
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <button className="primary" disabled={busy || !text.trim()} onClick={resolve}>
            {busy ? '查询中…' : '查询'}
          </button>
          <span style={{ color: 'var(--fg-dim)', fontSize: '0.733rem' }}>
            DOI 先查 Mendeley 自己的目录，再退到 Crossref
          </span>
        </div>
      </div>

      {msg && <div className="pdf-msg">{msg}</div>}

      <div className="folders">
        {found.map((f, qi) => (
          <div key={qi} className="dupe-group">
            <div className="dupe-head">
              <span className="t">{f.query}</span>
              <span className="grow" />
              <span className="badge">{f.cands.length} 条结果</span>
            </div>
            {f.error && <div className="err">{f.error}</div>}
            {!f.cands.length && !f.error && (
              <div className="empty" style={{ padding: '0.3rem 0.6rem' }}>
                没查到，试试直接粘贴标题
              </div>
            )}
            {f.cands.map((c, ci) => {
              const k = key(qi, ci)
              const dup = alreadyHave(c, docs)
              return (
                <label
                  key={ci}
                  className="cand-row"
                  style={dup ? { opacity: 0.45 } : undefined}
                >
                  <input
                    type="checkbox"
                    checked={picked.includes(k)}
                    disabled={busy}
                    onChange={() => toggle(k)}
                  />
                  <span className="t">{c.title}</span>
                  <span className="n">
                    {c.patch.authors?.[0]?.last_name ?? ''}
                    {c.patch.year ? ` ${c.patch.year}` : ''}
                    {c.patch.source ? ` · ${c.patch.source}` : ''}
                  </span>
                  <span className="badge">{c.from}</span>
                  {c.patch.type && <span className="badge">{c.patch.type}</span>}
                  {dup && <span className="badge">已在库中</span>}
                </label>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
